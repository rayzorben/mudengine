/**
 * Gathering the planner's brief from what the session already computes: the
 * survey, each spot's monsters as the realm states them, the better gear per
 * slot and where it is sold, the attacks the class holds, and the spellbook
 * read against the realm's spell rows (todos 51–53), the walk to each spot
 * offered with the lairs it passes, the simulator's run of each spot's fight,
 * and what each armour piece would change there. The brief itself is
 * `buildBrief`, pure; this is the join.
 */
import { t } from '../app/i18n';
import { avoided, type FledEntry } from '../../shared/fled';
import { tuning } from '../app/tuning';
import { CLASS_STEALTH_ABILITY, holdsAbility, type Capabilities } from '../../shared/abilities';
import { attackOptions } from '../../shared/attackOptions';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import type { MobEntity } from '../../shared/entities';
import type { HuntingAdvice, HuntingSpot } from '../../shared/hunting';
import {
  buildBrief,
  offeredSpots,
  unsafeWhy,
  type BookSpell,
  type BriefFight,
  type BriefLairPassed,
  type BriefRoute,
  type GearEffect,
  type KonamiBrief,
  type LeftOutReason,
  type SlotUpgrade
} from '../../shared/konamiBrief';
import type { KonamiLesson } from '../../shared/konamiLessons';
import { REALM_ARMOUR_SCALE, weighRoom, type MenacePlayer } from '../../shared/menace';
import { fightable } from '../../shared/mobs';
import type { Odds } from '../../shared/survival';
import { castsOnSelf, spellServes, spellTargeting } from '../../shared/spellcraft';
import { prowessSheetOf, wieldedWeapon } from '../../shared/verdict';
import {
  lairsAlong,
  roomId,
  type RoomId,
  type RouteStep,
  type WorldRoom,
  type WorldSpell
} from '../../shared/world';
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
  | 'route'
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
  /** The simulator's run of a lair's fight (`OddsBook.lair`). */
  lairOdds(room: WorldRoom): Odds;
  /** What a monster's blows are measured against (`Errands.menacePlayer`). */
  menacePlayer(state: CharacterState): MenacePlayer;
  /** The monsters this character ran from (`Belongings.recallFled`). */
  fled(): readonly FledEntry[];
  /** What the cheapest trainer that takes this level charges, or null where none does. */
  trainCost(): number | null;
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

/** A spot's first room, where the walk ends and its monsters are read from. */
function firstRoom(world: BriefingWorld, spot: HuntingSpot): WorldRoom | undefined {
  return spot.rooms[0] === undefined ? undefined : world.byId(spot.rooms[0].id);
}

/** The simulator's run of a lair spot's fight; null for a placed monster or one not run. */
function simulated(parts: BriefingParts, room: WorldRoom | undefined): BriefFight | null {
  if (room?.lair === undefined) return null;
  const odds = parts.lairOdds(room);
  if (odds.kind !== 'run') return null;
  const { level, survives, hpLeft, rounds } = odds.survival;
  return { level, survives, hpLeft, rounds: rounds.value };
}

/** A lair passed, as the walk summary reads it: its monsters and its simulated fight. */
export type LairReader = (room: RoomId) => Pick<BriefLairPassed, 'monsters' | 'fight'>;

/**
 * A walk condensed: its length, the lairs it passes, what a pass through all
 * of them costs, and the worst `named` with their monsters and the
 * simulator's run of their fight. A lair nobody could weigh makes the cost
 * unknown rather than leaving it out of the sum.
 */
export function walkSummary(
  steps: readonly RouteStep[],
  lairAt: LairReader,
  named: number
): BriefRoute {
  const along = lairsAlong(steps);
  let damage = 0;
  let unweighed = 0;
  const passed: BriefLairPassed[] = [];
  for (const step of steps) {
    if (step.lairDamage !== undefined) damage += step.lairDamage;
    if (step.lairUnweighed === true) unweighed += 1;
    if (step.danger === undefined) continue;
    passed.push({ room: step.name, share: step.danger, ...lairAt(step.to) });
  }
  passed.sort((a, b) => b.share - a.share);
  return {
    steps: steps.length,
    lairs: along.count + unweighed,
    damage: unweighed > 0 ? null : damage,
    unweighed,
    deadly: along.deadly?.name ?? null,
    worst: passed.slice(0, named)
  };
}

/** The walk from here to a spot, condensed; null where no route could be planned. */
function walkTo(
  parts: BriefingParts,
  world: BriefingWorld,
  here: RoomId,
  room: WorldRoom | undefined,
  state: CharacterState
): BriefRoute | null {
  if (room === undefined) return null;
  const route = world.route(here, roomId(room.map, room.room), parts.traveller(state));
  if (route.blocked) return null;
  return walkSummary(
    route.steps,
    (id) => {
      const lair = world.byId(id);
      const odds = lair === undefined ? null : parts.lairOdds(lair);
      return {
        monsters: lair === undefined ? [] : world.lairEntities(lair).map((mob) => mob.name),
        fight: odds?.kind === 'run' ? odds.survival.level : null
      };
    },
    tuning().konami.lairsNamed
  );
}

