/**
 * What each realm's wire has said a spell has no effect on (`NoEffectLore`):
 * per realm, by the monster's row name, the spells and when each was first
 * said. `RealmLore` composes it, reads and writes it in its file as
 * `noEffects`, and hands each session its realm's half. See
 * `mudengine-world` › `parts/lore.md` › *A spell the server said has no effect
 * on a monster is the realm's*.
 */
import { spellKey } from '../../shared/spell-messages';
import { mobKey } from '../../shared/world';

/** One monster's spells, by name, and when each was first said to have no effect on it. */
export type NoEffectRow = Readonly<Record<string, number>>;

export class NoEffectBook {
  private readonly realms = new Map<string, Map<string, NoEffectRow>>();

  /** `changed` schedules the file's write. */
  constructor(private readonly changed: () => void) {}

  has(realm: string, monster: string, spell: string): boolean {
    return this.realms.get(realm)?.get(mobKey(monster))?.[spellKey(spell)] !== undefined;
  }

  /** Written once: the first answer is the lesson, and one already held does not dirty the file. */
  observe(realm: string, monster: string, spell: string, at: number): void {
    const who = mobKey(monster);
    const name = spellKey(spell);
    if (who.length === 0 || name.length === 0 || this.has(realm, who, name)) return;
    let table = this.realms.get(realm);
    if (!table) {
      table = new Map();
      this.realms.set(realm, table);
    }
    table.set(who, { ...table.get(who), [name]: at });
    this.changed();
  }

  forget(realm: string, monster: string, spell: string): void {
    const who = mobKey(monster);
    const name = spellKey(spell);
    const table = this.realms.get(realm);
    const row = table?.get(who);
    if (table === undefined || row?.[name] === undefined) return;
    const rest = Object.fromEntries(Object.entries(row).filter(([kept]) => kept !== name));
    if (Object.keys(rest).length === 0) table.delete(who);
    else table.set(who, rest);
    this.changed();
  }

  /** The section as the file holds it, per realm: replaces what was held for each realm read. */
  load(tables: ReadonlyMap<string, Map<string, NoEffectRow>>): void {
    for (const [realm, table] of tables) this.realms.set(realm, table);
  }

  /** Every realm's monsters, for the file. */
  tables(): ReadonlyMap<string, ReadonlyMap<string, NoEffectRow>> {
    return this.realms;
  }
}

/** One monster's row as the file holds it, or null when it names no spell. */
export function readNoEffectRow(value: unknown): NoEffectRow | null {
  if (typeof value !== 'object' || value === null) return null;
  const row: Record<string, number> = {};
  for (const [spell, at] of Object.entries(value)) {
    const name = spellKey(spell);
    if (name.length > 0) row[name] = typeof at === 'number' && Number.isFinite(at) ? at : 0;
  }
  return Object.keys(row).length > 0 ? row : null;
}
