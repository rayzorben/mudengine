/**
 * What each realm's rounds measured (`RoundLore`): per realm played, the
 * rounds counted for each attack spell and each attack at a stated figure,
 * and the casts or swings in them. `RealmLore` composes it, reads and writes
 * it in its file as `castRounds` and `swingRounds`, and hands each session
 * its realm's half. See `mudengine-automation` › parts/combat.md › *A round
 * is priced at what the realm does in one*.
 */
import {
  measuredFrom,
  type MeasuredRounds,
  type RoundKind,
  type RoundTally
} from '../../shared/rounds';
import { tuning } from '../app/tuning';

type Tables = Map<string, Map<string, RoundTally>>;

export class RoundsBook {
  private readonly tables: Record<RoundKind, Tables> = { casts: new Map(), swings: new Map() };
  /** Each realm's figures, worked out once per change rather than on every sheet. */
  private readonly figures = new Map<string, MeasuredRounds | null>();

  /** `changed` schedules the file's write. */
  constructor(private readonly changed: () => void) {}

  /** One round on `realm`: `count` casts of one spell, or swings at one stated figure. */
  observe(realm: string, kind: RoundKind, key: string, count: number): void {
    if (key.length === 0 || !Number.isFinite(count) || count < 0) return;
    const table = this.table(kind, realm);
    const held = table.get(key) ?? { rounds: 0, count: 0 };
    table.set(key, { rounds: held.rounds + 1, count: held.count + count });
    this.figures.delete(realm);
    this.changed();
  }

  /** The realm's figures past `tuning.hunting.measuredRoundsMin` rounds; null where none is. */
  measured(realm: string): MeasuredRounds | null {
    const kept = this.figures.get(realm);
    if (kept !== undefined) return kept;
    const figure = measuredFrom(
      { casts: this.table('casts', realm), swings: this.table('swings', realm) },
      tuning().hunting.measuredRoundsMin
    );
    this.figures.set(realm, figure);
    return figure;
  }

  /** One kind's section as the file holds it, per realm: replaces what was held for each realm read. */
  load(kind: RoundKind, tables: ReadonlyMap<string, Map<string, RoundTally>>): void {
    for (const [realm, table] of tables) {
      this.tables[kind].set(realm, table);
      this.figures.delete(realm);
    }
  }

  /** One kind's realms, for the file. */
  section(kind: RoundKind): ReadonlyMap<string, ReadonlyMap<string, RoundTally>> {
    return this.tables[kind];
  }

  private table(kind: RoundKind, realm: string): Map<string, RoundTally> {
    let table = this.tables[kind].get(realm);
    if (!table) {
      table = new Map();
      this.tables[kind].set(realm, table);
    }
    return table;
  }
}

/** One tally as the file holds it, or null when it is not one. */
export function readRoundTally(value: unknown): RoundTally | null {
  if (typeof value !== 'object' || value === null) return null;
  const { rounds, count } = value as Record<string, unknown>;
  if (typeof rounds !== 'number' || typeof count !== 'number') return null;
  if (!Number.isInteger(rounds) || rounds <= 0 || !Number.isFinite(count) || count < 0) return null;
  return { rounds, count };
}
