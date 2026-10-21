import { describe, expect, it } from 'vitest';

import type { FightRecord } from '../fights';
import { partyRecap } from '../partyRecap';

const fight = (over: Partial<FightRecord>): FightRecord =>
  ({
    at: 1,
    ms: 12_000,
    mob: 'thrag',
    killed: true,
    mine: 30,
    others: 70,
    blows: 9,
    opened: true,
    name: 'Faramir',
    ...over
  }) as FightRecord;

const STRUCK: Partial<FightRecord> = {
  party: ['Glorfindel'],
  struckBy: { glorfindel: 60, cobra: 10 },
  strikes: {
    faramir: { hits: 2, crits: 1, backstabs: 1, misses: 1, most: 22 },
    glorfindel: { hits: 9, crits: 0, backstabs: 0, misses: 0, most: 19 },
    cobra: { hits: 1, crits: 0, backstabs: 0, misses: 0, most: 10 }
  },
  killingBlow: 'glorfindel'
};

describe('the party recap', () => {
  it('gives each member who struck a row, most damage first', () => {
    const recap = partyRecap(fight(STRUCK));
    expect(recap?.rows.map((row) => [row.name, row.damage, row.killingBlow])).toEqual([
      ['Glorfindel', 60, true],
      ['Faramir', 30, false]
    ]);
    expect(recap?.rows[1]).toMatchObject({ hits: 2, crits: 1, backstabs: 1, misses: 1, most: 22 });
    expect(recap?.rows[0]?.share).toBeCloseTo(0.6);
  });

  it('counts a player outside the party apart from the rows', () => {
    expect(partyRecap(fight(STRUCK))?.outside).toBe(10);
  });

  it('gives nothing for a fight one member struck', () => {
    // Positive control above: the same fight with the party struck has a recap.
    const alone = { struckBy: { cobra: 70 }, strikes: { faramir: STRUCK.strikes!['faramir']! } };
    expect(partyRecap(fight({ ...STRUCK, ...alone }))).toBe(null);
    expect(partyRecap(fight({ ...STRUCK, party: undefined }))).toBe(null);
  });
});
