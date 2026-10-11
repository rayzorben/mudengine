import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../dice';
import { copiesOf, deathSummons, drawSummons, picksOf, summonedBy } from '../summons';
import type { MobProfile } from '../world';

/* Who a monster's own spells bring into its room (todo 24). */
describe('a summons', () => {
  it('brings one of the rows a pick names, each by its chance', () => {
    const random = mulberry32(1);
    const counts = new Map<number, number>();
    for (let n = 0; n < 300; n += 1) {
      const rows = drawSummons(random, [
        [
          [10, 0.5],
          [11, 0.5]
        ]
      ]);
      expect(rows).toHaveLength(1);
      counts.set(rows[0]!, (counts.get(rows[0]!) ?? 0) + 1);
    }
    expect(counts.get(10)).toBeGreaterThan(100);
    expect(counts.get(11)).toBeGreaterThan(100);
  });

  /* Coordinator review, 2026-10-10: two Summon abilities are two modifiers, each its own row (Spell.cs:1506). */
  it('brings each row of a spell with two Summon abilities once, never one of them twice', () => {
    const random = mulberry32(2);
    for (let n = 0; n < 50; n += 1) {
      expect(drawSummons(random, [[[480, 1]], [[481, 1]]])).toEqual([480, 481]);
    }
  });

  it('rolls nothing for none', () => {
    let rolled = 0;
    expect(drawSummons(() => (rolled += 1), [])).toEqual([]);
    expect(rolled).toBe(0);
  });

  it('turns an average into picks: a whole copy each, the fraction one more', () => {
    expect(picksOf([[480, 2.5]])).toEqual([[[480, 1]], [[480, 1]], [[480, 0.5]]]);
    expect(copiesOf(picksOf([[480, 2.5]]))).toEqual(new Map([[480, 2.5]]));
  });

  it('reads every fight spell a monster casts: between rounds, as a blow, on a hit and dying', () => {
    const profile: MobProfile = {
      attacks: [
        { kind: 'spell', chance: 0.2, spell: 2, castChance: 1, level: 1, energy: 500 },
        { kind: 'melee', chance: 0.8, accuracy: 30, min: 1, max: 4, energy: 500, onHit: 3 }
      ],
      casts: [{ spell: 1, chance: 0.1, level: 4 }]
    };
    const one = (row: number): { summons: Array<Array<[number, number]>> } => ({
      summons: [[[row, 1]]]
    });
    const spells = { 1: one(101), 2: one(102), 3: one(103), 4: one(104) };
    expect([...summonedBy({ profiles: [profile], deathSpell: 4, spells })].sort()).toEqual([
      101, 102, 103, 104
    ]);
    expect(summonedBy({ profiles: [profile] }).size).toBe(0);
  });

  it('reads what a death spell brings, and nothing without one or for an unknown spell', () => {
    const divides = { summons: [[[306, 1]], [[306, 1]]] as Array<Array<[number, number]>> };
    expect(deathSummons({ deathSpell: 383, spells: { 383: divides } })).toHaveLength(2);
    expect(deathSummons({ deathSpell: 383 })).toEqual([]);
    expect(deathSummons({ spells: { 383: divides } })).toEqual([]);
  });
});
