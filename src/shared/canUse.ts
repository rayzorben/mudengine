/**
 * Whether this character may use a thing lying on the floor: the server's
 * `ItemType.CanPlayerUseItem`, which its shop list prints as `(You can't use)`
 * and `(Too powerful)`, read for any item rather than only for kit
 * (`equipVerdict` answers `none` for a flask that names classes). Usable is
 * claimed only when every restriction the item has was checked against a
 * known figure; anything else is unknown. Todo 146.
 */
import type { ItemEntity } from './entities';
import {
  alignmentGated,
  blockReason,
  classesAllowed,
  equipBlock,
  isMagical,
  maxLevelOf,
  restrictionsOf,
  type EquipRestrictions,
  type Wearer
} from './gear';
import type { UiLookup } from './i18n';

export interface UseVerdict {
  state: 'usable' | 'blocked' | 'unknown';
  /** Why not, or why it is not known; blank where it is usable. */
  label: string;
}

/** Whether a restriction the item carries meets a figure of the character's still unread. */
function unread(item: EquipRestrictions, wearer: Wearer): boolean {
  const abilities = item.abilities ?? [];
  const levelGated = item.minLevel !== undefined || maxLevelOf(abilities) !== null;
  return (
    (classesAllowed(item).length > 0 && wearer.classId === null) ||
    ((item.races ?? []).length > 0 && wearer.raceId === null) ||
    (levelGated && wearer.level === null) ||
    (alignmentGated(abilities) && wearer.alignment === null) ||
    (isMagical(abilities) && wearer.antiMagic === null) ||
    (item.kind === 'armour' && item.armour?.kind !== undefined && wearer.armourType === null) ||
    (item.kind === 'weapon' && item.weapon?.kind !== undefined && wearer.weaponType === null)
  );
}

/**
 * The answer for one thing lying on the floor, read by the console's rewrite
 * and the Room card. The card's open floor can be settled to the row the room
 * places (`itemPlacedHere`) and so answer where the console's `?` could not:
 * the listing is drawn before `Obvious exits:` places the room.
 *
 * A name several rows share carries each row's rules in `variants` where they
 * differ. Where one row is usable and another not, the answer is unknown and
 * says so: the floor listing names the kind, never the row.
 */
export function canUse(item: ItemEntity, wearer: Wearer, t: UiLookup): UseVerdict {
  if (item.id === undefined) return { state: 'unknown', label: t('rewrites.floor.notInRealm') };
  const candidates = (item.variants ?? [item]).map(restrictionsOf);
  const blocks = candidates.map((row) => equipBlock(row, wearer));
  const first = blocks.find((block) => block !== null) ?? null;
  if (first !== null && blocks.some((block) => block === null)) {
    return { state: 'unknown', label: t('rewrites.floor.sharedName') };
  }
  if (first !== null) {
    return { state: 'blocked', label: blockReason(first, wearer.classNames, wearer.raceNames, t) };
  }
  if (candidates.some((row) => unread(row, wearer))) {
    return { state: 'unknown', label: t('rewrites.floor.unreadCharacter') };
  }
  return { state: 'usable', label: '' };
}
