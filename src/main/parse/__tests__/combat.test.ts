import { describe, expect, it } from 'vitest';

import { FightTracker, playerDies } from '../combat';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import { NO_LORE } from '../../../shared/lore';
import type { FightRecord } from '../../../shared/fights';

/*
 * The cluster lifted out of `CharacterTracker` on 2026-08-29. The wire-level
 * behaviour is pinned by the tracker's own tests, and several cases here
 * re-assert it at the class's own edge; what only these ask is what the fight
 * writes down when it ends — the record's contents, that it is written once,
 * and that forgetting a fight settles nothing.
 */
const mob = (name: string): RoomOccupant => ({
  name,
  kind: 'mob',
  disposition: null,
  uncertain: false,
  costly: 'never',
  charmed: false,
  hidden: false,
  free: false
});

const state = (over: Partial<CharacterState> = {}): CharacterState => ({
  ...structuredClone(EMPTY_CHARACTER),
  name: 'Vaelor',
  ...over
});

/** A fight whose room is whatever the test says, with a sink that keeps records. */
function fight(occupants: RoomOccupant[] = []) {
  const records: FightRecord[] = [];
  const tracker = new FightTracker({
    lore: NO_LORE,
    fights: { record: (record) => records.push(record) },
    withOccupant: (s, name) =>
      s.room.occupants.some((who) => who.name === name)
        ? s.room
        : { ...s.room, occupants: [...s.room.occupants, mob(name)] }
  });
  return { tracker, records, s: state({ room: { ...EMPTY_CHARACTER.room, occupants } }) };
}

/**
 * A fight against a realm that states a monster's maximum health and how fast
 * it heals — which `NO_LORE` above deliberately does not.
 */
function healer(max: number, regen: number | null) {
  const records: FightRecord[] = [];
  const tracker = new FightTracker({
    lore: {
      ...NO_LORE,
      maximumFor: () => ({ max, source: 'realm', span: null }),
      regenFor: () => regen
    },
    fights: { record: (record) => records.push(record) },
    withOccupant: (s, name) =>
      s.room.occupants.some((who) => who.name === name)
        ? s.room
        : { ...s.room, occupants: [...s.room.occupants, mob(name)] }
  });
  return {
    tracker,
    s: state({ room: { ...EMPTY_CHARACTER.room, occupants: [mob('cave bear')] } })
  };
}

describe('a blow on this character', () => {
  it('counts a blow nothing could name without inventing an attacker', () => {
    const { tracker, s } = fight();
    const next = tracker.blowOnMe(s, 1_000, undefined);
    expect(next.combat.blows).toBe(1);
    expect(next.combat.lastBlowAt).toBe(1_000);
    expect(next.combat.attackers).toEqual([]);
    expect(next.room.occupants).toEqual([]);
  });

  it('puts a vouched-for attacker in the room and at the head of the attackers', () => {
    const { tracker, s } = fight();
    const first = tracker.blowOnMe(s, 1_000, 'giant rat');
    const next = tracker.blowOnMe(first, 2_000, 'kobold thief');
    expect(next.combat.attackers).toEqual(['kobold thief', 'giant rat']);
    expect(next.room.occupants.map((who) => who.name)).toEqual(['giant rat', 'kobold thief']);
    // Three lines from the same monster in one round is one attacker.
    expect(tracker.blowOnMe(next, 3_000, 'giant rat').combat.attackers).toEqual([
      'giant rat',
      'kobold thief'
    ]);
  });
});

