import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { setTuning, tuning } from '../../app/tuning';
import type { Intent } from '../../automation/CommandQueue';
import { FleeGoto } from '../FleeGoto';
import { blockOf } from '../../../shared/__tests__/blocks';
import type { BlockType } from '../../../shared/blocks';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { DEFAULT_INTERNAL } from '../../../shared/internal';

/*
 * The wire this reads (todo 813's probe, orohost):
 * - a sysop mid-fight: `sys go 1 297` → `Bank of Godfrey` ~100ms later, then
 *   `*Combat Off*` (`logs/2026-09-04_12-28-42_main.mudcap.jsonl`, +97ms/+287ms);
 * - a player: `Your command had no effect.` (`probe:goto -- --as probe`).
 */
const LAIR = { ...EMPTY_CHARACTER.room, name: 'Black Cave, Glowing Tunnel', map: 1, number: 1765 };
const BANK = { ...EMPTY_CHARACTER.room, name: 'Bank of Godfrey', map: 1, number: 297 };

function fighting(hp: number | null, extra: Partial<CharacterState> = {}): CharacterState {
  return {
    ...EMPTY_CHARACTER,
    phase: 'in-game',
    inCombat: true,
    room: LAIR,
    vitals: { ...EMPTY_CHARACTER.vitals, hp, hpMax: 100 },
    combat: { ...EMPTY_CHARACTER.combat, attackers: ['fat cave lizard'] },
    ...extra
  };
}

function settings(
  fleeGoto: Partial<AutomationConfig['safety']['fleeGoto']> = {},
  retreat: Partial<AutomationConfig['safety']['retreat']> = {}
): AutomationConfig {
  const safety = DEFAULT_CONFIG.automation.safety;
  return {
    ...DEFAULT_CONFIG.automation,
    enabled: true,
    safety: {
      ...safety,
      retreat: { ...safety.retreat, ...retreat },
      fleeGoto: { enabled: true, belowHealth: 0.2, command: 'sys go 1 297', ...fleeGoto }
    }
  };
}

function rig(config: AutomationConfig = settings()) {
  const tracker = { current: fighting(15), pendingMoves: 0 };
  const sent: Intent[] = [];
  const queue = { enqueue: vi.fn((intent: Intent) => sent.push(intent) > 0) };
  const travel = {
    escapeUnanswered: false,
    teleportSent: vi.fn(),
    teleportRefused: vi.fn(),
    teleportLanded: vi.fn()
  };
  const noteSafety = vi.fn();
  const grounded = { down: false };
  const notice = vi.fn();
  let current = config;
  const flee = new FleeGoto(
    { tracker, queue, travel, publisher: { noteSafety }, grounded },
    { config: () => current, notice }
  );
  /** The byte leaves: the queue's own `onSent`. */
  const leave = (): void => sent.at(-1)?.onSent?.();
  /** A line the realm sends, after the echo of the command it answers (default: ours). */
  const answer = (
    type: BlockType,
    text: string,
    room = tracker.current.room,
    echo: string | null = 'sys go 1 297'
  ): void => {
    tracker.current = { ...tracker.current, room };
    flee.settle(blockOf(type, text, {}, Date.now()), echo);
  };
  const reconfigure = (next: AutomationConfig): void => {
    current = next;
  };
  return { flee, tracker, sent, travel, noteSafety, grounded, notice, leave, answer, reconfigure };
}

