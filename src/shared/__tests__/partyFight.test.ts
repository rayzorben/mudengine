import { describe, expect, it } from 'vitest';

import type { PartyMember } from '../character';
import type { SpotMob } from '../hunting';
import {
  partyFighters,
  partyKey,
  partyPlan,
  retargetChance,
  survivalParty,
  withParty
} from '../partyFight';

/* Todo 152: the hunting grounds priced with every member of the party fighting. */

function member(name: string, hpMax: number | null): PartyMember {
  return {
    name,
    className: null,
    health: 1,
    mana: null,
    rank: null,
    activity: null,
    invited: false,
    vitals: hpMax === null ? null : { hp: hpMax, hpMax, mana: null, manaMax: null },
    sheet: null
  };
}

const ORC: SpotMob = {
  name: 'orc',
  experience: 300,
  copper: null,
  rounds: 10,
  perRound: 12,
  nakedPerRound: 20,
  afflictions: [],
  regenSeconds: null
};

describe('who fights beside the character', () => {
  it('leaves out a member whose health no client has said', () => {
    const fighters = partyFighters([member('Soul', 300), member('Rand', null)], (name) =>
      name === 'Soul' ? 25 : null
    );
    expect(fighters).toEqual([{ name: 'Soul', hpMax: 300, perRound: 25 }]);
    // Nobody in the fight: the lairs are this character's own, and the card says the party was left out.
    expect(partyPlan([member('Rand', null)], () => 25, null, 0.1)).toMatchObject({
      odds: null,
      said: { fighters: 0, leftOut: 1, damage: 0 }
    });
    expect(partyPlan([], () => 25, null, 0.1)).toBeNull();
    // What the card says was left out: one out of the fight, one in it with no measured damage.
    const plan = partyPlan(
      [member('Soul', 300), member('Rand', null), member('Kai', 200)],
      (name) => (name === 'Soul' ? 25 : null),
      null,
      0.1
    );
    expect(plan?.said).toMatchObject({ fighters: 2, leftOut: 1, unmeasured: 1, damage: 25 });
  });
});

describe('whom a monster swings at', () => {
  /* Mob.TryFindTarget: rand(1, 100) + (Charm − 50) / 10 > 50, an integer division. */
  it('looks again half the time, more often away from a charming target', () => {
    expect(retargetChance(50)).toBe(0.5);
    expect(retargetChance(59)).toBe(0.5);
    expect(retargetChance(80)).toBe(0.53);
    expect(retargetChance(20)).toBe(0.47);
  });

  it('reads an unknown Charm the way that sends the most blows to this character', () => {
    const fighters = [{ name: 'Soul', hpMax: 300, perRound: null }];
    // Its own as 0, a monster on it staying longest; a member's looked away from every round.
    expect(survivalParty(fighters, null)).toMatchObject({ retarget: 0.45, retargetMember: 1 });
    expect(survivalParty(fighters, 80).retarget).toBe(0.53);
  });
});

describe('a spawn fought beside the party', () => {
  it('dies to everyone’s damage, its blows still whole on this character', () => {
    // 100 health over 10 rounds is 10 a round; with 15 more from the party, 4 rounds.
    const fought = withParty(ORC, 100, { damage: 15 });
    expect(fought.rounds).toBeCloseTo(4);
    expect(fought.perRound).toBe(12);
    expect(fought.nakedPerRound).toBe(20);
  });

  it('keeps the rounds where the health is unknown, or nobody beside deals anything', () => {
    expect(withParty(ORC, null, { damage: 15 }).rounds).toBe(10);
    expect(withParty(ORC, 100, { damage: 0 }).rounds).toBe(10);
  });
});

describe('the key the party’s fights are kept under', () => {
  const key = (perRound: number | null): string =>
    partyKey([{ name: 'Soul', hpMax: 300, perRound }], 0.1);

  it('holds through a small move of a member’s damage and moves past the step', () => {
    expect(key(30)).toBe(key(30.5));
    expect(key(30)).not.toBe(key(40));
    expect(key(null)).not.toBe(key(30));
    expect(partyKey([{ name: 'Soul', hpMax: 400, perRound: 30 }], 0.1)).not.toBe(key(30));
  });
});
