import { describe, expect, it } from 'vitest';

import { FightTracker, playerDies } from '../combat';
import { leftRoom } from '../steps';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import { NO_LORE } from '../../../shared/lore';
import type { FightRecord } from '../../../shared/fights';
import { NO_HARM } from '../../../shared/harm';
import { DEFAULT_INTERNAL } from '../../../shared/internal';

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

/** The same state with its target taken away, as a `*Combat Off*` would. */
const NO_TARGET = (s: CharacterState): CharacterState => ({
  ...s,
  combat: { ...s.combat, target: null }
});

/** A fight whose room is whatever the test says, with a sink that keeps records. */
function fight(occupants: RoomOccupant[] = []) {
  const records: FightRecord[] = [];
  const tracker = new FightTracker({
    lore: NO_LORE,
    fights: { record: (record) => records.push(record) },
    harm: NO_HARM,
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
    harm: NO_HARM,
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
    // Not fighting it: recorded and republished for the arena's gauge, never a target.
    const watched = tracker.hit(s, 1_000, 'giant rat', 'Rand', 5)!;
    expect(watched.combat.target).toBeNull();
    expect(watched.combat.healthHere['giant rat']?.damage).toEqual({ mine: 0, others: 5 });
    // A monster the room does not list moves no gauge, so nothing to republish.
    expect(tracker.hit(s, 1_050, 'cave bear', 'Rand', 5)).toBeNull();
    const mine = tracker.hit(s, 1_100, 'giant rat', 'You', 3)!;
    const theirs = tracker.hit(mine, 1_200, 'giant rat', 'Rand', 5)!;
    expect(theirs.combat.target).toBe('giant rat');
    expect(theirs.combat.health?.damage).toEqual({ mine: 3, others: 10 });
  });
});

describe('every monster the room lists', () => {
  it("publishes each name's estimate, the one namesakes share, from whoever's blows", () => {
    const { tracker, s } = healer(100, null);
    const room = {
      ...s.room,
      occupants: [mob('cave bear'), mob('fat giant rat'), mob('fat giant rat')]
    };
    const here = { ...s, room };
    const first = tracker.hit(here, 1_000, 'fat giant rat', 'Rand', 30)!;
    const next = tracker.hit(first, 1_100, 'cave bear', 'You', 10)!;
    expect(Object.keys(next.combat.healthHere).sort()).toEqual(['cave bear', 'fat giant rat']);
    expect(next.combat.healthHere['cave bear']?.remaining).toBeCloseTo(0.9, 5);
    // Two rats, one ledger: the 30 is theirs between them.
    expect(next.combat.healthHere['fat giant rat']?.remaining).toBeCloseTo(0.7, 5);
    expect(next.combat.health?.name).toBe('cave bear');
  });

  it('takes a look at a monster nobody is fighting as its gauge', () => {
    const { tracker, s } = healer(100, null);
    const looked = tracker.wounded(s, 'moderately wounded', 'cave bear', 1_000)!;
    expect(looked.combat.target).toBeNull();
    expect(looked.combat.healthHere['cave bear']?.observed).toBe('moderately wounded');
    expect(looked.combat.healthHere['cave bear']?.remaining).toBeLessThan(1);
  });

  it('counts what a monster lost since the look, so blows come off both edges of its band', () => {
    const { tracker, s } = healer(100, null);
    const looked = tracker.wounded(s, 'moderately wounded', 'cave bear', 1_000)!;
    expect(looked.combat.healthHere['cave bear']?.sinceLook).toBe(0);
    const struck = tracker.hit(looked, 1_100, 'cave bear', 'Rand', 20)!;
    expect(struck.combat.healthHere['cave bear']?.sinceLook).toBeCloseTo(0.2, 5);
    // No look, nothing to come off.
    const { tracker: other, s: fresh } = healer(100, null);
    expect(
      other.hit(fresh, 1_000, 'cave bear', 'Rand', 20)!.combat.healthHere['cave bear']?.sinceLook
    ).toBeNull();
  });
});

