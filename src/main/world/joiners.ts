/**
 * The monsters a fight draws in, from the realm's own data: every row the
 * foes' spells summon (a call for aid, a death spell, a blow's spell), every
 * row a monster's `CreateSpell` brings with it as it comes into the room
 * (cast as a lair fills, RegenSlot.cs:47, and on a summons, Room.cs:328), and
 * what those bring in turn. The fight odds run them (`FightSetup`); a run past
 * a room asks the same.
 * See mudengine-automation › *A fight counts the monsters it draws in*.
 */
import type { MobEntity } from '../../shared/entities';
import { copiesOf, NO_SUMMONS, picksOf, summonedBy, type Summons } from '../../shared/summons';
import type { WorldSupply } from './supply';

/** What the realm answers about a row: the row weighed as itself, and its runs. */
export interface JoinerRealm {
  rowEntity(id: number): MobEntity | undefined;
  supply(): Pick<WorldSupply, 'runs'>;
}

/** A monster as far as who it brings goes: its fight spells, and the rows it is. */
export type Bringer = Parameters<typeof summonedBy>[0] & Pick<MobEntity, 'row' | 'ids'>;

/** A monster a fight may draw in: its row, which a summons names, and the row weighed. */
export interface Joiner {
  row: number;
  entity: MobEntity;
}

export class Joiners {
  /** Monster row → what its arrival brings, from the `arrive` runs; built on the first ask. */
  private arriving: Map<number, Summons> | null = null;
  private readonly entities = new Map<number, MobEntity | null>();

  constructor(private readonly realm: JoinerRealm) {}

  /**
   * What this monster's arrival brings: its own row's, or for a name not
   * resolved to one, every row it may be (the dangerous end).
   */
  arrivalsOf(mob: Pick<MobEntity, 'row' | 'ids'>): Summons {
    const rows = mob.row !== undefined ? [mob.row.id] : (mob.ids ?? []);
    const index = this.arrivals();
    const found = rows.flatMap((row) => index.get(row) ?? NO_SUMMONS);
    return found.length === 0 ? NO_SUMMONS : found;
  }

  /**
   * Every monster `foes` may draw into their fight, each row once: what their
   * spells summon, what their arrivals bring where they come into the room
   * with the fight (`arriving`: a lair's draw, never a room already seen),
   * and what each of those brings in turn. A row the realm lacks is left
   * out: `TrySummon` finds no monster type and brings nobody.
   */
  drawnIn(foes: readonly Bringer[], arriving: boolean): Joiner[] {
    const joined = new Map<number, MobEntity>();
    const queue: number[] = [];
    const reach = (mob: Bringer, arrives: boolean): void => {
      queue.push(...summonedBy(mob));
      if (arrives) queue.push(...copiesOf(this.arrivalsOf(mob)).keys());
    };
    for (const foe of foes) reach(foe, arriving);
    while (queue.length > 0) {
      const row = queue.shift()!;
      if (joined.has(row)) continue;
      const entity = this.entityOf(row);
      if (entity === undefined) continue;
      joined.set(row, entity);
      // A summoned monster comes into the room, so its own arrival runs too.
      reach(entity, true);
    }
    return [...joined].map(([row, entity]) => ({ row, entity }));
  }

  private entityOf(row: number): MobEntity | undefined {
    if (!this.entities.has(row)) this.entities.set(row, this.realm.rowEntity(row) ?? null);
    return this.entities.get(row) ?? undefined;
  }

  private arrivals(): Map<number, Summons> {
    if (this.arriving !== null) return this.arriving;
    const index = new Map<number, Summons>();
    for (const { by, monsters } of this.realm.supply().runs) {
      if (by.kind !== 'arrive' || monsters.size === 0) continue;
      index.set(by.monster, [...(index.get(by.monster) ?? []), ...picksOf(monsters)]);
    }
    this.arriving = index;
    return index;
  }
}
