import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../../automation/CommandQueue';
import { queueMacro, type MacroParts } from '../macros';
import { t } from '../../app/i18n';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { wireItem } from '../../../shared/entities';

// Steps worked out at their turn (todo 83): a client command and `{mob}`.
describe('a macro step worked out at its turn', () => {
  let sent: string[];
  let notices: string[];
  let queue: CommandQueue;
  let state: CharacterState;
  let mob: string | null;

  const parts = (): MacroParts => ({
    send: (data) => sent.push(data.trim()),
    queue,
    connected: () => true,
    notice: (message) => notices.push(message),
    published: () => undefined,
    batch: () => 1,
    state: () => state,
    mob: () => mob
  });

  /** Each prompt credits one command and lets the next go. */
  const prompts = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      vi.advanceTimersByTime(50);
      queue.notePrompt();
    }
    vi.advanceTimersByTime(50);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    notices = [];
    mob = null;
    state = { ...structuredClone(EMPTY_CHARACTER), phase: 'in-game' };
    queue = new CommandQueue(
      { ...DEFAULT_CONFIG.automation, pacing: { window: 1, minGapMs: 10, ackTimeoutMs: 30_000 } },
      { send: (command) => sent.push(command), connected: () => true }
    );
  });

  afterEach(() => {
    queue.dispose();
    vi.useRealTimers();
  });

  it('gets what is on the floor of the room the step before walked into', () => {
    queueMacro('sw;get all', parts());
    expect(sent).toEqual(['sw']);
    state = { ...state, room: { ...state.room, items: [wireItem('torch'), wireItem('rope')] } };
    prompts(2);
    expect(sent).toEqual(['sw', 'get torch', 'get rope']);
  });

  it('names the monster auto-combat would open on, at its turn', () => {
    queueMacro('sw;a {mob};grin', parts());
    mob = 'giant rat';
    prompts(2);
    expect(sent).toEqual(['sw', 'a giant rat', 'grin']);
  });

  it('stops the line at a {mob} with nothing to attack, and says so', () => {
    queueMacro('sw;a {mob};grin', parts());
    prompts(3);
    // Positive control: the step before it went.
    expect(sent).toEqual(['sw']);
    expect(notices).toContain(t('session.macro.noMob', { command: 'a {mob}' }));
    expect(queue.snapshot.depth).toBe(0);
  });

  it('refuses a placeholder the client cannot fill, before anything goes', () => {
    queueMacro('sw;a {who}', parts());
    expect(sent).toEqual([]);
    expect(notices).toContain(t('session.macro.unknownPlaceholder', { name: '{who}' }));
  });

  it('fills a guard field at its turn, and stops at one not read yet', () => {
    queueMacro('get {hp} gold;grin', parts());
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('session.macro.noValue', { command: 'get {hp} gold', name: '{hp}' })
    );
    state = { ...state, vitals: { ...state.vitals, hp: 42 } };
    queueMacro('get {hp} gold', parts());
    prompts(1);
    expect(sent).toEqual(['get 42 gold']);
  });

  it('sends a marked line as typed, mark off and braces kept', () => {
    queueMacro('\\a {mob}', parts());
    expect(sent).toEqual(['a {mob}']);
  });
});