describe('a step out of a fight', () => {
  const fightingIn = (follows?: number) => {
    const records: FightRecord[] = [];
    const tracker = new FightTracker({
      lore: { ...NO_LORE, maximumFor: () => ({ max: 100, source: 'realm', span: null }) },
      fights: { record: (record) => records.push(record) },
      harm: NO_HARM,
      withOccupant: (s) => s.room
    });
    const orc = { ...mob('orc'), ...(follows === undefined ? {} : { mob: { follows } as never }) };
    const room = { ...EMPTY_CHARACTER.room, name: 'Main Road', occupants: [orc] };
    let s = state({ room });
    tracker.heard({ type: 'status-line', text: '', groups: {}, at: 1_000 }, s);
    s = tracker.hit(s, 1_000, 'orc', 'You', 40)!;
    s = { ...s, combat: { ...s.combat, attackers: ['orc'] } };
    return { tracker, records, s };
  };
  const arrives = (at: number, from: string) => ({
    type: 'mob-arrives-room' as const,
    text: `orc moves into the room from the ${from}.`,
    groups: { line: 'orc moves', direction: from },
    at
  });
  const nextRoom = (s: CharacterState): CharacterState => ({
    ...s,
    room: { ...s.room, name: 'Forest Entry', occupants: [mob('orc')] },
    combat: { ...s.combat, attackers: [], target: null }
  });

  it('keeps the damage of a monster that follows, and only when it walks in from the way back', () => {
    const { tracker, records, s } = fightingIn();
    tracker.walked(s, 'e');
    const there = nextRoom(s);
    tracker.heard(arrives(2_000, 'west'), there);
    const hit = tracker.hit(there, 2_100, 'orc', 'You', 10)!;
    expect(hit.combat.health?.remaining).toBeCloseTo(0.5, 5);
    // One fight across two rooms, and its record says the orc followed.
    tracker.status(hit, false, 3_000);
    tracker.heard({ type: 'status-line', text: '', groups: {}, at: 40_000 }, hit);
    expect(records.map((one) => [one.mob, one.mine, one.followed])).toEqual([['orc', 50, true]]);
  });

  it('lets go of a monster that did not follow, written down under the room it was fought in', () => {
    const { tracker, records, s } = fightingIn();
    tracker.walked(s, 'e');
    const there = nextRoom(s);
    // An orc wandering in from elsewhere is another orc.
    tracker.heard(arrives(2_000, 'north'), there);
    expect(tracker.hit(there, 2_100, 'orc', 'You', 10)?.combat.health?.remaining).toBeCloseTo(
      0.9,
      5
    );
    // When its window passes, the orc that never walked in is written down where it was fought.
    tracker.heard({ type: 'status-line', text: '', groups: {}, at: 40_000 }, there);
    expect(records.map((one) => [one.mob, one.roomName, one.mine])).toContainEqual([
      'orc',
      'Main Road',
      40
    ]);
  });

  it('writes down a monster killed before the step at once, as a kill in the room it died in', () => {
    const { tracker, records, s } = fightingIn();
    const dead = tracker.died(s, 1_500);
    tracker.walked(dead, 'e');
    expect(records.map((one) => [one.mob, one.roomName, one.killed])).toEqual([
      ['orc', 'Main Road', true]
    ]);
  });

  it('lets go of everything when the character was sneaking, or the realm says it never follows', () => {
    for (const [follows, stealth] of [
      [0, 'unknown'],
      [undefined, 'sneaking']
    ] as const) {
      const { tracker, s } = fightingIn(follows);
      tracker.walked({ ...s, stealth }, 'e');
      const there = nextRoom(s);
      tracker.heard(arrives(2_000, 'west'), there);
      expect(tracker.hit(there, 2_100, 'orc', 'You', 10)?.combat.health?.remaining).toBeCloseTo(
        0.9,
        5
      );
    }
  });
});

