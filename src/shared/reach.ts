/**
 * Whether a weapon can hurt a monster, before the attack is sent (todo 46).
 *
 * The server's test is `Player.CanPlayerHitTarget` (`Player.cs:5511`, read
 * from `AttackCommand.cs:210`): the monster's highest `Magical` against the
 * larger of the weapon's `Magical` and the attacker's `HitMagic` (class, race,
 * worn items, spells: `Player.GetAbility`), then, where the monster carries
 * `ReqToHit`, a weapon whose `MeetsReqToHit` names one of the same values.
 * A refusal prints `Your weapon has no effect against this monster!` and opens
 * no fight. Pure: the caller hands in the rows. See `mudengine-automation`.
 */
import { REACH_ABILITY } from './abilities';

type Pairs = ReadonlyArray<readonly [number, number]>;

/** What the weapon in hand does to a monster, and what to do about it. */
export type WeaponReach =
  | { kind: 'hurts' }
  /** The realm cannot say: a row unread, rows that disagree, a spell unnamed. Never refuses. */
  | { kind: 'unknown' }
  /** The hand cannot; this carried weapon can, and is the best that can. */
  | { kind: 'swap'; weapon: string }
  /** Nothing carried can. */
  | { kind: 'cannot' };

export const REACH_UNKNOWN: WeaponReach = { kind: 'unknown' };

/** Every value a list states for one ability. */
function valuesOf(abilities: Pairs, id: number): number[] {
  return abilities.filter(([which]) => which === id).map(([, value]) => value);
}

/**
 * The monster's side. A name the realm folds from several rows keeps every
 * distinct value it states (`indexMobs`), and a row with no `Magical` states
 * none, so an unresolved name of several rows starts at 0: the realm then
 * says only `hurts`, and the server's line settles the rest. A row the room
 * resolved, or a name of one row, states its own.
 */
export interface ReachTarget {
  low: number;
  high: number;
  /** `ReqToHit` values, empty where it has none. */
  required: readonly number[];
}

export function reachTarget(abilities: Pairs | undefined, oneRow: boolean): ReachTarget | null {
  if (abilities === undefined) return null;
  const tiers = valuesOf(abilities, REACH_ABILITY.magical);
  return {
    low: tiers.length === 0 || !oneRow ? 0 : Math.min(...tiers),
    high: tiers.length === 0 ? 0 : Math.max(...tiers),
    required: valuesOf(abilities, REACH_ABILITY.reqToHit)
  };
}

/**
 * The attacker's `HitMagic`, the highest of every source, or null where a
 * source could not be read (an unknown class row, a buff the realm cannot
 * name). Zero where every source was read and none grants it.
 */
export function hitMagicOf(sources: ReadonlyArray<Pairs | null>): number | null {
  let best = 0;
  for (const source of sources) {
    if (source === null) return null;
    for (const value of valuesOf(source, REACH_ABILITY.hitMagic)) best = Math.max(best, value);
  }
  return best;
}

/**
 * One weapon against one monster: yes, no, or the rows disagree. `null` is the
 * bare hand. `hitMagic` leaves the weapon hand out: a weapon's own `HitMagic`
 * is worn only while it is held, so it counts for that weapon alone.
 */
export function weaponHurts(
  target: ReachTarget,
  weapon: Pairs | null,
  hitMagic: number
): boolean | null {
  const own =
    weapon === null
      ? 0
      : Math.max(
          0,
          ...valuesOf(weapon, REACH_ABILITY.magical),
          ...valuesOf(weapon, REACH_ABILITY.hitMagic)
        );
  const reach = Math.max(own, hitMagic);
  const meets =
    target.required.length === 0 ||
    (weapon !== null &&
      valuesOf(weapon, REACH_ABILITY.meetsReqToHit).some((value) =>
        target.required.includes(value)
      ));
  if (!meets) return false;
  if (reach >= target.high) return true;
  return reach < target.low ? false : null;
}

/** A carried weapon as the reach reads it. */
export interface ReachWeapon {
  name: string;
  abilities: Pairs | undefined;
  equipped: boolean;
}

/**
 * The hand against the monster and, where it cannot, the best carried weapon
 * that can. `rank` is the gear planner's worth for holding a weapon against
 * this monster (`gearReads.attacks` on `wearing`), null where it cannot say;
 * an unranked weapon comes after every ranked one, in pack order.
 * `handRefused`: the server already said this hand has no effect, which
 * outranks the rows (`NoEffect`).
 */
export function weaponReach(
  target: ReachTarget | null,
  hand: ReachWeapon | null,
  carried: readonly ReachWeapon[],
  hitMagic: number | null,
  rank: (weapon: string) => number | null,
  handRefused = false
): WeaponReach {
  if (target === null || hitMagic === null) return REACH_UNKNOWN;
  if (!handRefused) {
    if (hand !== null && hand.abilities === undefined) return REACH_UNKNOWN;
    const held = weaponHurts(target, hand?.abilities ?? null, hitMagic);
    if (held !== false) return held === true ? { kind: 'hurts' } : REACH_UNKNOWN;
  }
  let unread = false;
  const able: Array<{ name: string; worth: number | null }> = [];
  for (const weapon of carried) {
    if (weapon.equipped) continue;
    if (weapon.abilities === undefined) {
      unread = true;
      continue;
    }
    if (weaponHurts(target, weapon.abilities, hitMagic) === true) {
      able.push({ name: weapon.name, worth: rank(weapon.name) });
    }
  }
  const best = able.reduce<(typeof able)[number] | null>(
    (top, next) =>
      top === null || (next.worth !== null && (top.worth === null || next.worth > top.worth))
        ? next
        : top,
    null
  );
  if (best !== null) return { kind: 'swap', weapon: best.name };
  return unread ? REACH_UNKNOWN : { kind: 'cannot' };
}
