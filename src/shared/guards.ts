/**
 * Which monster moves to protect which: `Monsters.Abil-n = 146`, `MonsGuards`.
 *
 * The ability sits on the **ward** and names its guards by row
 * (`Mob.GetGuardedByMobTypes`). Attacking the ward while a guard stands turns
 * the guard on the attacker and hands it the blow, so the ward cannot be hit
 * until its guards are dead. See `mudengine-automation` › *Which of several
 * to hit*, and its `decisions.md` for the source and the captures.
 */
import type { MobEntity } from './entities';
import { mobKey } from './world';

/** `GMUDAbilityType.MonsGuards`. */
export const GUARDED_BY_ABILITY = 146;

/** What the reading needs of a monster: the ward's list, the guard's rows. */
export type GuardSubject = Pick<MobEntity, 'abilities' | 'ids' | 'row'>;

/** A monster in a room, by the name a command names it by. */
export interface Guardable {
  name: string;
  mob?: GuardSubject | undefined;
}

/**
 * Whether the realm lists `guard` as moving to protect `ward`.
 *
 * Three-state because a name holds several rows and the list names rows:
 * `dwarven guard` is rows 395 and 396, and only 396 protects `champion
 * gudruk`. False when no row the guard could be is listed; true when every one
 * is and the ward is one row; else null. The ward's list is every row of its
 * name together (`WorldMob.abilities` is the fold, and the file keeps no
 * per-row abilities), and a ward's rows can disagree — `champion gudruk` 429
 * lists 396, its row 465 lists nobody — so a ward of several rows is a maybe.
 *
 * Two of one name are never each other's guard here: the server redirects
 * between them, and naming either names both.
 */
export function protects(guard: Guardable, ward: Guardable): boolean | null {
  if (mobKey(guard.name) === mobKey(ward.name)) return false;
  const listed = new Set(
    (ward.mob?.abilities ?? []).flatMap(([id, row]) => (id === GUARDED_BY_ABILITY ? [row] : []))
  );
  if (listed.size === 0) return false;
  const rows = guard.mob?.row !== undefined ? [guard.mob.row.id] : [...(guard.mob?.ids ?? [])];
  const named = rows.filter((row) => listed.has(row)).length;
  if (named === 0) return false;
  return named === rows.length && (ward.mob?.ids?.length ?? 1) <= 1 ? true : null;
}

/**
 * `ranked` again, each monster's guards taken before it: the first still
 * standing is replaced by its best-ranked guard, and that by its own, until
 * one nothing here protects. Otherwise the order is the ranking's.
 *
 * A maybe counts: moving a guard ahead of its ward among monsters already
 * being fought costs nothing. A cycle cannot be ordered (`duergar captain` and
 * `duergar warrior` protect each other; four spheres protect one another in a
 * ring), so a chain that closes on itself stops at the cycle's best-ranked
 * member and the server fights whichever guard of it stands.
 */
export function guardsFirst(ranked: readonly number[], room: readonly Guardable[]): number[] {
  const guarded = room.map((ward) => room.map((guard) => protects(guard, ward) !== false));
  const left = [...ranked];
  const order: number[] = [];
  while (left.length > 0) {
    const chain = [left[0]!];
    let pick: number | undefined;
    while (pick === undefined) {
      const ward = chain[chain.length - 1]!;
      const guard = left.find((other) => guarded[ward]?.[other] === true);
      if (guard === undefined) pick = ward;
      else if (chain.includes(guard)) {
        const cycle = chain.slice(chain.indexOf(guard));
        pick = left.find((index) => cycle.includes(index))!;
      } else chain.push(guard);
    }
    order.push(pick);
    left.splice(left.indexOf(pick), 1);
  }
  return order;
}

/**
 * The room's members that end up in the fight: those that `fights`, and every
 * `bystander` certain to protect one of them, and a guard's own guards after
 * it. In room order.
 *
 * Only a certain guard is brought in. A name only some of whose rows protect
 * is left for the server to decide, rather than opening on a monster that may
 * have left the character alone.
 */
export function inTheFight<T extends Guardable>(
  room: readonly T[],
  fights: (who: T) => boolean,
  bystander: (who: T) => boolean
): T[] {
  const inIt = new Set(room.filter(fights));
  for (let grew = true; grew;) {
    grew = false;
    for (const who of room) {
      if (inIt.has(who) || !bystander(who)) continue;
      if ([...inIt].some((ward) => protects(who, ward) === true)) {
        inIt.add(who);
        grew = true;
      }
    }
  }
  return room.filter((who) => inIt.has(who));
}