describe("this character's own swings", () => {
  it('a miss names the target and a hit tallies it', () => {
    const { tracker, s } = fight([mob('giant rat')]);
    const missed = tracker.missed(s, 1_000, 'giant rat');
    expect(missed?.combat.target).toBe('giant rat');
    // The same target again says nothing new.
    expect(tracker.missed(missed!, 1_100, 'giant rat')).toBeNull();
    const hit = tracker.hit(missed!, 2_000, 'giant rat', 'You', 7);
    expect(hit?.combat.target).toBe('giant rat');
    expect(hit?.combat.health?.damage).toEqual({ mine: 7, others: 0 });
    // No realm and no lore: a tally, and honestly no maximum and no bar.
    expect(hit?.combat.health?.max).toBeNull();
    expect(hit?.combat.health?.remaining).toBeNull();
  });

  it("somebody else's blow is tallied and never becomes this character's target", () => {
    const { tracker, s } = fight([mob('giant rat')]);
    // Not fighting it: recorded, nothing to republish.
    expect(tracker.hit(s, 1_000, 'giant rat', 'Rand', 5)).toBeNull();
    const mine = tracker.hit(s, 1_100, 'giant rat', 'You', 3)!;
    const theirs = tracker.hit(mine, 1_200, 'giant rat', 'Rand', 5)!;
    expect(theirs.combat.target).toBe('giant rat');
    expect(theirs.combat.health?.damage).toEqual({ mine: 3, others: 10 });
  });
});

describe('an engagement', () => {
  it('binds the attack command to the occupant the server would resolve it to', () => {
    const { tracker, s } = fight([mob('small giant rat')]);
    tracker.noteCommand('giant rat');
    const engaged = tracker.status(s, true, 1_000);
    expect(engaged.inCombat).toBe(true);
    // The base name binds, as the server's name-modifier system does.
    expect(engaged.combat.target).toBe('small giant rat');
  });

  it('does not bind a command that named nothing, and keeps a target it already has', () => {
    const { tracker, s } = fight([mob('giant rat')]);
    tracker.noteCommand(null);
    expect(tracker.status(s, true, 1_000).combat.target).toBeNull();
    const fighting = tracker.missed(s, 1_000, 'giant rat')!;
    tracker.noteCommand('kobold');
    expect(tracker.status(fighting, true, 2_000).combat.target).toBe('giant rat');
  });
});

describe('a death and the end of a fight', () => {
  it('a suspected death takes the monster out of the room and the fight', () => {
    const { tracker, s } = fight([mob('giant rat'), mob('kobold thief')]);
    const hit = tracker.hit(s, 1_000, 'giant rat', 'You', 9)!;
    const struck = tracker.blowOnMe(hit, 1_100, 'giant rat');
    const died = tracker.died(struck, 2_000);
    expect(died.combat.target).toBeNull();
    expect(died.combat.health).toBeNull();
    expect(died.combat.attackers).toEqual([]);
    expect(died.room.occupants.map((who) => who.name)).toEqual(['kobold thief']);
  });

  it('nothing this client watched take damage cannot have died', () => {
    const { tracker, s } = fight([mob('giant rat')]);
    const fighting = tracker.missed(s, 1_000, 'giant rat')!;
    expect(tracker.died(fighting, 2_000)).toBe(fighting);
  });

  it('*Combat Off* writes the fight down, as a kill only when the suspicion stood', () => {
    const { tracker, records, s } = fight([mob('giant rat'), mob('kobold thief')]);
    let next = tracker.hit(s, 1_000, 'giant rat', 'You', 9)!;
    next = tracker.hit(next, 1_500, 'kobold thief', 'Rand', 4) ?? next;
    next = tracker.died(next, 2_000);
    const over = tracker.status(next, false, 3_000);
    expect(over.inCombat).toBe(false);
    expect(over.combat.attackers).toEqual([]);
    expect(records.map((r) => [r.mob, r.killed, r.opened, r.mine, r.others])).toEqual([
      ['giant rat', true, true, 9, 0],
      // Still standing when the fight ended, and not this character's fight.
      ['kobold thief', false, false, 0, 4]
    ]);
    // Written once: the ledgers are gone with the fight.
    tracker.status(over, false, 4_000);
    expect(records).toHaveLength(2);
  });

  it('forgetting settles nothing', () => {
    const { tracker, records, s } = fight([mob('giant rat')]);
    tracker.hit(s, 1_000, 'giant rat', 'You', 9);
    tracker.forget();
    tracker.status(s, false, 2_000);
    expect(records).toEqual([]);
  });
});