describe('a step that is no step', () => {
  it('leaves the fight alone when a look or a refused move lands in the same room', () => {
    // `toldOfSteps` asks `leftRoom` first; the fight itself never sees the redisplay.
    expect(leftRoom(EMPTY_CHARACTER.room, { ...EMPTY_CHARACTER.room })).toBe(false);
    expect(leftRoom(EMPTY_CHARACTER.room, { ...EMPTY_CHARACTER.room, name: 'Forest Entry' })).toBe(
      true
    );
  });
});

describe('an engagement', () => {
  it('binds the attack command to the occupant the server would resolve it to', () => {
    const { tracker, s } = fight([mob('small giant rat')]);
    tracker.noteAttack('giant rat', 'aa giant rat', 900);
    const engaged = tracker.status(s, true, 1_000);
    expect(engaged.inCombat).toBe(true);
    // The base name binds, as the server's name-modifier system does.
    expect(engaged.combat.target).toBe('small giant rat');
  });

  it('binds nothing with no attack owed, and keeps a target it already has', () => {
    const { tracker, s } = fight([mob('giant rat')]);
    expect(tracker.status(s, true, 1_000).combat.target).toBeNull();
    const fighting = tracker.missed(s, 1_000, 'giant rat')!;
    tracker.noteAttack('kobold', 'aa kobold', 1_900);
    expect(tracker.status(fighting, true, 2_000).combat.target).toBe('giant rat');
    // And that engagement answered the kobold's attack, so nothing is owed.
    expect(tracker.status(NO_TARGET(fighting), true, 2_010).combat.target).toBeNull();
  });

  /*
   * The server answers its commands in order, one `*Combat Engaged*` per
   * attack that found its mark (`AttackCommand.cs:405`), so each engagement
   * answers the oldest attack still owed one. Two attacks out before either was
   * answered, orohost 2026-08-26 (`2026-08-26_23-03-07_main.mudcap.jsonl`,
   * t=68194..68327): the first pair answered `pu small filthbug`.
   */
  it('answers attacks in the order they went out, one per engagement', () => {
    const { tracker, s } = fight([mob('large giant rat'), mob('small filthbug')]);
    tracker.noteAttack('small filthbug', 'aa small filthbug', 68_194);
    tracker.noteAttack('large giant rat', 'aa large giant rat', 68_205);
    const first = tracker.status(tracker.status(s, false, 68_311), true, 68_311);
    expect(first.combat.target).toBe('small filthbug');
    const second = tracker.status(tracker.status(first, false, 68_327), true, 68_327);
    expect(second.combat.target).toBe('large giant rat');
  });

  it('lets an attack nothing answered in time go, rather than bind a later engagement', () => {
    const { tracker, s } = fight([mob('giant rat'), mob('kobold thief')]);
    const bind = DEFAULT_INTERNAL.tuning.parse.engageBindMs;
    tracker.noteAttack('giant rat', 'aa giant rat', 1_000);
    expect(tracker.status(s, true, 1_000 + bind + 1).combat.target).toBeNull();
    // An attack exactly at the edge is still owed.
    tracker.noteAttack('kobold thief', 'aa kobold thief', 5_000);
    expect(tracker.status(s, true, 5_000 + bind).combat.target).toBe('kobold thief');
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
    const written = () => records.map((r) => [r.mob, r.killed, r.opened, r.mine, r.others]);
    // The kill at once; a monster still standing waits for an engagement that may take it back.
    expect(written()).toEqual([['giant rat', true, true, 9, 0]]);
    const bind = DEFAULT_INTERNAL.tuning.parse.engageBindMs;
    tracker.heard({ type: 'status-line', text: '', groups: {}, at: 3_001 + bind }, over);
    expect(written()).toEqual([
      ['giant rat', true, true, 9, 0],
      // Still standing when the fight ended, and not this character's fight.
      ['kobold thief', false, false, 0, 4]
    ]);
    // Written once: the ledgers are gone with the fight.
    tracker.status(over, false, 4_000 + bind);
    tracker.heard({ type: 'status-line', text: '', groups: {}, at: 5_001 + 2 * bind }, over);
    expect(records).toHaveLength(2);
  });

  it('keeps a monster’s damage across a cast that prints Combat Off and Combat Engaged', () => {
    const { tracker, records, s } = fight([mob('giant rat')]);
    const room = { ...s.room, map: 1, number: 100 };
    let next = tracker.hit({ ...s, room }, 1_000, 'giant rat', 'You', 40)!;
    const off = tracker.status(next, false, 2_000);
    tracker.noteAttack('giant rat', 'aa giant rat', 2_100);
    next = tracker.status(off, true, 2_200);
    expect(next.combat.health?.damage.mine).toBe(40);
    next = tracker.hit(next, 3_000, 'giant rat', 'You', 10)!;
    expect(next.combat.health?.damage.mine).toBe(50);
    // One fight, written down when it really ends.
    tracker.status(next, false, 4_000);
    expect(records).toEqual([]);
    tracker.heard({ type: 'status-line', text: '', groups: {}, at: 60_000 }, next);
    expect(records.map((r) => [r.mob, r.mine])).toEqual([['giant rat', 50]]);
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
    tracker.noteAttack('cave bear', 'aa cave bear', 0);
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

/*
 * A spell cast mid-fight is answered `*Combat Off*` then `*Combat Engaged*`
 * (GreaterMUD wire, `dfir` and `msto`; todo 843), and the monsters hitting the
 * character did not stop for it.
 */
describe('a Combat Off and Combat Engaged pair', () => {
  const inRoom = (s: CharacterState, map: number, number: number): CharacterState => ({
    ...s,
    room: { ...s.room, map, number }
  });
  const crowd = () => {
    const { tracker, s } = fight([mob('sea giant'), mob('sea giant warrior')]);
    let next = tracker.blowOnMe(inRoom(s, 1, 100), 1_000, 'sea giant');
    next = tracker.blowOnMe(next, 1_100, 'sea giant warrior');
    return { tracker, s: next };
  };

  it('keeps the attackers across a cast mid-fight and drops the target', () => {
    const { tracker, s } = crowd();
    const off = tracker.status(s, false, 2_000);
    expect(off.combat.attackers).toEqual([]);
    const engaged = tracker.status(off, true, 2_050);
    expect(engaged.combat.attackers).toEqual(['sea giant warrior', 'sea giant']);
    expect(engaged.combat.target).toBeNull();
  });

  it('does not bring back a monster the kill took out of the room', () => {
    const { tracker, s } = fight([mob('giant rat'), mob('kobold thief')]);
    let next = tracker.hit(inRoom(s, 1, 100), 1_000, 'giant rat', 'You', 9)!;
    next = tracker.blowOnMe(next, 1_100, 'giant rat');
    next = tracker.died(next, 2_000);
    const off = tracker.status(next, false, 2_100);
    tracker.noteAttack('kobold thief', 'aa kobold thief', 2_200);
    const engaged = tracker.status(off, true, 2_300);
    expect(engaged.combat.attackers).toEqual([]);
    expect(engaged.combat.target).toBe('kobold thief');
  });

  it('does not carry the attackers into another room or past the bind window', () => {
    const moved = crowd();
    const off = moved.tracker.status(moved.s, false, 2_000);
    expect(moved.tracker.status(inRoom(off, 1, 101), true, 2_050).combat.attackers).toEqual([]);

    const late = crowd();
    const bind = DEFAULT_INTERNAL.tuning.parse.engageBindMs;
    const lateOff = late.tracker.status(late.s, false, 2_000);
    expect(late.tracker.status(lateOff, true, 2_001 + bind).combat.attackers).toEqual([]);
  });

  it('gives the attackers back once, and never after forget', () => {
    const once = crowd();
    const off = once.tracker.status(once.s, false, 2_000);
    once.tracker.status(off, true, 2_050);
    expect(once.tracker.status(off, true, 2_100).combat.attackers).toEqual([]);

    const forgot = crowd();
    const forgotOff = forgot.tracker.status(forgot.s, false, 2_000);
    forgot.tracker.forget();
    expect(forgot.tracker.status(forgotOff, true, 2_050).combat.attackers).toEqual([]);
  });
});
