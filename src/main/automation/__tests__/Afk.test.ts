import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Afk } from '../Afk';
import { CommandQueue } from '../CommandQueue';
import { t } from '../../app/i18n';
import { DEFAULT_CONFIG, type AfkConfig } from '../../../shared/config';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { Block } from '../../../shared/blocks';

const automation = DEFAULT_CONFIG.automation;
const MINUTE = 60_000;

let sent: string[];
let notices: string[];
let queue: CommandQueue;
let clock: number;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  clock = 1_700_000_000_000;
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const on: AfkConfig = { enabled: true, afterMinutes: 5, reply: '{AFK}' };

function make(config: AfkConfig = on, enabled = true): Afk {
  return new Afk(config, enabled, queue, { notice: (m) => notices.push(m) }, () => clock);
}

/** `<Name> telepaths: <message>` as the classifier frames it; no message is the sent receipt. */
function telepath(player: string, message?: string): Block {
  return {
    seq: 1,
    at: clock,
    terminator: 'newline',
    type: 'conversation-telepath',
    domain: 'conversation',
    groups: message === undefined ? { player } : { player, message },
    text: '',
    confidence: 1
  } as Block;
}

const state = (): CharacterState => ({ ...EMPTY_CHARACTER, phase: 'in-game', name: 'Vaelor' });

/** Runs the queue's pacing forward so whatever was proposed reaches `sent`. */
function drain(): void {
  vi.advanceTimersByTime(500);
}

describe('answering for an absent player', () => {
  it('stays quiet while the player has typed recently', () => {
    const afk = make();
    afk.noteAttended();
    clock += 2 * MINUTE;
    afk.onBlock(telepath('Rend', 'you there?'), state());
    drain();
    expect(sent).toEqual([]);
  });

  it('answers a telepath once nothing has been typed for the timeout, and says so', () => {
    const afk = make();
    afk.noteAttended();
    clock += 6 * MINUTE;
    afk.onBlock(telepath('Rend', 'you there?'), state());
    drain();
    expect(sent).toEqual(['/Rend {AFK}']);
    expect(notices).toContain(t('automation.afk.replied', { player: 'Rend' }));
  });

  /* A person who telepaths twice in a minute has been answered once. */
  it('tells each sender once per window, and another sender separately', () => {
    const afk = make();
    afk.noteAttended();
    clock += 6 * MINUTE;
    afk.onBlock(telepath('Rend', 'hello'), state());
    afk.onBlock(telepath('Rend', 'hello?'), state());
    afk.onBlock(telepath('Soul', 'party?'), state());
    drain();
    expect(sent).toEqual(['/Rend {AFK}', '/Soul {AFK}']);
    clock += DEFAULT_INTERNAL.tuning.afk.replyEveryMs;
    afk.onBlock(telepath('Rend', 'still there?'), state());
    drain();
    expect(sent).toEqual(['/Rend {AFK}', '/Soul {AFK}', '/Rend {AFK}']);
  });

  /* `@` is `Remotes`' business, and the sent receipt is not a question. */
  it('leaves @ commands to the remotes and the sent receipt alone', () => {
    const afk = make();
    afk.noteAttended();
    clock += 6 * MINUTE;
    afk.onBlock(telepath('Rend', '@health'), state());
    afk.onBlock(telepath('Rend'), state());
    drain();
    expect(sent).toEqual([]);
  });

  it('is present again the moment the player types', () => {
    const afk = make();
    afk.noteAttended();
    clock += 6 * MINUTE;
    expect(afk.away).toBe(true);
    afk.noteAttended();
    expect(afk.away).toBe(false);
    afk.onBlock(telepath('Rend', 'hi'), state());
    drain();
    expect(sent).toEqual([]);
  });

  /* Never before the realm: a character on the login screens has not been left. */
  it('is never away before anybody has entered the realm or typed', () => {
    const afk = make();
    clock += 60 * MINUTE;
    expect(afk.away).toBe(false);
  });

  it('does nothing while off, or under the master switch, or with a blank reply', () => {
    const cases = [make({ ...on, enabled: false }), make(on, false), make({ ...on, reply: '  ' })];
    for (const afk of cases) {
      afk.noteAttended();
      clock += 6 * MINUTE;
      afk.onBlock(telepath('Rend', 'hi'), state());
    }
    drain();
    expect(sent).toEqual([]);
  });
});
