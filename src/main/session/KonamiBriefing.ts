/**
 * Gathering the planner's brief from what the session already computes: the
 * survey, each spot's monsters as the realm states them, the better gear per
 * slot and where it is sold, the attacks the class holds, and the spellbook
 * read against the realm's spell rows (todos 51–53). The brief itself is
 * `buildBrief`, pure; this is the join.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { CLASS_STEALTH_ABILITY, holdsAbility, type Capabilities } from '../../shared/abilities';
import { attackOptions } from '../../shared/attackOptions';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import type { MobEntity } from '../../shared/entities';
import type { HuntingAdvice } from '../../shared/hunting';
import { buildBrief, type BookSpell, type KonamiBrief } from '../../shared/konamiBrief';
import { castsOnSelf, spellServes, spellTargeting } from '../../shared/spellcraft';
import { prowessSheetOf, wieldedWeapon } from '../../shared/verdict';
import { roomId, type RoomId, type WorldSpell } from '../../shared/world';
import { gearUpgrades } from '../world/gearUpgrades';
import { wearerOf } from '../world/wearer';
import type { Traveller, WorldGraph } from '../world/WorldGraph';
import type { RealmClass } from './Errands';

/** What of the realm the brief reads. */
export type BriefingWorld = Pick<
  WorldGraph,
  | 'size'
  | 'byId'
  | 'lairEntities'
  | 'residentEntities'
  | 'itemsWornIn'
  | 'stockingPlaces'
  | 'spellNamed'
  | 'classNamed'
  | 'raceId'
  | 'namedClasses'
  | 'namedRaces'
>;

/** What the brief is gathered from. */
export interface BriefingParts {
  world: BriefingWorld | undefined;
  config(): AutomationConfig;
  survey(): HuntingAdvice;
  realmClass(): RealmClass;
  capabilities(): Capabilities;
  traveller(state: CharacterState): Traveller;
  priceAt(name: string, shop: RoomId): number | null;
}

/** `Abil` ids that make a lasting spell something other than a blessing. */
const HARMS = new Set([1, 8]);

/** A spell the book holds, read against the realm's row: a heal, a blessing, or neither. */
function bookSpell(
  known: { name: string; short: string | null; cost: number | null },
  realm: WorldSpell | null
): BookSpell {
  const targeting = spellTargeting(realm?.targets);
  const onSelf = realm !== null && castsOnSelf(targeting);
  const heals = onSelf && spellServes(realm.abilities).hp;
  const harms = realm?.abilities?.some(([id]) => HARMS.has(id)) ?? false;
  return {
    name: known.name,
    word: known.short ?? known.name,
    cost: known.cost ?? realm?.mana ?? null,
    heals,
    blessing: onSelf && !heals && !harms && (realm?.duration ?? 0) > 0
  };
}

/** The settings in force, as the brief states them. */
function settingsOf(config: AutomationConfig): KonamiBrief['settings'] {
  return {
    attack: config.combat.attack,
    opener: config.combat.opener,
    sneak: config.movement.sneak,
    heal: config.spells.autoChooseHeal ? 'auto' : config.spells.heal,
    blessings: config.spells.blessings.map((row) => row.spell),
    restBelow: config.health.restBelow,
    trainFirst: null
  };
}

export function konamiBrief(
  parts: BriefingParts,
  state: CharacterState,
  now: number
): KonamiBrief | { refusal: string } {
  const world = parts.world;
  if (world === undefined || world.size === 0) return { refusal: t('automation.konami.noWorld') };
  const { map, number } = state.room;
  if (map === null || number === null) return { refusal: t('automation.konami.unplaced') };
  const here = roomId(map, number);
  const config = parts.config();
  const advice = parts.survey();

  const entities = new Map<string, readonly MobEntity[]>();
  for (const spot of advice.spots) {
    const room = spot.rooms[0] === undefined ? undefined : world.byId(spot.rooms[0].id);
    if (room === undefined) continue;
    entities.set(
      spot.key,
      spot.key.startsWith('lair:') ? world.lairEntities(room) : world.residentEntities(room)
    );
  }

  const { combat, magery, family } = parts.realmClass();
  const sheet = prowessSheetOf(state, { combat, magery });
  const traveller = parts.traveller(state);
  const gear = gearUpgrades(
    state,
    {
      itemsWornIn: (worn) => world.itemsWornIn(worn),
      stockingPlaces: (items) => world.stockingPlaces(items, here, null, traveller),
      priceAt: (name, at) => parts.priceAt(name, at)
    },
    { wearer: wearerOf(state, world), sheet, family, attack: config.combat.attack },
    tuning().konami.upgradesPerSlot
  );

  const capabilities = parts.capabilities();
  const weapon = wieldedWeapon(state.inventory.items);
  const canHide = holdsAbility(capabilities, CLASS_STEALTH_ABILITY);
  return buildBrief({
    state,
    advice,
    entities,
    gear,
    attacks: attackOptions(sheet, weapon, capabilities.abilities, family),
    // A backstab needs a weapon in hand and a class that can hide.
    openers: canHide === true && weapon !== null ? ['bs'] : [],
    canSneak: canHide,
    spells:
      state.spellbook === null
        ? null
        : state.spellbook.map((known) => bookSpell(known, world.spellNamed(known.name))),
    settings: settingsOf(config),
    maxSpots: tuning().konami.maxSpots,
    now
  });
}
