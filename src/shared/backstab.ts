/**
 * The backstab weapon, derived from the pack (todo 76): MegaMUD's `BsWeapon`
 * without the player typing one. Pure over the carried items and who the
 * character is; `EquipmentManager` lays the answer as the backstab set when
 * the player has written none. See `mudengine-automation` › *The kit is a set
 * of sets*.
 */
import { BACKSTAB_ABILITY, carriesAbility } from './abilities';
import type { CarriedItem } from './character';
import { baseSet, equipBlock, restrictionsOf, WEAPON_KEY, type GearSet, type Wearer } from './gear';
import { sameItem } from './items';
import { abilitySum } from './light';

/**
 * Whether the server lets this weapon backstab, GreaterMUD's `Item.CanBackstab`
 * (`Items.cs:122`): `WeaponType` 2, or any backstab row, a negative one
 * included (64 of Paradigm's 299 backstab weapons backstab only through a
 * negative accuracy row, `todo/76-backstab-weapons-census.txt`). Null where
 * the kind is unknown.
 */
export function weaponBackstabs(item: {
  weapon?: { kind?: number };
  abilities?: ReadonlyArray<readonly [number, number]>;
}): boolean | null {
  if (Object.values(BACKSTAB_ABILITY).some((id) => carriesAbility(item.abilities, id))) return true;
  return item.weapon?.kind === undefined ? null : item.weapon.kind === 2;
}

const total = (item: CarriedItem, id: number): number => abilitySum(item.abilities ?? [], id);

/**
 * The weapon's own part of a backstab's mean damage. `Player.CalcBSDamage`
 * (`Player.cs:5497`) takes `2 × (weapon min + MinDamage) + BSMinDmg` for the
 * low end and the same with max for the high, scaled by level, stealth and
 * the class's stealth row alike for every weapon; so the mean moves with
 * `min + max` and half the weapon's two backstab damage rows. Null for a
 * weapon the realm states no range for.
 */
export function backstabWorth(item: CarriedItem): number | null {
  if (item.weapon === undefined) return null;
  const rows = total(item, BACKSTAB_ABILITY.minDamage) + total(item, BACKSTAB_ABILITY.maxDamage);
  return item.weapon.min + item.weapon.max + rows / 2;
}

/**
 * The carried weapon with the best backstab, or null: one the server lets
 * backstab (`weaponBackstabs`, unknown kind left out), the character may wield
 * (`equipBlock`, unknown never refusing), and not `refused` this session.
 *
 * Damage first, then the weapon's backstab accuracy row, then the pack's
 * order. Accuracy second because a monster's backstab defence is its armour
 * over 40 plus `BSDefense` (`BackstabCombatRound.GetDefense`), small against
 * the backstab's own accuracy, and `BSDefense` is not in the world data, so a
 * trade of damage for accuracy cannot be priced.
 */
export function backstabWeapon(
  items: readonly CarriedItem[],
  wearer: Wearer,
  refused: (name: string) => boolean
): CarriedItem | null {
  let best: { item: CarriedItem; worth: number; accuracy: number } | null = null;
  for (const item of items) {
    if (item.kind !== 'weapon' || weaponBackstabs(item) !== true) continue;
    if (equipBlock(restrictionsOf(item), wearer) !== null || refused(item.name)) continue;
    const worth = backstabWorth(item);
    if (worth === null) continue;
    const accuracy = total(item, BACKSTAB_ABILITY.accuracy);
    if (best === null || worth > best.worth || (worth === best.worth && accuracy > best.accuracy)) {
      best = { item, worth, accuracy };
    }
  }
  return best?.item ?? null;
}

/**
 * `backstabWeapon` where the player wrote no backstab set, else null: a
 * written set is the player's choice and stands.
 */
export function derivedBackstabWeapon(
  sets: readonly GearSet[],
  items: readonly CarriedItem[],
  wearer: Wearer,
  refused: (name: string) => boolean
): CarriedItem | null {
  if (sets.some((set) => set.when === 'backstab')) return null;
  return backstabWeapon(items, wearer, refused);
}

/** An empty hand's range, as `BackstabCombatRound.Min` and `Max` read it. */
const FISTS = { min: 1, max: 5 };

/**
 * One backstab's mean damage before the monster's defences, with `weapon` in
 * hand (null for an empty hand): `Player.CalcBSDamage` (`Player.cs:5497`) for
 * a class with the stealth row, the only class a backstab is chosen for. The
 * backstab rows are the weapon's and the rest of what is worn
 * (`Player.BSMinDmg`). The character's own damage rows are left out, as a
 * plain round's price leaves them out. Null while the level or Stealth is
 * unread, or for a weapon with no stated range.
 */
export function backstabBlow(
  figures: { level: number | null; stealth: number | null },
  weapon: CarriedItem | null,
  items: readonly CarriedItem[]
): number | null {
  const { level, stealth } = figures;
  if (level === null || stealth === null) return null;
  const range = weapon === null ? FISTS : weapon.weapon;
  if (range === undefined) return null;
  const worn = items.filter(
    (item) => item.equipped && (item.slot ?? '').toLowerCase() !== WEAPON_KEY
  );
  const rows = (id: number): number =>
    [...worn, ...(weapon === null ? [] : [weapon])].reduce((sum, item) => sum + total(item, id), 0);
  const blow = (damage: number, row: number): number =>
    ((level + 100) * (2 * level + Math.floor(stealth / 10) + 2 * damage + row)) / 100;
  return (
    (blow(range.min, rows(BACKSTAB_ABILITY.minDamage)) +
      blow(range.max, rows(BACKSTAB_ABILITY.maxDamage))) /
    2
  );
}

/**
 * The sets with the derived backstab weapon laid in, where the player wrote no
 * backstab set (a written one is the player's choice and stands).
 *
 * The swap back is the base kit: `hands`, what was in the weapon hand and the
 * off-hand before the backstab weapon went on, are added to the `always` set
 * for each slot it does not already name, so the fighting round and the walk
 * after it put them back the way any set is put back. A two-handed backstab
 * weapon takes the off-hand off through `swapPlan`, and the shield comes back
 * the same way.
 */
export function withBackstabWeapon(
  sets: readonly GearSet[],
  weapon: { set: string; item: string } | null,
  hands: readonly string[],
  slotOf: (name: string) => string | null
): readonly GearSet[] {
  if (weapon === null || sets.some((set) => set.when === 'backstab')) return sets;
  const base = baseSet(sets);
  const named = new Set((base?.wear ?? []).map((item) => slotOf(item)?.toLowerCase()));
  const back = hands.filter((item) => {
    const slot = slotOf(item)?.toLowerCase();
    return slot === undefined || !named.has(slot);
  });
  const kit: GearSet = {
    name: base?.name ?? '',
    when: 'always',
    mob: '',
    wear: [...(base?.wear ?? []), ...back]
  };
  const backstab: GearSet = { name: weapon.set, when: 'backstab', mob: '', wear: [weapon.item] };
  return [kit, ...sets.filter((set) => set !== base), backstab];
}

/** Whether `name` is one of the weapons a backstab was dressed for. */
export function chosenForBackstab(chosen: ReadonlySet<string>, name: string): boolean {
  for (const each of chosen) if (sameItem(each, name)) return true;
  return false;
}
