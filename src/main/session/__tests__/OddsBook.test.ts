import { describe, expect, it, vi } from 'vitest';

import { OddsBook, type OddsBookParts, type OddsWorld } from '../OddsBook';
import type { FightCharacter } from '../FightSetup';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { MobEntity } from '../../../shared/entities';
import type { WorldRoom } from '../../../shared/world';

/*
 * The odds book (todo 03): every monster and lair run in the background, one
 * fight a slice, started again when the character moves, what a reader asks
 * for first. The fight itself is `simulateFight`'s and tested there.
 */

const ogre = {
  name: 'ogre',
  source: 'realm',
  hp: 30,
  profiles: [
    {
      attacks: [{ kind: 'melee' as const, chance: 1, accuracy: 50, min: 1, max: 2, energy: 1000 }],
      casts: []
    }
  ]
} as unknown as MobEntity;

const lairRoom = {
  map: 1,
  room: 2,
  name: 'Den',
  exits: [],
  lair: '(Max 2): 7,'
} as unknown as WorldRoom;

function inGame(level: number): CharacterState {
  return {
    ...EMPTY_CHARACTER,
    phase: 'in-game',
    vitals: { ...EMPTY_CHARACTER.vitals, hp: 100, hpMax: 100, mana: 0, manaMax: 0 },
    progress: { ...EMPTY_CHARACTER.progress, level }
  };
}

const CHARACTER: FightCharacter = {
  hp: 100,
  hpMax: 100,
  mana: 0,
  manaMax: 0,
  player: { armourClass: 10, damageResist: 0, magicRes: 50 },
  sheet: {
    level: 10,
    agility: 60,
    intellect: 50,
    charm: 55,
    willpower: 50,
    health: 60,
    strength: 55,
    spellcasting: 40,
    combatLevel: 4,
    mageryLevel: null,
    encumbrancePercent: 20
  },
  weapon: { min: 5, max: 12, speed: 20, strength: 30 },
  family: 'greatermud',
  weights: {
    held: 1,
    confused: 1,
    blinded: 1,
    slowed: 1,
    afraid: 1,
    summon: 1,
    teleported: 1,
    roomWide: 1,
    lastingTicks: 20,
    unitFloor: 10,
    deathOverRounds: 5
  },
  heal: null,
  regenPerRound: 0,
  recasts: [],
  levels: { safeAbove: 0.6, riskyAbove: 0.25 },
  trials: 20,
  roundCap: 50,
  horizons: [1, 3]
};

function book(): { odds: OddsBook; tracker: { current: CharacterState }; ran: () => void } {
  const tracker = { current: inGame(10) };
  const world: OddsWorld = {
    mobNames: () => ['ogre'],
    buildMobEntity: (name: string) => (name === 'ogre' ? ogre : undefined),
    everyRoom: function* () {
      yield lairRoom;
    },
    lairEntities: () => [ogre]
  } as unknown as OddsWorld;
  const parts: OddsBookParts = {
    tracker,
    world,
    errands: { fitness: (state) => `level ${state.progress.level}` },
    setup: {
      character: () => CHARACTER,
      foes: (_state, _character, met) => ({
        foes: met.map(({ name, subject }) => ({ name, subject })),
        casting: met.map(() => null)
      }),
      settingsKey: () => 'settings'
    }
  };
  const ran = vi.fn();
  return { odds: new OddsBook(parts, { ran }), tracker, ran };
}

describe('the odds book', () => {
  it('waits for the character, says pending until a fight is run, then the run', async () => {
    const { odds, tracker } = book();
    expect(odds.mob('ogre')).toEqual({ kind: 'unread' });
    odds.refresh(tracker.current);
    expect(odds.mob('ogre')).toEqual({ kind: 'pending' });
    await vi.waitFor(() => expect(odds.mob('ogre').kind).toBe('run'));
    await vi.waitFor(() => expect(odds.lair(lairRoom).kind).toBe('run'));
    odds.dispose();
  });

  it('tells the reader a monster it asked for has been run', async () => {
    const { odds, tracker, ran } = book();
    odds.refresh(tracker.current);
    odds.mob('ogre');
    await vi.waitFor(() => expect(ran).toHaveBeenCalled());
    odds.dispose();
  });

  it('starts again when the character moves, and not when it does not', async () => {
    const { odds, tracker } = book();
    odds.refresh(tracker.current);
    await vi.waitFor(() => expect(odds.mob('ogre').kind).toBe('run'));
    odds.refresh(tracker.current);
    expect(odds.mob('ogre').kind).toBe('run');
    tracker.current = inGame(11);
    odds.refresh(tracker.current);
    expect(odds.mob('ogre')).toEqual({ kind: 'pending' });
    odds.dispose();
  });

  it('answers a room with no lair as not run, and a monster the realm lacks likewise', async () => {
    const { odds, tracker } = book();
    odds.refresh(tracker.current);
    expect(odds.lair({ ...lairRoom, lair: undefined } as WorldRoom)).toEqual({ kind: 'unrun' });
    odds.mob('stranger');
    await vi.waitFor(() => expect(odds.mob('stranger')).toEqual({ kind: 'unrun' }));
    odds.dispose();
  });

  it('runs nothing after it is put down', async () => {
    const { odds, tracker, ran } = book();
    // Positive control: a second book, asked the same, is told.
    const control = book();
    control.odds.refresh(control.tracker.current);
    control.odds.mob('ogre');
    odds.refresh(tracker.current);
    odds.mob('ogre');
    odds.dispose();
    await vi.waitFor(() => expect(control.ran).toHaveBeenCalled());
    expect(ran).not.toHaveBeenCalled();
    expect(odds.mob('ogre')).toEqual({ kind: 'unread' });
    control.odds.dispose();
  });

  /* 2026-10-02: a planner waiting on the simulator read the whole survey every 5 s for this. */
  it('counts the lairs it has still to run', async () => {
    const { odds, tracker } = book();
    expect(odds.lairsLeft).toBe(0);
    odds.refresh(tracker.current);
    expect(odds.lairsLeft).toBe(1);
    await vi.waitFor(() => expect(odds.lair(lairRoom).kind).toBe('run'));
    expect(odds.lairsLeft).toBe(0);
    odds.dispose();
  });

  /* 2026-10-02: one lair's fight held main 250 to 800ms in one piece, past the slice. */
  it('carries a fight part way through its trials into the next slice', async () => {
    const { odds, tracker } = book();
    const slices = vi.spyOn(globalThis, 'setImmediate');
    // Each reading 5ms past the last, against an 8ms slice: one trial a slice.
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 5));
    try {
      odds.refresh(tracker.current);
      await vi.waitFor(() => expect(odds.lair(lairRoom).kind).toBe('run'));
    } finally {
      now.mockRestore();
    }
    expect(slices.mock.calls.length).toBeGreaterThan(CHARACTER.trials);
    slices.mockRestore();
    const run = odds.lair(lairRoom);
    expect(run.kind === 'run' && run.survival.trials).toBe(CHARACTER.trials);
    odds.dispose();
  });

  /* Caught on review: a slice that found the key moved stopped, and nothing started it again. */
  it('starts again for the character there now when it moves mid-run', async () => {
    const { odds, tracker } = book();
    odds.refresh(tracker.current);
    // Moved before the first slice, with nobody refreshing it.
    tracker.current = inGame(12);
    await vi.waitFor(() => expect(odds.mob('ogre').kind).toBe('run'));
    expect(odds.lair(lairRoom).kind).toBe('run');
    odds.dispose();
  });
});
