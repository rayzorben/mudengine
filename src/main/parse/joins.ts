/**
 * The realm's rows joined onto a committed state: what the character sees
 * by, which rows the pack holds, what its race's attributes run between, and
 * the row of what it is fighting.
 *
 * Out of `CharacterTracker` (todo 724; `mudengine-wire` › `parts/tracker.md`).
 * `state in → state out`, each handed the one realm lookup it asks, and each
 * called from `apply`'s commit point, gated there on the fields it reads: a
 * line in each case that can move them is that many chances to forget one.
 */
import type { CharacterState } from '../../shared/character';
import {
  abilitySum,
  carriedLights,
  NIGHT_VISION_ABILITY,
  ROOM_LIGHT_ABILITY,
  sameSight,
  sightOf,
  wornVision
} from '../../shared/light';
import { mobKey, roomAddress } from '../../shared/world';
import type { WorldGraph } from '../world/WorldGraph';

/**
 * What the character sees by, recomputed where the pack or the race moved.
 *
 * The race's night vision comes off the realm's race table and the rest off
 * the pack's own entities, so it is recomputed where the loadout is, from the
 * same commit point. Nothing before the first listing: a sight worked out from an
 * empty pack and an unnamed race would say the character sees in the dark
 * by nothing, which is a number `AutoLight` would act on.
 */
export function withSight(
  s: CharacterState,
  world: Pick<WorldGraph, 'raceAbilities'> | undefined
): CharacterState {
  const race = s.race === null ? null : (world?.raceAbilities(s.race) ?? null);
  if (race === null && s.inventory.items.length === 0) {
    return s.sight === null ? s : { ...s, sight: null };
  }
  const vision =
    (race === null
      ? 0
      : abilitySum(race, NIGHT_VISION_ABILITY) + abilitySum(race, ROOM_LIGHT_ABILITY)) +
    wornVision(s.inventory.items);
  const sight = sightOf(vision, carriedLights(s.inventory.items), race !== null);
  return sameSight(s.sight, sight) ? s : { ...s, sight };
}

/**
 * The realm's rows for what is in the pack. See `Inventory.rows`.
 *
 * The join is `itemIdsCarried`'s, which is the rule that refuses a shared
 * name — so this states rows the pack can only be holding, and says nothing
 * about the rest. A realm with no data joins nothing, which reads exactly as
 * a pack of things the realm has never heard of.
 *
 * The equality check is what keeps the state stable: `replayPack` rebuilds
 * the array on every listing and a fresh `rows` beside an unchanged pack
 * would be a new state pushed to every window for nothing.
 */
export function withPackRows(
  s: CharacterState,
  world: Pick<WorldGraph, 'itemIdsCarried'> | undefined
): CharacterState {
  const rows =
    world === undefined
      ? []
      : world.itemIdsCarried([...s.inventory.items, ...s.inventory.keys.map((name) => ({ name }))]);
  const held = s.inventory.rows;
  if (rows.length === held.length && rows.every((id, at) => id === held[at])) return s;
  return { ...s, inventory: { ...s.inventory, rows } };
}

/**
 * What the realm says this race's attributes run between.
 *
 * Its own join rather than a field of `sightOf`'s: sight moves with the pack
 * as well as the race and this moves with nothing but the race, so folding
 * them would re-read the race table on every listing.
 */
export function withSpans(
  s: CharacterState,
  world: Pick<WorldGraph, 'raceSpans'> | undefined
): CharacterState {
  const spans = s.race === null ? null : (world?.raceSpans(s.race) ?? null);
  if (spans === null && s.attributeSpans === null) return s;
  return { ...s, attributeSpans: spans };
}

/**
 * The realm's whole row for what this character is swinging at.
 *
 * Null for a player, for a monster the realm cannot place, and when there is
 * no target — all three of which are ordinary, and none of which is an
 * error. A player is deliberately not built into a `MobEntity` here: the
 * classification that tells a person from a monster lives on the room's
 * occupants, and inventing a monster row for somebody would be the
 * reassuring guess this client refuses everywhere else.
 */
export function withTargetEntity(
  s: CharacterState,
  world: Pick<WorldGraph, 'buildMobEntity'> | undefined
): CharacterState {
  const name = s.combat.target;
  if (name === null || world === undefined) {
    return s.combat.targetEntity === null
      ? s
      : { ...s, combat: { ...s.combat, targetEntity: null } };
  }
  // A person is not a monster. The room's own classification is the
  // authority on which this is, and it has already been made.
  const occupant = s.room.occupants.find((there) => mobKey(there.name) === mobKey(name));
  if (occupant?.kind === 'player') {
    return { ...s, combat: { ...s.combat, targetEntity: null } };
  }
  const built = world.buildMobEntity(name, {
    charmed: occupant?.charmed === true,
    at: roomAddress(s.room)
  });
  // A wire-only entity carries nothing the name did not already say, so it
  // is not worth publishing — `null` is the honest answer for a monster the
  // realm cannot place, and the card already says so.
  const entity = built.source === 'wire' ? null : built;
  return { ...s, combat: { ...s.combat, targetEntity: entity } };
}
