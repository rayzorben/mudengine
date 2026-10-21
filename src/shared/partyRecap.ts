/**
 * What a fight two or more of the party were in came to, member by member
 * (todo 20261020-1654-01): read off the finished `FightRecord` and nothing
 * else, so the recap and the fight log can never tell the same fight two ways.
 * Main words it into notices (`session/partyRecap.ts`).
 */
import { NO_STRIKES, type FightRecord, type Strikes } from './fights';

/** One member's part in the fight. */
export interface RecapRow extends Strikes {
  /** As the server spells it. */
  name: string;
  damage: number;
  /** Of every blow on the monster, the party's and anybody else's, 0 to 1. */
  share: number;
  killingBlow: boolean;
}

export interface PartyRecap {
  mob: string;
  killed: boolean;
  ms: number | null;
  /** Every blow on the monster, the party's and anybody else's. */
  total: number;
  /** Most damage first. */
  rows: RecapRow[];
  /** Damage from players outside the party and from blows the sentence named nobody for. */
  outside: number;
}

/**
 * The recap, or null for a fight fewer than two of the party struck: a fight
 * one member was in is the Stats card's, not a recap's.
 */
export function partyRecap(record: FightRecord): PartyRecap | null {
  const self = record.name?.toLowerCase() ?? null;
  const party = [...(record.party ?? []), ...(record.name === null ? [] : [record.name])];
  const total = record.mine + record.others;
  if (total <= 0) return null;
  const rows = party
    .map((name) => {
      const key = name.toLowerCase();
      const damage = key === self ? record.mine : (record.struckBy?.[key] ?? 0);
      return {
        ...(record.strikes?.[key] ?? NO_STRIKES),
        name,
        damage,
        share: damage / total,
        killingBlow: record.killingBlow === key
      };
    })
    .filter((row) => row.hits + row.misses > 0 || row.damage > 0)
    .sort((a, b) => b.damage - a.damage);
  if (rows.length < 2) return null;
  const inParty = rows.reduce((sum, row) => sum + row.damage, 0);
  return {
    mob: record.mob,
    killed: record.killed,
    ms: record.ms,
    total,
    rows,
    outside: total - inParty
  };
}
