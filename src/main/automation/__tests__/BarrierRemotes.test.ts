import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BarrierRemotes } from '../BarrierRemotes';
import type { Intent } from '../CommandQueue';
import { t } from '../../app/i18n';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { Block } from '../../../shared/blocks';
import type { Requirement } from '../../../shared/world';

const block = (type: string, groups: Record<string, string> = {}): Block =>
  ({ type, seq: 1, at: 0, domain: 'movement', groups }) as unknown as Block;

interface Character {
  traps?: number | null;
  picklocks?: number | null;
  strength?: number | null;
  hp?: number;
  requirement?: Partial<Requirement>;
  room?: number;
}

function state({
  traps = null,
  picklocks = null,
  strength = null,
  hp = 500,
  requirement = { kind: 'trap', damage: 100 },
  room = 7
}: Character = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    name: 'Rand',
    vitals: { ...base.vitals, hp, hpMax: 500 },
    progress: { ...base.progress, traps, picklocks, strength },
    room: {
      ...base.room,
      map: 1,
      number: room,
      exits: [
        {
          direction: 'ne',
          note: null,
          targetMap: 1,
          targetRoom: 8,
          targetName: null,
          requirement: { kind: 'door', raw: '', ...requirement } as Requirement
        }
      ]
    }
  };
}

let queued: Intent[];
let notices: string[];
let answers: string[];
let hands: BarrierRemotes;

beforeEach(() => {
  vi.useFakeTimers();
  queued = [];
  notices = [];
  answers = [];
  const config: AutomationConfig = { ...DEFAULT_CONFIG.automation, enabled: true };
  hands = new BarrierRemotes(
    config,
    { enqueue: (intent) => queued.push(intent) > 0 },
    { notice: (message) => notices.push(message) }
  );
});

afterEach(() => {
  hands.dispose();
  vi.useRealTimers();
});

const answer = (body: string): void => void answers.push(body);
/** The last try reaches the wire. */
const sendLast = (): void => queued.at(-1)!.onSent?.();

/* Todo 86: a leader's `@disarm`, `@pick` and `@bash`. */
describe('@disarm from the leader', () => {
  it('sends `disarm trap <dir>` and answers {ok} on the success line', () => {
    const here = state({ traps: 90 });
    hands.start('disarm', 'Vaelor', 'ne', here, answer);
    expect(queued.map((intent) => intent.command)).toEqual(['disarm trap ne']);
    sendLast();
    hands.onBlock(block('trap-disarmed', { direction: 'northeast' }), here);
    expect(answers).toEqual(['{ok}']);
  });

  it('counts a try with no success line by the deadline as failed, tries again, then gives up', () => {
    const here = state({ traps: 90 });
    hands.start('disarm', 'Vaelor', 'northeast', here, answer);
    // 90 Traps: two failures in a row is under 1%, so two tries.
    sendLast();
    vi.advanceTimersByTime(3_000);
    expect(queued).toHaveLength(2);
    sendLast();
    vi.advanceTimersByTime(3_000);
    expect(answers).toEqual(['{failed}']);
    expect(notices).toContain(
      t('automation.remotes.barrierGaveUp', {
        from: 'Vaelor',
        job: 'disarm',
        direction: 'northeast',
        count: 2
      })
    );
  });

  it('refuses a disarm whose trap would kill this character, and one with no Traps', () => {
    hands.start('disarm', 'Vaelor', 'ne', state({ traps: 90, hp: 80 }), answer);
    hands.start('disarm', 'Vaelor', 'ne', state({ traps: null }), answer);
    expect(queued).toEqual([]);
    expect(answers).toEqual(['{failed}', '{failed}']);
  });

  it('stops and answers {failed} when the character leaves the room', () => {
    hands.start('disarm', 'Vaelor', 'ne', state({ traps: 90 }), answer);
    hands.onCharacter(state({ traps: 90, room: 9 }));
    expect(answers).toEqual(['{failed}']);
  });
});

describe('@pick and @bash from the leader', () => {
  const lock = { kind: 'door', pickDifficulty: 20, bashDifficulty: 20 } as const;

  it('picks until the lock gives, and leaves the opening to the leader', () => {
    const here = state({ picklocks: 60, requirement: lock });
    hands.start('pick', 'Vaelor', 'ne', here, answer);
    sendLast();
    hands.onBlock(block('skill-failed'), here);
    expect(queued.map((intent) => intent.command)).toEqual(['pi ne', 'pi ne']);
    sendLast();
    hands.onBlock(block('door-changed', { state2: 'unlocked', barrier2: 'door' }), here);
    expect(answers).toEqual(['{ok}']);
    expect(queued).toHaveLength(2);
  });

  it('bashes, and refuses a door only a key opens', () => {
    const here = state({ strength: 80, requirement: lock });
    hands.start('bash', 'Vaelor', 'ne', here, answer);
    sendLast();
    hands.onBlock(block('door-changed', { state: 'open', barrier: 'door' }), here);
    expect(answers).toEqual(['{ok}']);
    hands.start(
      'bash',
      'Vaelor',
      'ne',
      state({ strength: 80, requirement: { kind: 'door', keyId: 12 } }),
      answer
    );
    expect(answers).toEqual(['{ok}', '{failed}']);
  });

  it('says nothing back to a call with no direction', () => {
    hands.start('pick', 'Vaelor', null, state({ picklocks: 60 }), answer);
    expect(answers).toEqual([]);
    expect(notices).toEqual([
      t('automation.remotes.barrierNoWay', { from: 'Vaelor', job: 'pick' })
    ]);
  });
});