describe('a player dying in the room', () => {
  it('leaves the occupant list and the fight like a killed monster', () => {
    const s = state({
      room: { ...EMPTY_CHARACTER.room, occupants: [{ ...mob('Rend'), kind: 'player' }] },
      combat: { ...EMPTY_CHARACTER.combat, target: 'Rend', attackers: ['Rend'] }
    });
    const next = playerDies(s, 'rend');
    expect(next?.room.occupants).toEqual([]);
    expect(next?.combat.target).toBeNull();
    expect(next?.combat.attackers).toEqual([]);
  });

  it('says nothing about a death elsewhere', () => {
    expect(playerDies(state(), 'Rend')).toBeNull();
    expect(playerDies(state(), undefined)).toBeNull();
  });
});

/*
 * The half of the wound estimate that never existed.
 *
 * `1 - damage/max` only ever falls, so a fight that lasts long enough drifts
 * arbitrarily far below the truth — and the only correction was a `look`
 * re-anchoring it, which is a command spent to learn something the realm data
 * already states (`Monsters.HPRegen`, format 12). The cadence is realm-wide
 * and lives in `parse.mobRegenMs`, 30s by default.
 */
describe('a monster heals while you fight it', () => {
  /*
   * The bar is recomputed by the events that carry a timestamp and a target —
   * a blow, a wound line, an engagement that names a new target. `missed`
   * deliberately declines for the monster already being fought and `status`
   * declines for a target it already has, so a test that used either would be
   * measuring the wrong thing.
   */
  const opening = (tracker: FightTracker, s: CharacterState): CharacterState => {
    tracker.noteCommand('cave bear');
    return tracker.status(s, true, 0);
  };
  const strike = (
    tracker: FightTracker,
    s: CharacterState,
    at: number,
    damage: number
  ): CharacterState => tracker.hit(s, at, 'cave bear', undefined, damage) ?? s;

  it('adds back a whole tick of regeneration', () => {
    const { tracker, s } = healer(100, 10);
    let next = opening(tracker, s);
    // 40 damage at t=0, then 10 more a minute later. 50 dealt, two ticks of 10
    // healed in between, so 30 of its 100 are actually gone.
    next = strike(tracker, next, 0, 40);
    expect(next.combat.health?.remaining).toBeCloseTo(0.6, 5);
    next = strike(tracker, next, 60_000, 10);
    expect(next.combat.health?.remaining).toBeCloseTo(0.7, 5);
  });

  /*
   * The positive control. The same minute and the same blows against a realm
   * that states no regeneration must land where the damage alone puts them —
   * so the difference above is the regeneration being read rather than the
   * clock moving the bar on its own.
   */
  it('leaves the estimate alone when the realm states no regeneration', () => {
    const { tracker, s } = healer(100, null);
    let next = opening(tracker, s);
    next = strike(tracker, next, 0, 40);
    next = strike(tracker, next, 60_000, 10);
    expect(next.combat.health?.remaining).toBeCloseTo(0.5, 5);
  });

  /*
   * Whole ticks only. A monster a second short of a tick has healed nothing,
   * and rounding a partial tick up would put health back that is not there —
   * the reassuring error this estimate exists to avoid.
   */
  it('counts no fraction of a tick', () => {
    const { tracker, s } = healer(100, 10);
    let next = opening(tracker, s);
    next = strike(tracker, next, 0, 40);
    next = strike(tracker, next, 29_999, 10);
    expect(next.combat.health?.remaining).toBeCloseTo(0.5, 5);
  });

  /*
   * And it can never put a monster back above full: the realm's figure is a
   * maximum, and a long stand-off must not draw a bar over 100%.
   */
  it('never heals past the maximum', () => {
    const { tracker, s } = healer(100, 10);
    let next = opening(tracker, s);
    next = strike(tracker, next, 0, 40);
    next = strike(tracker, next, 10_000_000, 1);
    expect(next.combat.health?.remaining).toBe(1);
  });
});