/** A spot's monsters as the realm states them, the ones auto-combat would fight. */
function spotEntities(world: BriefingWorld, spot: HuntingSpot): MobEntity[] {
  const room = firstRoom(world, spot);
  if (room === undefined) return [];
  return fightable(
    spot.key.startsWith('lair:') ? world.lairEntities(room) : world.residentEntities(room)
  );
}

/** One of each monster: the damage a round they do to `player`; null where any is unknown. */
function perRoundAt(entities: readonly MobEntity[], player: MenacePlayer): number | null {
  const weighed = weighRoom(entities, player, tuning().menace);
  if (weighed.length === 0 || weighed.some((each) => each === null)) return null;
  return weighed.reduce((sum, each) => sum + (each?.perRound ?? 0), 0);
}

/**
 * A sheet figure with one item swapped in for what is worn in its slot, the
 * realm's figures scaled to the sheet's; null where any of the three is
 * unknown (an empty slot is a known zero).
 */
function swapped(sheet: number | null, offer: number | null, worn: number | null): number | null {
  if (sheet === null || offer === null || worn === null) return null;
  return sheet + (offer - worn) / REALM_ARMOUR_SCALE;
}

/**
 * Each armour piece weighed at the best spot offered: the sheet's armour
 * class and damage resistance with it on in place of what is worn there, and
 * the damage a round one of each monster there does, now and with it.
 */
function withEffects(
  gear: SlotUpgrade[],
  best: { key: string; entities: readonly MobEntity[] } | undefined,
  player: MenacePlayer
): SlotUpgrade[] {
  if (best === undefined || best.entities.length === 0) return gear;
  const now = perRoundAt(best.entities, player);
  return gear.map((slot) => {
    if (slot.ranking !== 'armour') return slot;
    // What is worn there: nothing is a known zero, an item with no figure is not.
    const wornAc = slot.worn === null ? 0 : slot.wornFigure;
    return {
      ...slot,
      offers: slot.offers.map((offer) => {
        const ac = swapped(player.armourClass, offer.ac, wornAc);
        const dr = swapped(player.damageResist, offer.dr, slot.worn === null ? 0 : slot.wornDr);
        const effect: GearEffect = {
          spot: best.key,
          armourClass: { now: player.armourClass, with: ac },
          perRound: {
            now,
            with:
              ac === null || dr === null
                ? null
                : perRoundAt(best.entities, { ...player, armourClass: ac, damageResist: dr })
          }
        };
        return { ...offer, effect };
      })
    };
  });
}

export function konamiBrief(
  parts: BriefingParts,
  state: CharacterState,
  now: number,
  lessons: KonamiLesson[]
): KonamiBrief | { refusal: string } {
  const world = parts.world;
  if (world === undefined || world.size === 0) return { refusal: t('automation.konami.noWorld') };
  const { map, number } = state.room;
  if (map === null || number === null) return { refusal: t('automation.konami.unplaced') };
  const here = roomId(map, number);
  const config = parts.config();
  const advice = parts.survey();

  const entities = new Map<string, readonly MobEntity[]>();
  for (const spot of advice.spots) entities.set(spot.key, spotEntities(world, spot));

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

  const maxSpots = tuning().konami.maxSpots;
  // Each spot's walk and fight once: the offer, the gear's effect and the brief all read them.
  const walks = new Map<string, BriefRoute | null>();
  const fights = new Map<string, BriefFight | null>();
  const walk = (spot: HuntingSpot): BriefRoute | null => {
    if (!walks.has(spot.key))
      walks.set(spot.key, walkTo(parts, world, here, firstRoom(world, spot), state));
    return walks.get(spot.key) ?? null;
  };
  const fight = (spot: HuntingSpot): BriefFight | null => {
    if (!fights.has(spot.key)) fights.set(spot.key, simulated(parts, firstRoom(world, spot)));
    return fights.get(spot.key) ?? null;
  };
  const unsafe = (spot: HuntingSpot): LeftOutReason | null =>
    unsafeWhy(fight(spot), walk(spot), tuning().combat.openAbove);
  const best = offeredSpots(advice, maxSpots, unsafe).offered[0];
  const capabilities = parts.capabilities();
  const weapon = wieldedWeapon(state.inventory.items);
  const canHide = holdsAbility(capabilities, CLASS_STEALTH_ABILITY);
  return buildBrief({
    state,
    advice,
    entities,
    gear: withEffects(
      gear,
      best === undefined ? undefined : { key: best.key, entities: entities.get(best.key) ?? [] },
      parts.menacePlayer(state)
    ),
    attacks: attackOptions(sheet, weapon, capabilities.abilities, family),
    // A backstab needs a weapon in hand and a class that can hide.
    openers: canHide === true && weapon !== null ? ['bs'] : [],
    canSneak: canHide,
    spells:
      state.spellbook === null
        ? null
        : state.spellbook.map((known) => bookSpell(known, world.spellNamed(known.name))),
    settings: settingsOf(config),
    maxSpots,
    lessons,
    trainCost: parts.trainCost(),
    fled: parts.fled().filter(
      (entry) =>
        avoided([entry], entry.name, state.progress.level, {
          band: tuning().combat.fledLevels,
          forgetMs: tuning().combat.fledForgetMs,
          now
        }) !== null
    ),
    walk,
    simulated: fight,
    unsafe,
    now
  });
}