describe('FleeGoto', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    setTuning(DEFAULT_INTERNAL.tuning);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the realm’s command, literally, in the emergency band below its floor', () => {
    const { flee, tracker, sent, travel, notice } = rig();
    flee.consider(tracker.current);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ command: 'sys go 1 297', priority: 'emergency' });
    // Broken off as the walked escape breaks it off.
    expect(travel.teleportSent).toHaveBeenCalledWith(Date.now());
    expect(notice).toHaveBeenCalledWith(
      t('session.safety.teleporting', {
        command: 'sys go 1 297',
        why: t('session.safety.whyHealth', { percent: '15%' })
      })
    );
    // Once: the next status line does not send it again while it is unanswered.
    flee.consider(tracker.current);
    expect(sent).toHaveLength(1);
  });

  it('sends nothing above its floor, nor on an unknown figure, nor out of a fight', () => {
    const { flee, sent } = rig();
    flee.consider(fighting(25));
    flee.consider(fighting(null));
    flee.consider(fighting(15, { inCombat: false, combat: EMPTY_CHARACTER.combat }));
    expect(sent).toHaveLength(0);
    // Positive control: the same rig below its floor in a fight sends.
    flee.consider(fighting(15));
    expect(sent).toHaveLength(1);
  });

  it('is the tier below the retreat: never above its floor, never across its move', () => {
    const { flee, sent, travel, tracker } = rig(
      settings({ belowHealth: 0.5 }, { enabled: true, belowHealth: 0.3 })
    );
    flee.consider(fighting(40));
    travel.escapeUnanswered = true;
    flee.consider(fighting(15));
    travel.escapeUnanswered = false;
    tracker.pendingMoves = 1;
    flee.consider(fighting(15));
    expect(sent).toHaveLength(0);
    // Positive control: the retreat answered, the move landed, still below both floors.
    tracker.pendingMoves = 0;
    flee.consider(fighting(15));
    expect(sent).toHaveLength(1);
  });

  it('never acts on a character lying mortally wounded', () => {
    const { flee, sent, grounded } = rig();
    grounded.down = true;
    flee.consider(fighting(-3));
    grounded.down = false;
    flee.consider(fighting(-3, { mortallyWounded: true }));
    expect(sent).toHaveLength(0);
    // Positive control: up again, it goes.
    flee.consider(fighting(5));
    expect(sent).toHaveLength(1);
  });

  it('records the landing as acted when a new room answers', () => {
    const { flee, tracker, noteSafety, leave, answer, notice, travel } = rig();
    flee.consider(tracker.current);
    leave();
    answer('room-name', 'Bank of Godfrey', BANK);
    expect(noteSafety).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'teleport', acted: true })
    );
    // The fight left behind is fled, by the walked escape's own bookkeeping.
    expect(travel.teleportLanded).toHaveBeenCalledWith(LAIR, Date.now());
    expect(travel.teleportRefused).not.toHaveBeenCalled();
    // Settled: nothing further is said when the deadline would have passed.
    vi.advanceTimersByTime(tuning().session.retreatPatienceMs + 1);
    answer('status-line', '[HP=15]:', BANK);
    expect(notice).toHaveBeenCalledTimes(1);
  });

  it('reads a refusal only after the byte left, and keeps it for the connection', () => {
    const { flee, tracker, sent, leave, answer, notice, noteSafety, travel } = rig();
    flee.consider(tracker.current);
    // Before the send: somebody else's answer.
    answer('command-no-effect', 'Your command had no effect.');
    expect(noteSafety).not.toHaveBeenCalled();
    leave();
    // After it, echoed against another command: that command's refusal.
    answer('command-no-effect', 'Your command had no effect.', undefined, 'c mend');
    expect(noteSafety).not.toHaveBeenCalled();
    answer('command-no-effect', 'Your command had no effect.');
    // The fight is not stood down for a teleport that is not happening.
    expect(travel.teleportRefused).toHaveBeenCalledWith(Date.now());
    expect(notice).toHaveBeenLastCalledWith(
      t('session.safety.teleportRefused', {
        command: 'sys go 1 297',
        answer: 'Your command had no effect.'
      })
    );
    expect(noteSafety).toHaveBeenLastCalledWith(
      expect.objectContaining({ acted: false, refused: 'Your command had no effect.' })
    );
    // Not sent again: said once this fight instead.
    vi.advanceTimersByTime(DEFAULT_CONFIG.automation.safety.retreat.cooldownMs);
    flee.consider(tracker.current);
    flee.consider(tracker.current);
    expect(sent).toHaveLength(1);
    expect(notice).toHaveBeenLastCalledWith(
      t('session.safety.teleportNot', {
        why: t('session.safety.whyHealth', { percent: '15%' }),
        refused: t('session.safety.teleportRefusedBefore', { command: 'sys go 1 297' })
      })
    );
    // Positive control: a reconnect forgets it, and it is tried again.
    flee.reset();
    flee.consider(tracker.current);
    expect(sent).toHaveLength(2);
  });

  it('drops out loud on a death, and gives up out loud on silence', () => {
    const killed = rig();
    killed.flee.consider(killed.tracker.current);
    killed.leave();
    killed.answer('user-dies', 'You die.');
    expect(killed.notice).toHaveBeenLastCalledWith(
      t('session.safety.teleportDropped', { command: 'sys go 1 297' })
    );

    const silent = rig();
    silent.flee.consider(silent.tracker.current);
    silent.leave();
    vi.advanceTimersByTime(tuning().session.retreatPatienceMs);
    silent.answer('status-line', '[HP=15]:');
    // Positive control: still waiting at the deadline itself; past it, said.
    expect(silent.notice).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    silent.answer('status-line', '[HP=15]:');
    expect(silent.notice).toHaveBeenLastCalledWith(
      t('session.safety.teleportGaveUp', {
        command: 'sys go 1 297',
        seconds: Math.round(tuning().session.retreatPatienceMs / 1000)
      })
    );
  });

  /*
   * A room that does not exist (todo 766), in the shapes the wire gives it.
   * The realm may repaint a bare prompt between the echo and its answer
   * (`logs/2026-08-30_20-57-36_main.mudcap.jsonl`, `Map and/or Room not
   * found`), which clears `SessionManager.answering`; and it may glue the
   * answer to the prompt, where the tail reads as the echo
   * (`2026-09-19_00-44-05_vaelor2.mudcap.jsonl`, `Command not allowed in live
   * realm.`). Each `answer` is handed `answering` as it stood before the block.
   */
  it('reads a bad room at once across a bare prompt, and keeps it for the connection', () => {
    const { flee, tracker, sent, leave, answer, notice, noteSafety, travel } = rig();
    flee.consider(tracker.current);
    leave();
    // Positive control: echoed against another command, it is that command's.
    answer('command-echo', 'c mend', undefined, null);
    answer('status-line', '[HP=15]:', undefined, 'c mend');
    answer('sys-refused', 'Map and/or Room not found', undefined, null);
    expect(travel.teleportRefused).not.toHaveBeenCalled();
    answer('command-echo', 'sys go 1 297', undefined, null);
    answer('status-line', '[HP=15]:', undefined, 'sys go 1 297');
    answer('sys-refused', 'Map and/or Room not found', undefined, null);
    // At once, not at the give-up: no time has passed.
    expect(travel.teleportRefused).toHaveBeenCalledWith(Date.now());
    expect(notice).toHaveBeenLastCalledWith(
      t('session.safety.teleportRefused', {
        command: 'sys go 1 297',
        answer: 'Map and/or Room not found'
      })
    );
    expect(noteSafety).toHaveBeenLastCalledWith(
      expect.objectContaining({ acted: false, refused: 'Map and/or Room not found' })
    );
    vi.advanceTimersByTime(DEFAULT_CONFIG.automation.safety.retreat.cooldownMs);
    flee.consider(tracker.current);
    expect(sent).toHaveLength(1);
    expect(notice).toHaveBeenLastCalledWith(
      t('session.safety.teleportNot', {
        why: t('session.safety.whyHealth', { percent: '15%' }),
        refused: t('session.safety.teleportRefusedBefore', { command: 'sys go 1 297' })
      })
    );
    // Positive control: a reconnect forgets it.
    flee.reset();
    flee.consider(tracker.current);
    expect(sent).toHaveLength(2);
  });

  it('reads a refusal glued to the prompt as this teleport’s, not as an echo of itself', () => {
    const { flee, tracker, sent, leave, answer, travel } = rig();
    flee.consider(tracker.current);
    leave();
    const refusal = 'Command not allowed in live realm.';
    answer('command-echo', 'sys go 1 297', undefined, null);
    answer('status-line', `[HP=15]:${refusal}`, undefined, 'sys go 1 297');
    // Positive control: still waiting on the prompt the refusal is glued to.
    expect(travel.teleportRefused).not.toHaveBeenCalled();
    answer('sys-refused', refusal, undefined, refusal);
    expect(travel.teleportRefused).toHaveBeenCalledWith(Date.now());
    vi.advanceTimersByTime(DEFAULT_CONFIG.automation.safety.retreat.cooldownMs);
    flee.consider(tracker.current);
    expect(sent).toHaveLength(1);
  });

  it('takes an unechoed refusal as this attempt’s, without keeping it for the connection', () => {
    const { flee, tracker, sent, leave, answer } = rig();
    flee.consider(tracker.current);
    leave();
    answer('command-no-effect', 'Your command had no effect.', undefined, null);
    vi.advanceTimersByTime(DEFAULT_CONFIG.automation.safety.retreat.cooldownMs);
    flee.consider(tracker.current);
    expect(sent).toHaveLength(2);
  });

  it('is not sent once dropped, nor from the ground, however long the queue held it', () => {
    const { flee, tracker, sent, answer, grounded } = rig();
    flee.consider(tracker.current);
    // Positive control: wanted while it waits for its turn.
    expect(sent[0]?.stillWanted?.()).toBe(true);
    grounded.down = true;
    expect(sent[0]?.stillWanted?.()).toBe(false);
    grounded.down = false;
    answer('user-dies', 'You die.');
    expect(sent[0]?.stillWanted?.()).toBe(false);
  });

  it('drops out loud when the character leaves the realm with it unanswered', () => {
    const { flee, tracker, notice } = rig();
    flee.consider(tracker.current);
    flee.reset();
    expect(notice).toHaveBeenLastCalledWith(
      t('session.safety.teleportDropped', { command: 'sys go 1 297' })
    );
  });

  it('says once a fight that no realm or character states a command', () => {
    const { flee, tracker, sent, notice, reconfigure } = rig(settings({ command: '' }));
    flee.consider(tracker.current);
    vi.advanceTimersByTime(5_000);
    flee.consider(tracker.current);
    expect(sent).toHaveLength(0);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(
      t('session.safety.teleportNot', {
        why: t('session.safety.whyHealth', { percent: '15%' }),
        refused: t('session.safety.teleportUnstated')
      })
    );
    // Positive control: a command stated, it goes.
    reconfigure(settings());
    flee.consider(tracker.current);
    expect(sent).toHaveLength(1);
  });

  it('sends nothing switched off, or with automation off', () => {
    const { flee, tracker, sent, reconfigure } = rig(settings({ enabled: false }));
    flee.consider(tracker.current);
    reconfigure({ ...settings(), enabled: false });
    flee.consider(tracker.current);
    expect(sent).toHaveLength(0);
    reconfigure(settings());
    flee.consider(tracker.current);
    expect(sent).toHaveLength(1);
  });
});
