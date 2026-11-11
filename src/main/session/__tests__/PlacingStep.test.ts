import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { setTuning, tuning } from '../../app/tuning';
import type { Intent } from '../../automation/CommandQueue';
import type { LocateAsk } from '../Claims';
import { PlacingStep } from '../PlacingStep';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { ExitEntity } from '../../../shared/entities';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { DEFAULT_INTERNAL } from '../../../shared/internal';

const exit = (direction: string): ExitEntity => ({
  direction,
  note: null,
  targetMap: null,
  targetRoom: null,
  targetName: null,
  requirement: null
});

/** Yang after the relogin: a Sewer Tunnel, Intersection the client cannot place. */
const lost = (arrival: number, exits: readonly string[] = ['n', 's', 'e']): CharacterState => ({
  ...EMPTY_CHARACTER,
  phase: 'in-game',
  room: {
    ...EMPTY_CHARACTER.room,
    name: 'Sewer Tunnel, Intersection',
    map: null,
    number: null,
    arrival,
    exits: exits.map(exit)
  }
});

function rig(word: string | null = null) {
  const tracker = { current: lost(1), pendingMoves: 0 };
  const recovery = { restInFlight: false };
  const sent: Intent[] = [];
  // The queue sends at once, as an idle one with credit does.
  const queue = {
    offer: vi.fn((intent: Intent) => {
      sent.push(intent);
      intent.onSent?.();
      return 'queued' as const;
    })
  };
  const ask: LocateAsk = word === null ? { refused: 'unavailable' } : { asked: word };
  const claims = { askWhereIAm: vi.fn(() => ask) };
  const notices: string[] = [];
  const placing = new PlacingStep(
    {
      tracker,
      queue,
      vocabulary: { locateWord: word },
      claims,
      recovery,
      health: () => DEFAULT_CONFIG.automation.health
    },
    (message) => void notices.push(message)
  );
  return { placing, tracker, recovery, sent, claims, notices };
}

describe('PlacingStep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setTuning(DEFAULT_INTERNAL.tuning);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('steps through a printed exit where the realm has no locate word, and says so', () => {
    const { placing, sent, notices } = rig();
    placing.step();
    expect(sent.map((intent) => intent.command)).toEqual(['n']);
    expect(notices).toEqual([t('session.loop.placingStep', { direction: 'n' })]);
  });

  it('asks the locate word where the realm has one, and takes no step', () => {
    const { placing, sent, claims } = rig('rm');
    placing.locate();
    placing.step();
    expect(claims.askWhereIAm).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  it('waits for the step to land, and never walks straight back', () => {
    const { placing, tracker, sent } = rig();
    placing.step();
    placing.step();
    expect(sent).toHaveLength(1);
    tracker.current = lost(2, ['n', 's']);
    placing.step();
    expect(sent.map((intent) => intent.command)).toEqual(['n', 'n']);
  });

  it('tries another exit when a step goes unanswered', () => {
    const { placing, sent } = rig();
    placing.step();
    vi.advanceTimersByTime(tuning().loop.locateWaitMs);
    placing.step();
    expect(sent.map((intent) => intent.command)).toEqual(['n', 's']);
  });

  it('sends nothing in a fight, with a step owed, resting, or hurt under the rest floor', () => {
    const { placing, tracker, recovery, sent } = rig();
    tracker.pendingMoves = 1;
    placing.step();
    tracker.pendingMoves = 0;
    tracker.current = { ...lost(1), inCombat: true };
    placing.step();
    recovery.restInFlight = true;
    tracker.current = lost(1);
    placing.step();
    recovery.restInFlight = false;
    const vitals = { ...lost(1).vitals, hp: 70, hpMax: 70 };
    tracker.current = { ...lost(1), vitals: { ...vitals, resting: true } };
    placing.step();
    const floor = DEFAULT_CONFIG.automation.health.restBelow;
    expect(floor).toBeGreaterThan(0);
    tracker.current = { ...lost(1), vitals: { ...vitals, hp: Math.floor(70 * floor) - 1 } };
    placing.step();
    expect(sent).toEqual([]);
    // The control: whole and standing, it steps.
    tracker.current = { ...lost(1), vitals };
    placing.step();
    expect(sent).toHaveLength(1);
  });

  it('starts over once a published room places the character', () => {
    const { placing, tracker, sent } = rig();
    const most = tuning().loop.maxLocates;
    for (let arrival = 1; arrival <= most; arrival += 1) {
      tracker.current = lost(arrival);
      placing.step();
    }
    placing.onCharacter({
      ...lost(50),
      room: { ...lost(50).room, map: 1, number: 2149, resolvedBy: 'chain' }
    });
    tracker.current = lost(51);
    placing.step();
    expect(sent).toHaveLength(most + 1);
  });

  it('stops after maxLocates steps and says so once', () => {
    const { placing, tracker, sent, notices } = rig();
    const most = tuning().loop.maxLocates;
    for (let arrival = 1; arrival <= most + 2; arrival += 1) {
      tracker.current = lost(arrival);
      placing.step();
    }
    expect(sent).toHaveLength(most);
    const gaveUp = t('session.loop.placingGaveUp', { steps: most });
    expect(notices.filter((notice) => notice === gaveUp)).toHaveLength(1);
  });
});
