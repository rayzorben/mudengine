/**
 * What a place hits with, by element, and which carried armour resists it
 * (todo 69). Pure: the realm's lair and room spell in, slot → item out.
 *
 * `Spell.CheckResistance` takes a cold, fire, stone, lightning or water
 * cast's damage down by the target's resistance to that element, in percent,
 * for every damage spell whoever casts it: a monster's spell attack, its
 * between-round cast and a room's own spell (`ApplyRoomCastSpell`, every
 * `RoomSpellTickTime` = 6 s). Census: `todo/69-element-census.txt`.
 * See `mudengine-automation` › *The kit is a set of sets*.
 */
import { HAZARD_ABILITY } from './abilities';
import { ROUND_SECONDS, spellSlots, woundOf } from './menace';
import { RESIST_ABILITY, type SpellElement } from './spellDamage';
import type { MobProfile, WorldSpell } from './world';

/** The elements a resistance takes damage off; normal and poison have none to wear. */
export type ResistElement = Exclude<SpellElement, 'normal' | 'poison'>;

export const RESIST_ELEMENTS = Object.keys(RESIST_ABILITY) as readonly ResistElement[];

/** Hit points a round the place deals in each element, where it deals any. */
export type Exposure = Partial<Record<ResistElement, number>>;

/**
 * `RoomSpellTickTime` (`TimedEvents/TimedEventManager.cs:24`), in seconds.
 * Every `TimedEvent` is shortened by the same `GameSpeed.Multiplier`, so its
 * ratio to `ROUND_SECONDS` holds at any realm speed.
 */
export const ROOM_SPELL_TICK_SECONDS = 6;

/** Damage the server takes a resistance off (`DamageNoMR`, `DamageWithMR`). */
function damages(spell: WorldSpell): boolean {
  return (spell.abilities ?? []).some(
    ([ability]) => ability === HAZARD_ABILITY.damage || ability === HAZARD_ABILITY.damageWithMr
  );
}

function resistible(spell: WorldSpell | null): spell is WorldSpell & { element: ResistElement } {
  return (
    spell !== null &&
    spell.element !== undefined &&
    spell.element in RESIST_ABILITY &&
    damages(spell)
  );
}

/**
 * One cast's mean damage, as `menace` prices it. Magic resistance is left
 * unread: the most a cast can do is the unsafe case.
 */
function meanWound(spell: WorldSpell, level: number): number {
  const wound = woundOf(spell, level, { magicRes: null });
  return wound === null ? 0 : (wound.low + wound.high) / 2;
}

function add(into: Exposure, element: ResistElement, hp: number): void {
  if (hp > 0) into[element] = (into[element] ?? 0) + hp;
}

/**
 * One monster row's elemental damage a round, through `spellSlots` as the
 * menace counts it. Every blow is taken to land: the character's defence is
 * not read here, and more damage is the unsafe case.
 */
function profileExposure(
  profile: MobProfile,
  spellById: (id: number) => WorldSpell | null
): Exposure {
  const out: Exposure = {};
  for (const slot of spellSlots(profile, () => 1)) {
    const spell = spellById(slot.spell);
    if (!resistible(spell)) continue;
    add(out, spell.element, slot.perRound * meanWound(spell, slot.level));
  }
  return out;
}

/**
 * What a room deals by element: its own spell, and the worst of each lair
 * monster's rows. The worst rather than an average, because a row the
 * client cannot tell apart from its namesakes is the unsafe case.
 */
export function exposureAt(
  roomSpell: WorldSpell | null,
  lair: ReadonlyArray<{ profiles?: readonly MobProfile[] }>,
  spellById: (id: number) => WorldSpell | null
): Exposure {
  const out: Exposure = {};
  if (resistible(roomSpell))
    add(
      out,
      roomSpell.element,
      (meanWound(roomSpell, 0) * ROUND_SECONDS) / ROOM_SPELL_TICK_SECONDS
    );
  for (const element of RESIST_ELEMENTS) {
    let worst = 0;
    for (const mob of lair) {
      for (const profile of mob.profiles ?? []) {
        worst = Math.max(worst, profileExposure(profile, spellById)[element] ?? 0);
      }
    }
    add(out, element, worst);
  }
  return out;
}

/** A piece of armour as the choice reads it. */
export interface PlaceItem {
  name: string;
  /** The kit's slot key (`kitFor`), lowercased. */
  slot: string;
  equipped: boolean;
  /** The realm's `[id, value]` pairs; absent is unknown, and an unknown item is never chosen. */
  abilities: ReadonlyArray<readonly [number, number]> | undefined;
  /**
   * `Items.ArmourClass` and `DamageResist`, or null where the realm states no
   * armour row for the item. Absent figures on an armour row are the realm's
   * zero (`Catalogue`), so this is `{ ac: 0, dr: 0 }` and not null for them.
   */
  armour: { ac: number; dr: number } | null;
}

/** Hit points a round an item saves at a place: each element's damage times its resistance. */
export function savedBy(item: Pick<PlaceItem, 'abilities'>, exposure: Exposure): number {
  let saved = 0;
  for (const element of RESIST_ELEMENTS) {
    const hp = exposure[element];
    if (hp === undefined) continue;
    const resist = (item.abilities ?? [])
      .filter(([ability]) => ability === RESIST_ABILITY[element])
      .reduce((sum, [, value]) => sum + value, 0);
    saved += (hp * Math.min(100, resist)) / 100;
  }
  return saved;
}

/** Whether a swap keeps both armour class and damage resistance; an unknown never does. */
function holdsUp(
  next: { ac: number; dr: number },
  worn: { ac: number; dr: number } | null
): boolean {
  return worn !== null && next.ac >= worn.ac && next.dr >= worn.dr;
}

/**
 * For each slot, the carried item that saves the most at this place over what
 * is worn there, by at least `minSaved` hit points a round, and gives up no
 * armour class or damage resistance. A slot whose worn item or candidate
 * states no armour row is left alone: trading known armour for an unknown is
 * the unsafe guess.
 */
export function placeChoice(
  exposure: Exposure,
  items: readonly PlaceItem[],
  minSaved: number
): Map<string, string> {
  const choice = new Map<string, string>();
  if (RESIST_ELEMENTS.every((element) => exposure[element] === undefined)) return choice;
  const worn = new Map(items.filter((item) => item.equipped).map((item) => [item.slot, item]));
  const best = new Map<string, { item: PlaceItem; saved: number }>();
  for (const item of items) {
    if (item.equipped || item.abilities === undefined || item.armour === null) continue;
    const saved = savedBy(item, exposure);
    if (saved <= 0) continue;
    const there = worn.get(item.slot);
    if (there !== undefined && !holdsUp(item.armour, there.armour)) continue;
    const gain = saved - (there === undefined ? 0 : savedBy(there, exposure));
    if (gain < minSaved) continue;
    const held = best.get(item.slot);
    if (held === undefined || saved > held.saved) best.set(item.slot, { item, saved });
  }
  for (const [slot, { item }] of best) choice.set(slot, item.name);
  return choice;
}
