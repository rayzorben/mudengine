/**
 * The room graph, and A* over it.
 *
 * Ported from `mudengine/src/engine/path.coffee`, which
 * docs/legacy-assessment.md calls the strongest single piece of logic in either
 * reference codebase: a real A* with per-edge *instructions* parsed out of the
 * exit string, so a door costs more than a corridor and a toll you cannot
 * afford prunes the edge entirely.
 *
 * Three changes from the original:
 *
 * - **The full instruction vocabulary.** The original knew seven kinds and
 *   treated the rest as free. `Text:` exits matter most: they are not traversed
 *   by walking a direction at all, so a route that emits `w` there does not
 *   work.
 * - **Loaded once, indexed.** The original issued synchronous SQLite queries
 *   from inside block parsing, per line, on the main thread.
 * - **A real priority queue.** The original re-sorted the entire open list on
 *   every iteration, which is O(n² log n) over 55,806 rooms.
 */
import fs from 'node:fs';
import { spellElementOf } from '../../shared/spellchoice';
import zlib from 'node:zlib';

import { t } from '../app/i18n';
import { describeObstacle } from './obstacle';
import { parseInstruction } from './instructions';
import type { BuiltExit } from './buildRealm';
import {
  earlierHandover,
  itemsBrought,
  packHolds,
  planAct,
  stepRoll,
  type PlanItem,
  type PlanPlace,
  type PlanSnag,
  type PlanStep
} from '../../shared/quests';
import type { Quest, QuestErrand, QuestSource, QuestStep } from '../../shared/quests';
import {
  type WorldLair,
  type AbilityGate,
  abilityGatesMet,
  readAbilityGate,
  asRoomReference,
  DIRECTIONS,
  DIRECTION_COMMAND,
  describeBlock,
  mobKey,
  roomId,
  type RouteBlock,
  type Direction,
  type Requirement,
  type ItemUseGate,
  type Route,
  type RouteStep,
  type RoomId,
  type WorldExit,
  type WorldItem,
  type WardRule,
  type LevelBand,
  type ItemHandover,
  type ApproachGate,
  type ApproachItem,
  type WorldLookup,
  type BankChoice,
  type CashPlace,
  type ShopPlace,
  type BuyingPlace,
  type Dropper,
  type DropSources,
  type MobPlaces,
  type MobSpawn,
  type ItemPlaces,
  type PlaceGroup,
  type RequirementAction,
  openableHere,
  parseLair,
  type WorldShop,
  type WorldShopItem,
  hazardAvoided,
  hazardFor,
  type RouteHazard,
  type RouteInvocation,
  type RouteScatter,
  type Landing,
  landingRooms,
  scatters,
  type SpellHazard,
  type WorldSpell,
  type WorldRace,
  type WorldClass,
  type WorldMob,
  type WorldMobRow,
  type MobRowChoice,
  type MobAttack,
  type MobCast,
  type MobProfile,
  type WorldNames,
  type RoomCommand,
  type Corridor,
  type RemoteLever,
  type WorldRoom,
  type ShopKind,
  shopKind
} from '../../shared/world';
import { trainersFor, type TrainerRow } from '../../shared/training';
import { spellServes } from '../../shared/spellcraft';
import { itemInvocation } from '../../shared/items';
import { alignmentRank, type Alignment } from '../../shared/alignment';
import {
  CONFUSE_MESSAGE_ABILITY,
  HAZARD_ABILITY,
  abilityName,
  abilityShape
} from '../../shared/abilities';
import { dispositionFromCode, mobNameCandidates } from '../../shared/mobs';
import {
  ARMOUR_TYPE,
  WEAPON_CLASS,
  WEAPON_TYPE,
  WORN_SLOT,
  bareName,
  itemKind
} from '../../shared/items';
import { tuning } from '../app/tuning';
import { counterPriceInCopper, currencyOfCode } from '../../shared/coins';
import { respawnSeconds } from '../../shared/hunting';
import { spellTargeting } from '../../shared/spellcraft';
import type { ExitEntity, ItemEntity, MobEntity, NpcEntity } from '../../shared/entities';
import {
  balanceOf,
  type AttributeSpans,
  type BankBalance,
  type RoomExit
} from '../../shared/character';
import type { SpellOption } from '../../shared/ipc';
import {
  asRealmFamily,
  familyOfBuild,
  readRealmBuild,
  type RealmBuild,
  type RealmFamily
} from '../../shared/realm';
import {
  asShippedWorld,
  readArchiveIdentity,
  type ArchiveIdentity,
  type ShippedWorld
} from '../../shared/worlds';
import { equipBlock, type Wearer } from '../../shared/gear';

/**
 * A room-script teleport the router may walk — `dive pool`, `go vortex`.
 *
 * Shaped like a `WorldExit` so the A* relaxes both through one loop, with the
 * one honest difference stated in the type: it has no compass direction,
 * because the realm moves the character by coordinates rather than through an
 * exit, and a fabricated direction would be resolved against an exit that
 * does not exist. The requirement carries the phrase in `commands` (so the
 * route step's command is the phrase, exactly as a `Text:` exit's is) and the
 * level gate when the script states one.
 */
export interface PortalExit {
  direction: 'portal';
  map: number;
  room: number;
  requirement: Requirement;
}

/** What the traveller can and cannot do, for edge evaluation. */
export interface Traveller {
  /**
   * Edges the live server refused this session, as `from|direction`.
   *
   * The realm data promised them and the wire said no — 1/615 s is the
   * measured case. Priced as a wall rather than pruned, the same shape as an
   * unbashable door: still walkable when there is no other way, never
   * preferred while there is. Session-scoped by the caller, deliberately —
   * the permanent record (`WorldMemory`) observes and never reaches the
   * pathfinder, and a server restart may open what this session saw shut.
   */
  refused?: ReadonlySet<string>;
  /**
   * Edges along the routes this character prefers, as `from|to` room ids,
   * both ways.
   *
   * A route saved from the loop builder (`Loop.prefer`) is the player saying
   * *this is the way*, and a step along one costs
   * `tuning.world.preferredStepCost` of an ordinary step — so the router
   * follows a saved route wherever it can and leaves it only for a way
   * shorter by more than the discount. Derived once per session from the
   * character's own loops (`SessionManager.preferredEdges`), and absent from
   * the builder's own drafts, which plan plainly so the way drawn is the way
   * the reduction reproduces.
   */
  preferred?: ReadonlySet<string>;
  level?: number | null;
  /** Copper farthings, for tolls. */
  wealth?: number | null;
  /**
   * The `Items` row ids the pack holds, for a keyed door and an item gate.
   *
   * One field because the two instructions ask one question — *is this thing
   * in the pack* — and the server answers both by walking
   * `Inventory.ItemStacks`. Filled by `SessionManager.travellerNow` from the
   * `i` listing, joined name-to-id through the realm's item index and **only
   * where the name resolves to exactly one row**: twenty of the shipped
   * realm's 1,915 item names are shared by two or more ids (four of them
   * keys — `iron key` is three), and a pack that guessed which one it was
   * holding would open a door on a coin toss.
   *
   * Absent, or a name the realm cannot place, is *nobody has said* — never
   * *not carried*.
   */
  keys?: number[];
  /**
   * Whether an `i` listing has ever landed, so `keys` above means *this is
   * what is carried* rather than *nobody has looked*.
   *
   * The two are one field's worth of difference and the whole of whether a
   * missing item may be treated as a wall: 157 of the shipped realm's exits
   * want a `rope and grapple`, and shutting all of them against a character
   * whose pack has never been listed is the class gate's failure in the
   * opposite direction. `CharacterState.inventory.listedAt` is the fact; `i`
   * is in the default entry probe, so it is true within a second of entering
   * the realm on any ordinary configuration.
   */
  packKnown?: boolean;
  /**
   * What `abil` said this character's ability sums are, for a scripted way
   * through gated on one.
   *
   * The counters are the only guard on a room script the client holds a
   * matching fact for, and they are stated outright — so a portal this
   * character fails is refused rather than discouraged (`edgePenalty`), and
   * one nobody has read a listing for is priced exactly as it was. Null or
   * absent is *nobody has said*: `AbilitySums` in everything but the import,
   * which stays out of `src/shared/world.ts` so the realm types keep no
   * dependency on the character's.
   */
  counters?: { sums: Readonly<Record<number, number>>; complete: boolean } | null;
  /**
   * The spells the server has stated up on this character with a countdown
   * still running (todo 105) — a room spell one of them stops is priced as a
   * plain step (`hazardAvoided`). Only a *stated* clock: a bless recorded
   * without one may have lapsed, and pricing on it is the guess the spell
   * half of `hazardAvoided` refused for a year. Absent is nobody has said.
   */
  spellsUp?: readonly number[];
  /** Picklocks, for a door the realm lets that skill open. */
  pickSkill?: number | null;
  /** Strength, for the same doors — the realm accepts either. */
  strength?: number | null;
  /**
   * This character's `Classes` row id, for a class-gated exit.
   *
   * The stat sheet prints the realm's own word (`Class: Paladin`) and the
   * exit states a row id, so the join is `WorldGraph.classId` and it happens
   * once, at `SessionManager.travellerNow`. Null or absent means nobody has
   * read a sheet yet, or the realm names no classes — and an unevaluable gate
   * is discouraged rather than pruned, which is what `edgePenalty` did for
   * every one of them until this existed.
   */
  classId?: number | null;
  /**
   * This character's `Races` row id, for a race-gated exit.
   *
   * The join `classId` describes, one column across: the sheet prints
   * `Race: Kang` and the exit states a row id, so `WorldGraph.raceId` makes
   * it once at `SessionManager.travellerNow`. Two exits in the shipped realm
   * carry one, which is a small number and exactly the reason it went
   * unevaluated — the cost of an unevaluable gate is not paid where the gates
   * are, it is paid where the character is standing when one of them is on
   * the only short way through.
   */
  raceId?: number | null;
  /**
   * How the realm ranks this character, for an alignment-gated exit.
   *
   * The one fact on this object that does **not** come off the stat sheet:
   * the sheet does not carry a standing and the `who` roster's own row for
   * the character is the only place it appears (`ownAlignment`), so it is
   * null for the first few seconds of every session — which is the ordinary
   * state and must never close a route.
   */
  alignment?: Alignment | null;
  /**
   * What one pass through a room's lair is expected to take from this
   * character, as a share of the health it has *now* — the worst monster
   * that attacks on sight, as many as the lair holds at once, for the rounds
   * spent inside (`lairPassage`). Null where nothing can be weighed: no lair,
   * the sheet unread, a monster the arithmetic cannot price.
   *
   * A pass, not a fight: the room appraisal's cost is what *clearing* the
   * room takes (`menace.perRound × rounds` per monster), and priced by that
   * every lair a level-11 character walks past on the way to the Black
   * Mountains is a wall — the route goes round through three maps and a
   * keyed door to save five of them. Walking through costs one round of
   * whatever is awake and hostile; that is what the router asks.
   *
   * A function rather than a table, because the answer depends on the
   * character as they stand and the router only ever asks about the rooms it
   * expands; the session memoises the damage until the character's own
   * figures move (`LairCosts`) and divides by current health at the call.
   * `dangerPenalty` turns the share into route cost.
   */
  danger?: (room: WorldRoom) => number | null;
  /**
   * The same pass in hit points — `danger` before the division. Carried onto
   * the step (`RouteStep.lairDamage`) for the walker's rest before a trap,
   * which needs a reserve in points rather than a share of a bar that was
   * read when the route was planned.
   */
  lairDamage?: (room: WorldRoom) => number | null;
  /**
   * What one pass through a room's **own spell** is expected to take from this
   * character, as a share of the health it has now.
   *
   * The other half of what a room costs, and the half nothing read until todo
   * 01. `Rooms.Spell` is a real spell row for 13,016 of the shipped realm's
   * rooms, 845 of them the Silver River — whose spell stops if you are
   * carrying a boat and otherwise bashes you against the rocks for 10–20. So
   * the price depends on the pack as well as on the bar, which is why this is
   * a function of the session like `danger` rather than a number on a room.
   *
   * Null where nothing can be weighed: no spell, a spell that harms nobody,
   * an unread sheet, or an item in the pack that stops it — the last of which
   * is not *unknown* but *free*, and both price at nothing.
   */
  hazard?: (room: WorldRoom) => number | null;
  /**
   * Rooms this search may not enter at all.
   *
   * Not a price — the one place in this router where an edge is *pruned* on
   * the traveller's account rather than made expensive. It exists for one
   * question: **is there another way that does not go through these?**
   * `route()` asks it once, with the rooms that priced the best route badly,
   * so *there is no other way* stops being an assertion off a single search
   * and becomes something the client actually looked for.
   *
   * Never set by a caller planning a walk. A route the reader chooses from
   * `Route.otherWay` is a route already planned; nothing re-plans through this.
   */
  avoid?: ReadonlySet<RoomId>;
  /**
   * Edges pruned on the same account, keyed `room|direction` like {@link
   * refused}. A door this traveller cannot force is an obstacle on one edge,
   * and pruning the room beyond it would shut every other way in as well —
   * the way round the Massive Doors still ends in the room behind them.
   */
  avoidEdges?: ReadonlySet<string>;
  /**
   * Edges of the plan a *different* way is being asked for, as `from|to`
   * room ids — priced `tuning.world.anotherWayPenalty` times over rather than
   * pruned (`Route.another`). Pruning them would refuse every way that shares
   * a bridge with the plan; pricing them lets the search reuse the plan
   * exactly where leaving it costs more than it saves. Never set by a caller
   * planning a walk.
   */
  penalised?: ReadonlySet<string>;
}

/** What a caller wants beyond the plan itself. */
export interface RouteOptions {
  /**
   * Whether to look for the alternatives a reader chooses between —
   * `Route.carrying`, one more A* — as the route panel does. A loop's leg and
   * a walk home are walked, not read, and do not pay for it.
   */
  alternatives?: boolean;
}

/**
 * Cost added by an edge's requirement, or `null` to prune it entirely.
 *
 * The numbers are relative and only have to order routes sensibly: a plain
 * corridor is 1, so a door at 12 means "worth a dozen extra rooms to avoid".
 * The original used −500 for a door, which is a *negative* cost and makes A*
 * prefer doors while breaking admissibility; that looks like a bug rather than
 * an intent, and it is not reproduced.
 */

/**
 * What a door costs to force, graded against the character.
 *
 * The realm states the difficulty a barrier yields to, and in two shapes:
 * `Door [1000 picklocks/strength]` takes either skill, `Key: 2126 [or 157
 * picklocks]` takes only the lock-pick (`any` is 0 in both). Forcing one is a
 * numbers game — bash, rest, bash — and every attempt below the minimum can
 * cost the character, so the grading is deliberately lopsided: below the
 * minimum the door is priced as a wall that can still be walked through when
 * there is no other way at all (`tuning.world.wallCost`, never `null`); at the
 * minimum it is close to a plain door; and the further the skill stands above
 * it the cheaper it gets, down to `base`. A character whose sheet nobody has
 * read is priced as if it could not force anything, which is the safe reading.
 *
 * **The two channels are graded separately and the best one wins** (see
 * `forcedDoorCost`). Taking the higher of the two skills against one number
 * credited a warrior's strength against a lock the realm says only picklocks
 * open.
 */
/**
 * How a lever is filed and looked up: the exit it opens, not the room that
 * holds it.
 *
 * One spelling, used by the index and by every question put to it, because two
 * spellings of a key agree exactly until one of them is edited — the same
 * reason `refusedEdges` keys through one expression.
 */
function leverKey(room: RoomId, direction: string): string {
  return `${room}|${direction}`;
}

/** Handed back for an exit nothing opens, so no caller allocates to say "none". */
const NO_LEVERS: readonly RemoteLever[] = [];

/** The same, for the realm that scatters nobody. */
const EMPTY_COSTS: ReadonlyMap<number, number> = new Map();

/**
 * Nobody in particular, for the one solve that is about the realm rather than
 * about a character. A shared constant because `scatterCosts` caches on
 * traveller *identity*, so a fresh `{}` a call would never hit it.
 */
const PLAIN_TRAVELLER: Traveller = {};

/** One scattering spell: where it draws from, and every door that fires it. */
interface ScatterSpell {
  landing: Landing;
  /** The rooms in the range that the realm actually holds. */
  rooms: RoomId[];
  doors: Array<{ at: RoomId; exit: WorldExit }>;
}

/** One move, seen from the room it arrives in. */
interface ReverseEdge {
  from: RoomId;
  exit: WorldExit | PortalExit;
}

/** One A* pass: the tree where there was a way, and what it walked past. */
interface SearchResult {
  found: {
    cameFrom: Map<RoomId, { prev: RoomId; exit: WorldExit | PortalExit }>;
    cost: number;
  } | null;
  /**
   * Whether the sweep reached a room with a scatter door. Only meaningful on a
   * failed pass, where it means *there is a gamble to consider* — and on a
   * failed pass with `useDraws` already on it is simply true again.
   */
  drawsAhead: boolean;
  /**
   * Whether a room some item teleports into was left **unreached**. Only
   * meaningful on a failed pass, where it is the whole of whether asking again
   * with the pack enabled could possibly help.
   *
   * The reasoning is the one that makes the second search affordable: a failed
   * pass has already exhausted everything the character can reach, so if a
   * landing room is among it then everything beyond that landing was explored
   * too — and an edge into a room the search already settled cannot open a way
   * to a goal it did not find. Re-asking is worth it exactly when some landing
   * sits outside what was reached, which for a random unroutable pair is
   * almost never and for the Catacombs is always.
   */
  landingsAhead: boolean;
}

/**
 * The abilities that take hit points off whoever a spell lands on.
 *
 * The damaging quarter of `menace.hazardOf`'s switch and nothing else: a spell
 * trap's price is what it costs to walk through, and being held or blinded for
 * a round costs a fight rather than a corridor. `Heal` is not in the set
 * because only a *negative* one is a wound, which is a value test rather than
 * an id test.
 */
const HURTS: ReadonlySet<number> = new Set([
  HAZARD_ABILITY.damage,
  HAZARD_ABILITY.damageWithMr,
  HAZARD_ABILITY.drain,
  HAZARD_ABILITY.poison
]);

/**
 * Where one spell's `TeleportRoom` puts the character, as the server works it out.
 *
 * `Spell.cs` `ApplySpellAbilities`, `GMUDAbilityType.TeleportRoom`:
 *
 * ```
 * int tempTeleportRoomID = abil.Modifiers[0].Modifier;
 * if (tempTeleportRoomID == 0) tempTeleportRoomID = inMainValue;
 * ```
 *
 * `inMainValue` is `Globals.Rand.GetRandomNumber(GetSpellMin, GetSpellMax)` —
 * the spell's own `MinBase`–`MaxBase` (`RollAndApplySpellAbilities`). So a
 * stated modifier is an address and a zero is a draw, and the *shape* of the
 * answer is the same either way: a range, which is a room when it is one wide.
 *
 * The map is `TeleportMap` where the row states one and the character's own
 * map where it does not (`plyrTarget.Room.Map.MapID`) — which for an exit's
 * cast is the map the exit table names, because `TryMoveThroughExit` moves
 * first and casts second.
 *
 * `null` for a row this cannot turn into a room: a zero modifier with no
 * power range is a draw between room 0 and room 0, and room 0 is not a room.
 * That is unread rather than harmless, and the caller prices it as a script.
 */
function landingOf(spell: WorldSpell, stated: number, onMap: number): Landing | null {
  const [min, max] = spell.power ?? [0, 0];
  const low = stated > 0 ? stated : min;
  const high = stated > 0 ? stated : max;
  if (low <= 0 || high < low) return null;
  const map = spell.abilities?.find(([id]) => id === HAZARD_ABILITY.teleportMap)?.[1];
  return {
    spell: spell.id,
    name: spell.name,
    map: map !== undefined && map > 0 ? map : onMap,
    low,
    high
  };
}

/** Whether two readings of a chain's teleport are the same answer. */
function sameLanding(a: Landing, b: Landing): boolean {
  return a.map === b.map && a.low === b.low && a.high === b.high;
}

function gradedCost(skill: number | null | undefined, difficulty: number, base: number): number {
  if (difficulty <= 0) return base;
  const ratio = (skill ?? 0) / difficulty;
  const wall = tuning().world.wallCost;
  /*
   * Below the minimum the door is a wall, and how far below is a tiebreak on
   * the door's own scale — continuous with the price at the minimum, never a
   * second wall's worth of plain steps. Graded as `wall × (1 − ratio)`, a
   * strength-90 character was walked sixty thousand rooms' worth of corridor
   * to avoid a 251 door in favour of a 100 one, neither of which it could
   * force: the grade, not the wall, had become the objective.
   */
  if (ratio < 1) return wall + base * 5 + Math.round(base * 5 * (1 - ratio));
  // Neutral-ish at the minimum (a door's price several times over), easing to
  // `base` once the skill is five times what the door asks.
  const eased = Math.max(0, Math.min(1, (5 - ratio) / 4));
  return base + Math.round(base * 4 * eased);
}

function forcedDoorCost(requirement: Requirement, traveller: Traveller, base: number): number {
  const { pickDifficulty, bashDifficulty } = requirement;
  // Neither stated: the realm asks for no skill, so the barrier is whatever a
  // plain one costs. That is what `Door` with no bracket has always meant.
  if (pickDifficulty === undefined && bashDifficulty === undefined) return base;
  const costs: number[] = [];
  if (pickDifficulty !== undefined)
    costs.push(gradedCost(traveller.pickSkill, pickDifficulty, base));
  if (bashDifficulty !== undefined)
    costs.push(gradedCost(traveller.strength, bashDifficulty, base));
  return Math.min(...costs);
}

/**
 * The barrier this traveller is priced *through* rather than round: a door, or
 * a keyed lock the realm lets a skill force, with the character below every
 * skill it names. `edgePenalty` walls it (`wallCost`) rather than pruning it,
 * so the router still walks it when nothing else leads there — and that is
 * exactly when the head of the plan has to say so, because the walker will
 * stop at it. Read off the price itself, so it cannot drift from the decision
 * that walked the door; `edgeBlock` stays the mirror of the `null`s alone.
 */
export function edgeWall(
  requirement: Requirement | null,
  traveller: Traveller
): Requirement | null {
  if (!requirement || (requirement.kind !== 'door' && requirement.kind !== 'key')) return null;
  const priced = edgePenalty(requirement, traveller);
  return priced !== null && priced >= tuning().world.wallCost ? requirement : null;
}

/**
 * The one item an edge demands be carried, or null where it demands none.
 *
 * Two of the realm's columns state one, and from *is this thing in the pack*
 * they are the same fact: `Key: 1124` is a lock and `Item: 191` a hidden
 * exit's own action, which is `Requirement.keyId`'s own reading one layer up.
 * A hidden exit states it on the action rather than on the requirement, so
 * both are looked at, the requirement first.
 *
 * One, and the first: an exit wanting two items is a shape neither shipped
 * realm writes, and inventing an answer for it is the guess this file refuses.
 */
function itemDemanded(requirement: Requirement | null): number | null {
  if (requirement === null) return null;
  if (requirement.keyId !== undefined) return requirement.keyId;
  for (const action of requirement.actions ?? []) {
    if (action.item !== undefined) return action.item;
  }
  return null;
}

/**
 * Why this edge is impassable for this traveller, or `null` when it is not.
 *
 * The mirror of every `null` {@link edgePenalty} returns, and deliberately a
 * separate function rather than a richer return from that one: `edgePenalty` is
 * called once per exit per expansion in the hot loop of an A* over 55,806
 * rooms, and this is called only along a single already-found path. Same
 * decisions, so the two are asserted against each other in the tests — over
 * `REQUIREMENT_KINDS` rather than a hand-written list, because the hand-written
 * one is what let the class gate ship pruning in silence.
 */
export function edgeBlock(
  requirement: Requirement | null,
  traveller: Traveller
): {
  kind: 'key' | 'level' | 'toll' | 'class' | 'race' | 'alignment' | 'item' | 'ability';
  requirement: Requirement;
  /** The item a lever wants, when the block is a hidden exit's; `keyId` otherwise. */
  itemId?: number;
} | null {
  if (!requirement) return null;
  switch (requirement.kind) {
    case 'hidden': {
      // The mirror of `edgePenalty`'s wall: a listed pack lacking the lever's
      // item. Everything else about a hidden exit is a price, never a block.
      const itemId = actionItemMissing(requirement, traveller);
      return itemId === null ? null : { kind: 'item', requirement, itemId };
    }
    case 'key': {
      const has = requirement.keyId !== undefined && traveller.keys?.includes(requirement.keyId);
      if (has || requirement.pickDifficulty !== undefined) return null;
      // A pack nobody has listed does not say the key is missing, so it does
      // not block — the mirror of the price above.
      return traveller.packKnown === true ? { kind: 'key', requirement } : null;
    }

    case 'item': {
      const wanted = requirement.keyId;
      if (wanted === undefined) return null;
      // The mirror of `edgePenalty`'s first refusal: an item the character
      // may not use blocks whatever the pack holds, and says which half.
      const gate = useGateShut(requirement, traveller);
      if (gate !== null) return { kind: gate, requirement };
      if (traveller.keys?.includes(wanted)) return null;
      return traveller.packKnown === true ? { kind: 'item', requirement } : null;
    }
    case 'level': {
      const level = traveller.level;
      if (level === null || level === undefined) return null;
      if (requirement.minLevel !== undefined && level < requirement.minLevel) {
        return { kind: 'level', requirement };
      }
      if (requirement.maxLevel !== undefined && level > requirement.maxLevel) {
        return { kind: 'level', requirement };
      }
      return null;
    }
    case 'toll': {
      const purse = traveller.wealth;
      // Nobody has said what the character has. Unknown never blocks — the
      // reassuring answer is the dangerous one only when it *permits* harm,
      // and refusing to route on an unread purse would strand every character
      // whose inventory has not been listed yet.
      if (purse === null || purse === undefined) return null;
      const price = requirement.tollCopper;
      // A gate whose price the realm did not record: the old behaviour, which
      // is all that can be said without a number.
      if (price === undefined) return purse <= 0 ? { kind: 'toll', requirement } : null;
      return purse < price ? { kind: 'toll', requirement } : null;
    }
    /*
     * The three the character *is*. Each is a mirror of its `edgePenalty`
     * case, and each was a `null` with nothing to say about it until now:
     * `class` shipped that way with todo 03, and `race` and `alignment` would
     * have shipped that way with this one. A pruned edge nothing can explain
     * reports *the two rooms are not joined in the data*, which is untrue and
     * unactionable at the same time.
     */
    case 'class': {
      const mine = traveller.classId;
      if (mine === null || mine === undefined) return null;
      if (requirement.classNo !== undefined && requirement.classNo === mine) {
        return { kind: 'class', requirement };
      }
      if (requirement.classOk !== undefined && requirement.classOk !== mine) {
        return { kind: 'class', requirement };
      }
      return null;
    }

    case 'race': {
      const mine = traveller.raceId;
      if (mine === null || mine === undefined) return null;
      if (requirement.raceNo !== undefined && requirement.raceNo === mine) {
        return { kind: 'race', requirement };
      }
      if (requirement.raceOk !== undefined && requirement.raceOk !== mine) {
        return { kind: 'race', requirement };
      }
      return null;
    }

    case 'alignment': {
      const mine = traveller.alignment;
      const window = requirement.minAlignment;
      if (mine === null || mine === undefined || window === undefined) return null;
      const rank = alignmentRank(mine);
      const low = alignmentRank(window);
      const high = alignmentRank(requirement.maxAlignment ?? window);
      if (rank === null || low === null || high === null) return null;
      return rank >= low && rank <= high ? null : { kind: 'alignment', requirement };
    }

    /*
     * The mirror of `edgePenalty`'s one refusal on the counters, and the only
     * gate here a player can go away and *open*. `abilityGatesMet` is asked
     * rather than the window compared again: three copies of *does this
     * character pass* agree exactly until one is edited, which is the reason
     * `openableHere` exists one kind across.
     *
     * Null on *nobody has said*, which is the rule every case above follows —
     * an unread listing is discouraged and never pruned, so a block of this
     * kind always names a counter the realm stated.
     */
    case 'ability':
      return abilityGatesMet(requirement.abilities, traveller.counters) === false
        ? { kind: 'ability', requirement }
        : null;

    default:
      return null;
  }
}

/**
 * What a condition nobody can evaluate costs.
 *
 * Passable in principle and heavily discouraged in practice: a route through
 * one is better than no route, and the chip shows the realm's own instruction
 * so a person can judge. Named because seven cases reached for the same
 * literal and three of them have since stopped — the ones that stayed are the
 * ones where the fact genuinely is not in the client, and a shared name makes
 * that visible in a way a repeated `60` did not.
 */
const UNEVALUATED = 60;

/**
 * Whether a hidden exit's levers want an item the pack does not hold.
 *
 * `missing` once the pack has been listed and lacks one; `unlisted` while
 * nobody has listed it and a lever wants something; null for a lever that
 * wants nothing or an item that is carried. Every lever is asked, wherever it
 * is pulled: a lever two rooms away that needs the talisman needs it there.
 */
function actionItemLacking(
  requirement: Requirement,
  traveller: Traveller
): 'missing' | 'unlisted' | null {
  const wanted = (requirement.actions ?? [])
    .map((act) => act.item)
    .filter((item): item is number => item !== undefined);
  if (wanted.length === 0) return null;
  if (traveller.packKnown !== true) return 'unlisted';
  return wanted.every((item) => traveller.keys?.includes(item)) ? null : 'missing';
}

/** The first item a hidden exit's levers want that the listed pack lacks, for the refusal. */
function actionItemMissing(requirement: Requirement, traveller: Traveller): number | null {
  if (traveller.packKnown !== true) return null;
  for (const act of requirement.actions ?? []) {
    if (act.item !== undefined && !traveller.keys?.includes(act.item)) return act.item;
  }
  return null;
}

/**
 * What a counter is worth stopping at — lower is better, and nothing else.
 *
 * `detour + dearerSteps × log2(100 + markup)`: the steps of going out of the
 * way, plus what the price is worth in steps of going out of the way.
 *
 * **A logarithm, because only the ratio is stated.** The realm's base figure
 * belongs to the item and is identical at every counter that stocks it, so
 * between two of them `(100 + markup)` *is* the price, in whatever unit the
 * base is written in — a unit the client has settled it must not pretend is
 * copper (`ShopFace`). Taking its logarithm makes the gap between two counters
 * exactly the number of doublings between their prices, which is a real
 * quantity, and stops Paradigm's 32,760% shop from being ranked three hundred
 * maps' worth of walking behind its 100% one.
 *
 * The constant term that leaves in every rank is the point of writing it this
 * way: it is the same for every candidate, so it cancels in the ordering and
 * the figure stays independent of which counters happen to be in the list.
 */
function buyingRank(place: BuyingPlace, dearerSteps: number): number {
  return place.detour + dearerSteps * Math.log2(100 + place.markup);
}

/**
 * What a lair costs to route through, from what one pass is expected to take.
 *
 * A share of the health the character has now (`Traveller.danger`), priced
 * `dangerCost × share / (1 − share)`: `tuning.world.dangerCost` for a pass
 * that takes half the bar, a tenth of that for a tenth, and a price that
 * climbs without bound as a pass approaches the whole bar — so the step from
 * *dangerous* to *deadly* is a slope and not a cliff, and a room just short
 * of `deadlyShare` is never nearly free. At `deadlyShare` and above it is a
 * wall — `wallCost`, never null, because a room the character is expected to
 * die in is still the only way there sometimes, and refusing outright would
 * hide that route rather than price it. Unknown costs nothing: an unread
 * sheet must not turn every lair in the realm into a wall.
 *
 * The old price was `dangerCost` per whole bar, forty, linear, with the wall
 * at one: a pass expected to take 99% of the bar cost thirty-nine steps and
 * one expected to take all of it cost a hundred thousand, and with the
 * lair's figure being the cost of *clearing* it rather than crossing it,
 * every lair on a level-11 character's way to the Black Mountains was the
 * second kind. The router then minimised the count of walls and nothing
 * else, and chose a keyed door and 472 steps to save five of them.
 */
export function dangerPenalty(share: number | null): number {
  if (share === null || !Number.isFinite(share) || share <= 0) return 0;
  const { wallCost, deadlyShare, dangerCost } = tuning().world;
  if (share >= deadlyShare) return wallCost;
  // Capped at the wall, so a share just under `deadlyShare` never prices
  // above the room that reached it.
  const remaining = Math.max(1 - share, 1e-6);
  return Math.min(wallCost, Math.round((dangerCost * share) / remaining));
}

/**
 * What this edge costs, the conditions the client cannot read included.
 *
 * Two halves because an edge may carry conditions of two kinds at once, which
 * is true of a room script and of nothing else: `go portal` states `minlevel
 * 40` and `nomonsters` in one breath, and `Requirement.kind` holds one of
 * them. So the kind is priced by the switch below and every guard without a
 * kind is priced here, once, at the unevaluable figure — added rather than
 * taken as the worse of the two, because a level gate that lets this character
 * through does not make the rest of the script free.
 *
 * `null` still means impassable and nothing is added to it: a refusal is a
 * refusal whatever else the edge says.
 *
 * **And a gate the counters answer is answered rather than priced** (2026-09-15).
 * `abil` states the quest counters outright on GreaterMUD, and the three
 * ability verbs are the only guards here the client holds a matching fact for,
 * so an edge whose `checkability` this character *fails* is not a way through
 * at all. Priced as merely discouraged it was still walked when it was the
 * only way — live, `9/1291 go portal` (gated `checkability 133 5`) put a
 * character with rank 4 into the Caves of Chaos instead of `9/1424`, two maps
 * from where the plan believed it was. Nobody having said stays the old price:
 * an unread listing is not a failing gate, and the discouragement is still
 * added on top of a gate that passes, because the rest of the script — the
 * `nomonsters` and the `takeitem` beside it — is no more readable than it was.
 */
export function edgePenalty(requirement: Requirement | null, traveller: Traveller): number | null {
  /*
   * **Ahead of everything else, because a refusal is a refusal.** This sat
   * under the `unread` guard below, where it answered a room script's
   * `checkability` and never saw the exit table's own `Ability: 204 w/value 1
   * to 999` — which carries no `unread`, having nothing unread about it. Live,
   * 2026-09-21: a 286-step plan walked into `2/9458 sw` and the realm answered
   * *You realize that you need more information for the task at hand!*
   */
  if (abilityGatesMet(requirement?.abilities, traveller.counters) === false) return null;
  const priced = statedPenalty(requirement, traveller);
  if (priced === null) return null;
  const under = corridorCost(requirement);
  if (under === null) return null;
  const total = priced + under;
  if (requirement?.unread === undefined) return total;
  return total + UNEVALUATED;
}

/**
 * What a way in that puts a timed spell on the character costs (todo 104):
 * the rooms under it to the exit that lifts it, against the ticks it lasts.
 * A passage with no way out this side of the spell's end, or one whose
 * length the realm states no duration against, is a wall — unknown is never
 * the reassuring answer, and here the reassuring answer drowns somebody.
 */
function corridorCost(requirement: Requirement | null): number | null {
  const corridor = requirement?.corridor;
  if (corridor === undefined) return 0;
  if (!corridor.ends || corridor.ticks === undefined) return null;
  return corridor.rooms > corridor.ticks ? null : corridor.rooms;
}

function statedPenalty(requirement: Requirement | null, traveller: Traveller): number | null {
  if (!requirement) return 0;

  switch (requirement.kind) {
    case 'text':
      // Not an obstacle, just a different command. No penalty at all.
      return 0;

    case 'door':
      return forcedDoorCost(requirement, traveller, 12);

    case 'key': {
      const has = requirement.keyId !== undefined && traveller.keys?.includes(requirement.keyId);
      if (has) return 4;
      // Otherwise the lock is picked or the door forced, at the graded cost.
      if (requirement.pickDifficulty !== undefined)
        return forcedDoorCost(requirement, traveller, 30);
      /*
       * No key, and no skill the realm accepts instead — a wall, but only once
       * somebody has looked in the pack.
       *
       * `Traveller.keys` was documented as *item ids carried* and **nothing
       * ever set it**, so this pruned every keyed door in the realm on no
       * evidence at all: the answer was always *you do not have the key*,
       * because the question had never been asked. Now that the pack answers,
       * the silence has to be told from the answer, or the fix would keep the
       * old behaviour under a better name.
       */
      return traveller.packKnown === true ? null : UNEVALUATED;
    }

    case 'level': {
      const level = traveller.level;
      if (level === null || level === undefined) return 20;
      if (requirement.minLevel !== undefined && level < requirement.minLevel) return null;
      if (requirement.maxLevel !== undefined && level > requirement.maxLevel) return null;
      return 0;
    }

    case 'toll': {
      /*
       * The data **does** carry the amount, and the comment here used to say it
       * did not — so a toll was pruned only for a character with exactly zero,
       * and a character 495 copper short of a 5-gold gate was routed straight
       * into it. That is the reported failure: the walk stopped at the gate,
       * the refusal went unread, and the pending move it left disabled
       * retaliation while a wild dog beat on a character that never swung back.
       *
       * `tollCopper` is the realm's own figure in copper (see `instructions.ts`
       * for why it is gold on the way in). Unaffordable is a wall; affordable
       * costs the small penalty a gate deserves for taking money.
       */
      const purse = traveller.wealth;
      if (purse === null || purse === undefined) return 8;
      const price = requirement.tollCopper;
      if (price === undefined) return purse <= 0 ? null : 8;
      return purse < price ? null : 8;
    }

    case 'hidden': {
      /*
       * A lever that needs an item is a keyed door in another shape: the
       * server refuses the phrase without the item in the pack
       * (`RequirementAction.item`), so a pack that has been listed and lacks
       * it makes the exit a wall, and a pack nobody has listed leaves it the
       * unevaluated price — the same two answers `key` gives, for the same
       * reason. Todo 13: a route was planned through *hold up talisman* at
       * the cost of a free lever, and the character had no talisman.
       */
      const lacking = actionItemLacking(requirement, traveller);
      if (lacking === 'missing') return null;
      if (lacking === 'unlisted') return UNEVALUATED;
      /*
       * Searchable costs the search — `Walker.searchFor` sends it.
       *
       * An action-gated one costs the levers where the realm puts every one of
       * them in the room the exit leaves from, because `Walker.pullLevers`
       * sends those too: it is the same rung, priced the same way, one command
       * per lever. 150 of the shipped realm's 217 are that shape.
       *
       * Everything else stays expensive rather than impossible, which is what
       * this line has always said. The levers are somewhere else, and this
       * planner still does not plan the detour: `Walker.fetchLever` makes it
       * **reactively**, when the server refuses the step, for the reason the
       * search rung already gives — a gate found open is found open, and a lap
       * should pay for the errand once rather than every time it plans. So the
       * price is what the edge costs when it is already open, plus a
       * discouragement, which is what this is.
       */
      if (requirement.searchable) return 25;
      if (openableHere(requirement)) return 25 + 5 * requirement.actions!.length;
      return 200;
    }

    case 'trap':
      // Proportional to the hurt, floored so any trap is worth avoiding.
      return 20 + (requirement.damage ?? 0);

    case 'class': {
      /*
       * **A class gate is as hard as a level gate, and the realm states it in
       * numbers** (todo 03, 2026-09-06, reported as *"route from 1, 1377 to 1,
       * 2260 took the wrong route ... it tried to go east at 1, 1422 which is
       * the wrong class, it should have tried at 1, 1423"*).
       *
       * The shipped realm's crypt is fifteen rooms all called `Crypt, Shadowed
       * Hall`, whose east exits read `Class: 1 OK` through `Class: 15 OK` —
       * one class each. Priced as an unevaluable condition, every one of them
       * cost the same, so A* took whichever lay on the shortest path: a
       * Paladin (class 3) was routed through 1/1422's `Class: 6 OK` and
       * answered `You may not go through this exit!`. The walk stopped, and
       * `SessionManager.refusedEdges` then wrote a **real** corridor off for
       * the rest of the session — the second cost, and the worse one.
       *
       * Nothing had to be learned to fix it: `WorldGraph.classId` already
       * joined the sheet's word to the realm's row id for item restrictions,
       * and the exit's own numbers were sitting in `raw`. What was missing was
       * anybody asking.
       *
       * **Unknown stays discouraged, never pruned.** A character whose sheet
       * nobody has read, or a realm converted before the class table, must
       * still be given a route — the reassuring guess here is *I can pass*,
       * and the cost of it is one refusal, where refusing to route at all
       * strands the character. That is the same direction `level` takes for an
       * unknown level.
       */
      const mine = traveller.classId;
      if (mine === null || mine === undefined) return UNEVALUATED;
      if (requirement.classNo !== undefined && requirement.classNo === mine) return null;
      if (requirement.classOk !== undefined) return requirement.classOk === mine ? 0 : null;
      // A gate that names neither side is one this reading cannot evaluate.
      return UNEVALUATED;
    }

    case 'race': {
      /*
       * The class gate one column across, and priced identically because the
       * server prices it identically: `RaceRestrictedExit` is
       * `ClassRestrictedExit` with `Races` in place of `Classes`, down to the
       * refusal it prints. Unknown stays discouraged rather than pruned, for
       * the reason the class case gives at length.
       */
      const mine = traveller.raceId;
      if (mine === null || mine === undefined) return UNEVALUATED;
      if (requirement.raceNo !== undefined && requirement.raceNo === mine) return null;
      if (requirement.raceOk !== undefined) return requirement.raceOk === mine ? 0 : null;
      return UNEVALUATED;
    }

    case 'alignment': {
      /*
       * A window on the standing scale, and the one gate whose answer changes
       * while the character stands still — evil points move with what it
       * kills.
       *
       * That is why the *unknown* case matters more here than anywhere else:
       * the standing comes off the `who` roster and nothing else, so for the
       * first seconds of every session there is no answer at all. Discouraged,
       * never pruned. A window the parse could not read leaves both ends
       * absent and lands here too.
       */
      const mine = traveller.alignment;
      const window = requirement.minAlignment;
      if (mine === null || mine === undefined || window === undefined) return UNEVALUATED;
      const rank = alignmentRank(mine);
      const low = alignmentRank(window);
      const high = alignmentRank(requirement.maxAlignment ?? window);
      if (rank === null || low === null || high === null) return UNEVALUATED;
      return rank >= low && rank <= high ? 0 : null;
    }

    case 'ability':
      /*
       * `Ability: 0 w/value 0 to 0` is the realm's empty slot, and the server
       * builds a plain exit for it — the parse drops the zero, so an absent id
       * here *is* that exit and it costs nothing.
       *
       * Every other ability gate names a quest counter (`DaoLordQuest`,
       * `Rune`, `Mandos Quest`, `GuildmasterQuest`), and `abil` states those
       * outright. A gate this character **fails** never reaches here — it is
       * refused a layer up, where a script's gate is — so the two answers left
       * are *settled and passing*, which is a plain corridor and costs
       * nothing, and *nobody has said*, which stays discouraged with the chip
       * carrying the realm's own words for a person to judge by.
       *
       * Nothing is added to a gate that passes, unlike the script beside it: a
       * room script has a `nomonsters` and a `takeitem` left unread after its
       * gate is answered, and an `AbilityExit` is the gate and nothing else.
       */
      if (requirement.abilityId === undefined) return 0;
      return abilityGatesMet(requirement.abilities, traveller.counters) === true ? 0 : UNEVALUATED;

    case 'cast':
      /*
       * **A cast exit never refuses anybody**, and 217 of the shipped realm's
       * 293 move the character somewhere the exit table does not name — 49 to
       * one known room and 168 to one of several.
       *
       * `CastExit.CanMoveThroughExit` returns `true` unconditionally and
       * `TryMoveThroughExit` moves first and casts second (a reading of the
       * server's source, not a capture). So the old flat discouragement was
       * wrong twice over: it priced 76 plain corridors as half-walls, and it
       * priced a scatter maze as a corridor.
       *
       * **`teleports` is an ordinary step**, because that is what it is: the
       * spell names one room and the router walks the edge to *that* room
       * (`WorldGraph.beyond`). It was a wall while the destination was
       * unknown, and the wall was standing in for the unknown rather than for
       * any cost — nothing about walking east out of a Marble Room is
       * expensive, it simply does not go where the exit table says.
       *
       * **`scatters` is priced nowhere near here.** A draw is not an edge, so
       * `search` never relaxes one as a step and this figure is what every
       * *other* reader gets — `withinSteps`, `blocksAlong` — for which *you
       * cannot use this to get anywhere in particular* is exactly what a wall
       * means. What the router does with one instead is `scatterCosts`.
       *
       * `script` keeps the old discouragement, and that is the honest answer
       * rather than an unchanged one: the spell hands the character a
       * `TextBlock` this client does not convert, 40 of the 56 are called
       * `pyramid 4 arch fail`, and a script named *fail* is a gate under
       * another name.
       */
      if (requirement.spellEffect === 'scatters') return tuning().world.wallCost;
      if (requirement.spellEffect === 'script') return UNEVALUATED;
      return 0;

    case 'spell':
      /*
       * A spell trap, which `SpellTrapExit.CanMoveThroughExit` also lets
       * everybody through: it is a trap and not a gate, so it is priced as one
       * — the same line the `trap` case above uses, against a damage figure
       * `resolveSpells` read off the realm's own spell table rather than out of
       * the instruction string.
       *
       * A trap that *moves* the character is the cast exit's problem again and
       * gets the cast exit's answer, and so is one whose spell this client
       * could not read — the cast case and this one had priced that the same
       * fact two ways, 60 there and the trap floor here, on the reasoning that
       * a trap is a trap whatever it fires. It is not: an unread script can
       * move the character, which is the one thing the trap floor promises it
       * will not.
       *
       * What is left is a trap with a hurt the realm's table states, priced as
       * the `trap` case above prices one — or with no hurt in it at all, which
       * costs the floor and says *there is a trap here* without inventing a
       * number.
       */
      if (requirement.spellEffect === 'scatters') return tuning().world.wallCost;
      if (requirement.spellEffect === 'script') return UNEVALUATED;
      /*
       * A trap that *teleports* is still a trap: `beyond` takes the character
       * to the spell's room and the hurt is charged here as for any other, so
       * this falls through rather than pricing the move at nothing. Neither
       * shipped realm holds one, which is exactly why it must not be a
       * special case nobody exercises.
       */
      return 20 + (requirement.damage ?? 0);

    case 'item': {
      /*
       * `Item: 191` — `rope and grapple`, on 157 of the shipped realm's exits.
       * The server walks `Inventory.ItemStacks` for it, so the pack answers,
       * and the pack is a maintained listing: `i` establishes it and every
       * pick-up and drop keeps it true (`CharacterTracker.replayPack`).
       *
       * The three answers are the three states the pack can be in, and the
       * middle one is the whole reason `packKnown` exists. Carried is free.
       * **Listed and not in it is a wall** — the server refuses outright, and
       * pricing that as merely discouraged is what walks a character into a
       * refusal and has `SessionManager.refusedEdges` write a real corridor off
       * for the session, which was todo 03's second and worse cost. Never
       * listed is *nobody has looked*, which is discouraged and never pruned.
       *
       * An absent id is `Item: 0`, the realm's empty slot, which the server
       * builds as a plain exit.
       */
      const wanted = requirement.keyId;
      if (wanted === undefined) return 0;
      /*
       * **And whether the server will let it be used at all**, which the pack
       * cannot answer: the token of Silvermere sat in a level-21 pack, the
       * walk out of the Sandbar wanted a rope and grapple the pack lacked, so
       * the last-resort landing planned `use token of Silvermere` and the
       * server said *You are not experienced enough to make that trip!*
       * (2026-09-21). The item row states level 25. Refused, not discouraged:
       * a level is not something a detour fetches. Unknown never refuses,
       * exactly as `equipBlock` never greys a row out on a sheet nobody has
       * read.
       */
      if (useGateShut(requirement, traveller) !== null) return null;
      if (traveller.keys?.includes(wanted)) return 0;
      return traveller.packKnown === true ? null : UNEVALUATED;
    }

    case 'timed':
      /*
       * `Timed: 0*5 minutes` — one exit in the shipped realm and none at all
       * in the other, which is the whole survey.
       *
       * An exit that is open on a schedule, and this client holds no clock the
       * server shares: the shape has one sample, the units are unread, and
       * GreaterMUD does not implement the case at all (`RoomManager.LoadRooms`
       * case 16 builds a plain exit and says `//fix this`). Pricing it free on
       * the strength of a server that skips it would be encoding one build's
       * omission as a fact about the realm, so it stays discouraged — a route
       * through it is offered and not preferred, and the chip carries the
       * realm's own words.
       */
      return UNEVALUATED;

    case 'unknown':
    default:
      return 40;
  }
}

/** Binary min-heap. The original re-sorted the open list every iteration. */
class MinHeap<T> {
  private readonly items: Array<{ key: number; value: T }> = [];

  get size(): number {
    return this.items.length;
  }

  push(key: number, value: T): void {
    this.items.push({ key, value });
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent]!.key <= this.items[i]!.key) break;
      [this.items[parent], this.items[i]] = [this.items[i]!, this.items[parent]!];
      i = parent;
    }
  }

  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.items.length && this.items[left]!.key < this.items[smallest]!.key) {
          smallest = left;
        }
        if (right < this.items.length && this.items[right]!.key < this.items[smallest]!.key) {
          smallest = right;
        }
        if (smallest === i) break;
        [this.items[smallest], this.items[i]] = [this.items[i]!, this.items[smallest]!];
        i = smallest;
      }
    }
    return top.value;
  }
}

export interface WorldMeta {
  version: number;
  source: string;
  rooms: number;
  generatedAt: string;
  /**
   * Which lineage's arithmetic this realm data belongs to — format 21.
   *
   * `null` on a realm converted by an older build, and on one whose `Info`
   * table does not name a lineage. Never guessed at: see `shared/realm.ts`.
   */
  family: RealmFamily | null;
  /** The database's own `Info` row, whole. `null` before format 21. */
  build: RealmBuild | null;
  /**
   * Which bundled world this is — format 27, written only by `build-world.mjs`.
   * `null` for a realm a player converted, which is theirs and named after its
   * file. See `shared/worlds.ts`.
   */
  world: ShippedWorld | null;
  /** The archive a bundled world was built from; `null` for a player's realm. */
  archive: ArchiveIdentity | null;
}

/**
 * The header's own fields, every one parsed rather than trusted: the header is
 * a file on the player's disk, and one converted by an older build carries
 * fewer of them. `asRealmFamily` is what stops a hand-edited header naming a
 * third family that every calculator would then fall through; `asShippedWorld`
 * and `readArchiveIdentity` do the same for format 27's two.
 */
function metaOf(parsed: Record<string, unknown>): WorldMeta {
  const build = readRealmBuild(parsed['build']);
  return {
    version: parsed['v'] as number,
    source: String(parsed['source'] ?? 'unknown'),
    rooms: Number(parsed['rooms'] ?? 0),
    generatedAt: String(parsed['generatedAt'] ?? ''),
    family: asRealmFamily(parsed['family']) ?? familyOfBuild(build),
    build,
    world: asShippedWorld(parsed['world']),
    archive: readArchiveIdentity(parsed['archive'])
  };
}

export class WorldGraph {
  private readonly rooms = new Map<RoomId, WorldRoom>();
  /**
   * The room-script teleports the router may walk, keyed by the room whose
   * script offers them — `dive pool`, `go vortex`. Built by `linkPortals` once
   * the rooms are loaded, and deliberately only from scripts whose every
   * condition the router can genuinely evaluate against the traveller
   * (`minlevel`/`maxlevel`, or none): a `nomonsters` or `roomitem` portal is a
   * fact the Room card states and a person judges, because routing through a
   * condition the client cannot read is how a character is walked somewhere it
   * cannot get back from — the reason mme.md §6 deferred this half.
   *
   * A refused portal walls at `from|portal`, which is one key per *room*: a
   * room offering two routable portals (exactly one on the shipped realm,
   * 15/740) has both avoided when either is refused. Coarse on purpose — a
   * refusal cannot say which phrase it answered, and over-avoiding for a
   * session is the safe direction.
   */
  private readonly portals = new Map<RoomId, PortalExit[]>();
  /**
   * Every lever the realm says opens an exit, keyed by the exit it opens —
   * `map/room|direction`. Built by `linkLevers` once the rooms are loaded.
   *
   * Indexed by the exit and not by the room holding the lever, because that is
   * the direction the question is asked from: a walk refused at a gate asks
   * *is there anything anywhere that opens this*, and the room it is standing
   * in is the one place the answer is not.
   */
  private readonly levers = new Map<string, RemoteLever[]>();
  /** Lowercased name -> every room that bears it. Names are far from unique. */
  private readonly byName = new Map<string, WorldRoom[]>();
  /**
   * Item id -> every room the realm places one in, in load order: the other
   * direction of `WorldRoom.placed`, built as the rooms arrive so the file
   * states the fact once (format 42).
   */
  private readonly placedIn = new Map<number, RoomId[]>();
  /**
   * The three the scatter solve works from, all built on first use and none of
   * them on load: a realm's rooms are read at startup and most sessions never
   * plan through a draw, so the index that answers *what leads here* (140,000
   * entries on Paradigm, 144ms) is owed to the first route that needs it and
   * to no other. See `scatterDoors`, `reverse` and `scatterCosts`.
   */
  private draws: Map<number, ScatterSpell> | null = null;
  private backward: Map<RoomId, ReverseEdge[]> | null = null;
  private solved: { to: RoomId; traveller: Traveller; costs: ReadonlyMap<number, number> } | null =
    null;
  /**
   * The same solve with nothing priced but the steps, keyed by destination —
   * the figure a reader is *shown*, which has to be a count of moves and not
   * the router's cost. See `scatterMoves`. Realm-wide truth, so it is kept
   * across travellers and characters, and capped because a destination is a
   * room and there are fifty thousand of them.
   */
  private plainDraws = new Map<RoomId, ReadonlyMap<number, number>>();
  private meta: WorldMeta = {
    version: 0,
    source: 'none',
    rooms: 0,
    generatedAt: '',
    family: null,
    build: null,
    world: null,
    archive: null
  };
  /** Items some exit requires, by number. Only those; see `build-world.mjs`. */
  private readonly items = new Map<number, WorldItem>();
  /**
   * The same items by name, lower-cased.
   *
   * A second index rather than a scan: the Carrying card asks about every item
   * a character holds each time the listing changes, and a linear search over
   * 1,650 items per item is the shape of thing this whole layer exists to avoid
   * (docs/legacy-assessment.md §5: the CoffeeScript engine ran a query per
   * line, on the main thread). First name wins, because the realm has a handful
   * of duplicates and the earlier row is the one the shops reference.
   */
  private readonly itemsByName = new Map<string, WorldItem>();
  /**
   * Every row a name belongs to, where `itemsByName` keeps only the first.
   *
   * Two indexes on one column because they answer two questions: *what is this
   * thing called `moonstone`* wants one row to describe and takes the first,
   * while *is the thing this exit demands in the pack* has to know that
   * `moonstone` is two rows and therefore says nothing about either. Collapsing
   * the second onto the first would have opened a gate on a name.
   */
  private readonly itemRowsByName = new Map<string, number[]>();
  /**
   * The items whose use casts a spell, by the spell — `Items.Abil-n = CastsSp`
   * the other way round. A room spell's script names the spell that stops it
   * (`failspell 711`), and this is how a plan gets from that to the waterskin.
   */
  private readonly grants = new Map<number, WorldItem[]>();
  /**
   * The rooms a way in leaves under a timed spell (todo 104), by the passage
   * that puts them there — the eleven Muddy Underwater Passage rooms under
   * *holding breath*. Built by `linkPortals`; read by `spellOver`.
   */
  private readonly underSpell = new Map<RoomId, Corridor>();
  /**
   * Every monster the realm names, keyed by lowercased name.
   *
   * By name because that is all the wire gives — the combat lines carry `the
   * giant rat` and never a record id — and the whole table rather than a
   * referenced subset, because any monster can walk into the room.
   */
  private readonly mobs = new Map<string, WorldMob>();
  /** By the realm's own number, for lairs. Empty on a realm built before v9. */
  private readonly mobsById = new Map<number, WorldMob>();
  /**
   * Each row answering for itself, by row number — format 32.
   *
   * A name off the wire folds every row sharing it (`mobs`); a lair names a
   * row outright and a room resolves a name to one (`resolveMobRow`). A row
   * absent from here is a name the realm places once — the fold *is* the row —
   * or a file written before the format, and both fall back to the fold, which
   * is the cautious reading rather than the reassuring one.
   */
  private readonly rowsById = new Map<number, WorldMobRow>();
  /**
   * `roomId|name` → the row that room resolves the name to. Bounded.
   *
   * The search behind it is a breadth-first sweep that can reach the whole map
   * for a name nothing spawns nearby, and the questions repeat exactly: every
   * status line re-weighs the same occupants standing in the same room. Keyed
   * on the pair because the answer is about both.
   */
  private readonly resolvedRows = new Map<string, MobRowChoice | null>();
  /** Shops that stock something, by the number `Rooms.Shop` holds. */
  private readonly shops = new Map<number, WorldShop>();
  /**
   * Shop name → the rooms holding it, built on the first ask. Null until then:
   * most sessions never open a Reference card, and 55,806 rooms is not a scan
   * to pay for on load.
   */
  private shopRoomsByName: Map<string, WorldRoom[]> | null = null;
  /**
   * Monster number → the rooms the realm spawns it in, built on the first ask.
   *
   * Null until then, for `shopRoomsByName`'s reason exactly: most sessions
   * never open a Reference card, and this is the same 55,806-room scan. One
   * scan answers every monster, so the alternative — a filter per clicked name
   * — is the N+1 this layer exists to refuse.
   */
  private mobRoomsById: Map<number, MobSpawnRoom[]> | null = null;
  /**
   * The realm's class table as `{ id: name }`, for an ability whose value is a
   * class id rather than a magnitude. See `WorldLookup.classNames`.
   *
   * Built per call rather than cached: fifteen entries, and a lookup is a
   * click. A cache here would be a second copy of a table that already exists.
   */
  private classNames(): Record<number, string> {
    return namesById(this.classes);
  }

  /**
   * The class and race tables as `{ id: name }`, for naming a restriction.
   *
   * Public because the equip check needs both: an item restricted to classes
   * 3, 4, 5 and 6 has to be able to say *Paladin, Cleric, Priest or
   * Missionary*, and a bare list of numbers is the half-read `WorldLookup`
   * already carries `classNames` to avoid.
   */
  namedClasses(): Record<number, string> {
    return namesById(this.classes);
  }

  namedRaces(): Record<number, string> {
    return namesById(this.races);
  }

  /**
   * The realm's row id for a race or a class the stat sheet named.
   *
   * The sheet prints the realm's own word — `Race: Halfling`, `Class: Mystic`
   * (capture 007) — and the restrictions on an item are row *ids*, so somebody
   * has to join the two. Here, because this is where the tables are: a
   * renderer doing it would need both tables shipped to it, and a second
   * spelling of `Half-Ogre` deciding whether a helm goes on is exactly the
   * kind of drift this project keeps out of the renderer.
   *
   * Case-insensitive and trimmed. `null` for a word no table has, which is a
   * first-class answer — a realm converted before v10 names no races at all,
   * and the caller treats unknown as *not ruled out* rather than as refused.
   */
  raceId(name: string): number | null {
    return idNamed(this.races, name);
  }

  classId(name: string): number | null {
    return idNamed(this.classes, name);
  }

  /**
   * What the realm says a race grants — its `Abil-n` pairs — by the word the
   * stat sheet prints, or null for a race no table names.
   *
   * Null rather than an empty list, because the two are different facts: a
   * Human carries no abilities and sees by nothing, and a race the realm
   * cannot place is one whose night vision is unknown. `src/shared/light.ts`
   * reads the difference.
   */
  raceAbilities(name: string): Array<[number, number]> | null {
    const found = rowNamed(this.races, name);
    if (!found) return null;
    return found.abilities ?? [];
  }

  /**
   * What the realm says a race's six attributes run between, by the word the
   * stat sheet prints, or null for a race no table names.
   *
   * The floor is what creation rolls and the ceiling is what training reaches
   * — a Kang's strength is 55 to 160 — so a number on its own says nothing and
   * the same number against this says how far up the race's own range this
   * character has come. An attribute the realm states no range for is left
   * out rather than given the table's widest, which would read as a range
   * somebody could act on.
   */
  raceSpans(name: string): AttributeSpans | null {
    const found = rowNamed(this.races, name);
    if (!found) return null;
    const spans: AttributeSpans = {};
    if (found.str) spans.strength = found.str;
    if (found.int) spans.intellect = found.int;
    if (found.wil) spans.willpower = found.wil;
    if (found.agl) spans.agility = found.agl;
    if (found.hea) spans.health = found.hea;
    if (found.chm) spans.charm = found.chm;
    return spans;
  }

  /**
   * What this race and class pay per level, as a percentage of the base table.
   *
   * `100 + race.ExpTable + class.ExpTable`, which is the whole of it: the two
   * columns are *additions* to a base rate of 100, not multipliers of it. Two
   * characters' tables recorded off the wire give it exactly — a Gaunt One
   * Mystic (120 + 420) at 6,400 for level 2 and a Kang Paladin (150 + 490) at
   * 7,400 — and MMUD-Explorer composes its own chart number the same way.
   * `src/shared/experience.ts` has the measurement and what it does not settle.
   *
   * **Null unless the realm names both**, because a missing term is not a zero
   * one: a realm converted before v10 carries no race table at all, and
   * charging such a character the base rate would put a plausible, wrong number
   * where the card should be saying it does not know. A row the realm *has*
   * with no `ExpTable` column contributes nothing, which is what absent means
   * there — the builder writes the column only when it is non-zero.
   */
  experiencePercent(race: string, className: string): number | null {
    const found = rowNamed(this.races, race);
    const taken = rowNamed(this.classes, className);
    if (!found || !taken) return null;
    return 100 + (found.expTable ?? 0) + (taken.expTable ?? 0);
  }

  /**
   * The realm's own row for a class name.
   *
   * `CombatLVL` and `MageryLVL` are inputs to the server's own accuracy, swing
   * and mana-regeneration formulas (`shared/prowess.ts`) and the stat sheet
   * prints neither — the realm is the only place either is stated. Null for a
   * name the realm cannot place, and for a realm converted before v10, which
   * carries no class table at all.
   */
  classNamed(name: string): WorldClass | null {
    return rowNamed(this.classes, name) ?? null;
  }

  /** Every spell the realm names, in table order. */
  private spells: WorldSpell[] = [];
  /** The same rows by id — see `spellById` for why this is not a scan. */
  private spellsById = new Map<number, WorldSpell>();
  private confusionRows: ReadonlySet<number> | null = null;
  /** The realm's races and classes, in table order. Empty before v10. */
  private races: WorldRace[] = [];
  private classes: WorldClass[] = [];
  /** The realm's quests, out of the header. See `indexQuests.ts`. */
  private questBook: Quest[] = [];
  /**
   * The book with the item and room joins applied, computed on first ask.
   *
   * Null rather than empty for *not yet computed*: a realm that scripts no
   * quests joins to an empty array, and the two must not be the same state or
   * the join would run again on every mount of the card.
   */
  private questsJoined: Quest[] | null = null;
  /** Item name -> the monsters that drop it, built with the first join. */
  private droppers: Map<string, string[]> | null = null;
  /** Item id -> the shops that stock it, built with the first join. */
  private stockists: Map<number, string[]> | null = null;
  /**
   * Item id -> the **rooms** whose counter stocks it, built on the first ask.
   *
   * `stockists` above answers by name because that is what `WorldItem.shops`
   * holds and what a card prints. A name is not somewhere to walk to — `Boat
   * Launch` is one shop row standing in two rooms — so choosing where to buy
   * needs the rooms, and re-deriving them per ask is the scan over 57,511
   * rooms this file refuses everywhere else.
   */
  private stocking: Map<number, WorldRoom[]> | null = null;
  /**
   * Every way *into* each room, with the item it demands — `approachItems`.
   *
   * Backwards, because the question is *what stands between the realm and this
   * room* and the exits are all written the other way. Built once on the first
   * question (66ms over Paradigm's 138,771 edges) and null until then, like
   * the two above.
   */
  private waysIn: Map<RoomId, Array<{ from: RoomId | null; item: number | null }>> | null = null;
  /**
   * The items that are themselves a way through, as edges — built once.
   *
   * An item that teleports is an edge from **everywhere** to one room, which
   * is why it is a flat list rather than a map keyed by where it is used:
   * `WorldItem.lands` is a fixed address and drinking the potion works
   * wherever the character is standing. The exit objects are shared across
   * every search and never mutated, like the portal table beside them.
   */
  private landings: ReadonlyArray<PortalExit> | null = null;
  /**
   * Every room any landing can reach, ignoring the traveller — built once.
   *
   * A **superset**, deliberately: it is asked only to rule the second search
   * out, so it must never be smaller than the truth.
   *
   * `landingsAhead` alone cannot tell the Catacombs — where the landing does
   * reach the goal — from the other stranded pockets where it never could, so
   * without this a blocked route to any of them paid a full extra A* to
   * discover there had never been a way. **A narrow guard, measured**: the
   * union covers 51,994 of Paradigm's 57,511 rooms, so it rules out the ~5,500
   * in other pockets and nothing else. Worth its one cached sweep because the
   * search it skips is the exhaustive kind — a blocked route walks everything
   * the character can reach — and not worth mistaking for a saving on the
   * ordinary path, which it does not touch.
   */
  private landingReachable: ReadonlySet<RoomId> | null = null;
  /**
   * What each of those edges spends, keyed by the edge — see `buildRoute`.
   *
   * Everything but `at`, which is the one part that is not a property of the
   * item: the edge is shared across every room it could be used in, and where
   * it *was* used is the step's own fact.
   */
  private readonly spends = new Map<PortalExit, Omit<RouteInvocation, 'at'>>();
  /**
   * Every item name the realm has, for recognising one in a line of text.
   * Empty before v11, where the console recognised only the ~100 items some
   * exit needs and whatever the shops stock.
   */
  private itemNames: string[] = [];

  get size(): number {
    return this.rooms.size;
  }

  /**
   * An item an exit asks for, if the realm data can name it.
   *
   * Undefined for anything no exit references — the index is deliberately
   * small — and for a realm built before the index existed.
   */
  /**
   * What the realm knows about items with these names, keyed by the name asked
   * for.
   *
   * By *name*, because a name is all the wire ever gives: an `i` listing writes
   * `padded boots (Feet)` and nothing in it carries the realm's item number.
   * The stripping is the caller's — `sameItem`'s rule, which takes a trailing
   * parenthesised group off — so this only lower-cases and trims.
   *
   * A name the index does not have is simply absent from the result rather than
   * present and empty. About 1,650 of the realm's items are named here — every
   * one some exit demands and every one a shop stocks — which covers gear and
   * does not cover everything a monster drops. Saying nothing about a name it
   * cannot place is the same rule the rest of the world layer follows.
   */
  /**
   * The `Items` row ids a pack holds, for the two exits that ask *is this
   * thing carried* — a `Key:` lock and an `Item:` gate.
   *
   * Takes the names rather than the pack, because the server prints a
   * character's belongings as two listings — `You are carrying …` and `You
   * have the following keys: bone key.` — which land in two fields, and the
   * question is asked of both at once.
   *
   * The join runs name-to-id and refuses where the name is shared. Twenty of
   * the shipped realm's 1,915 item names belong to two or more rows and four
   * of those are keys (`iron key` is three), so a listing naming one says
   * which *kind* of thing is in the pack and not which row — and a door opened
   * on a coin toss is the confidently wrong answer the router refuses
   * everywhere else. Every one of the 26 items the shipped realm gates an exit
   * on has a name of its own, so the refusal costs nothing that is asked for.
   *
   * `bareName` first, because the listing marks what it prints —
   * `katana (Weapon Hand)`, `torch (Readied/79)` — and the realm's row is
   * called `katana`. It lower-cases as it goes, which is the spelling both
   * indexes are keyed on.
   */
  itemIdsCarried(items: readonly { name: string }[]): number[] {
    const ids: number[] = [];
    for (const item of items) {
      const id = this.itemIdNamed(item.name);
      if (id === null) continue;
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  /**
   * The one `Items` row a name can only mean, or null.
   *
   * The whole of the ambiguity rule above, in one place, because two things
   * now ask it: what the pack holds, and what is lying on the floor of the
   * room a keyed door leads out of. Asked twice with two spellings of the rule
   * is the "two halves of one gate" failure, and here the halves would have
   * been *is this the key* and *may I pick this key up*.
   *
   * **A plural is undone only where the index confirms it.** A counted key
   * entry is pluralised on some realms and not on others — `2 black star keys`
   * and `2 golden idols` in captures/002 and /038 against the row names
   * `black star key` and `golden idol`, and a plain `2 bone key` on the wire
   * that reported this (2026-09-06). The count comes off in the parse
   * (`countedName`); the `s` cannot, because nothing there can tell this
   * realm's plural from an item whose name simply ends in one — `padded
   * gloves`, `rigid leather pants`, `spiked leather boots` are all real rows.
   * Here the realm can be asked, so the trailing `s` is dropped **only** when
   * the shorter name is itself a row the index holds unambiguously. That is a
   * confirmation, not the guess `lost()` makes for want of an index.
   */
  itemIdNamed(name: string): number | null {
    const key = bareName(name);
    if (key.length === 0) return null;
    const exact = this.oneRowNamed(key);
    if (exact !== null) return exact;
    return key.endsWith('s') ? this.oneRowNamed(key.slice(0, -1)) : null;
  }

  /** One row for this exact spelling, or null for absent and for shared. */
  private oneRowNamed(key: string): number | null {
    const rows = this.itemRowsByName.get(key);
    // Absent is a name the realm cannot place; more than one is a name that
    // does not say which row. Both are *nobody has said*, not *not carried*.
    if (rows === undefined) return null;
    if (rows.length === 1) return rows[0]!;
    /*
     * Among several, a row the realm offers no way to hold is never the one
     * held: not gettable, and nothing sells, drops or hands it over. Format 42
     * named the furniture and gave `silver box` — the Guildmaster's handover —
     * a fixed twin. Only among several: `acid gland` is `Gettable` 0 and a
     * script hands it over, so the flag alone says nothing about a pack.
     */
    const holdable = rows.filter((id) => this.holdable(id));
    return holdable.length === 1 ? holdable[0]! : null;
  }

  /** Whether the realm offers any way to be holding this row. See `oneRowNamed`. */
  private holdable(id: number): boolean {
    const item = this.items.get(id);
    if (item === undefined || item.gettable !== false) return true;
    return (
      (item.shops?.length ?? 0) > 0 ||
      (item.mobs?.length ?? 0) > 0 ||
      (item.from?.length ?? 0) > 0 ||
      this.stockedBy(id).length > 0
    );
  }

  itemsNamed(names: readonly string[]): Record<string, WorldItem> {
    const found: Record<string, WorldItem> = {};
    for (const name of names) {
      const item = this.itemsByName.get(name.trim().toLowerCase());
      if (item) found[name] = item;
    }
    return found;
  }

  item(id: number): WorldItem | undefined {
    return this.items.get(id);
  }

  /**
   * What the realm says a monster of this name is worth in health.
   *
   * Case- and article-insensitive, because the stream is not consistent about
   * either: `The giant rat bites you` and `You slash the giant rat` produce the
   * same monster spelled two ways, and the realm data is `giant rat`.
   *
   * Undefined for a name the realm does not carry — a realm built before this
   * index existed, a derivative that renamed things, or a monster that simply
   * is not in the table. That is a first-class answer: the caller falls back to
   * what it has learned by fighting, and says so.
   */
  mob(name: string): WorldMob | undefined {
    return this.mobs.get(mobKey(name));
  }

  /**
   * Every monster name this realm holds, alphabetically — the priority list's
   * picker.
   *
   * Names alone, and the whole list in one answer rather than a query per
   * keystroke: the shipped realm names 849 monsters, which is a list the
   * picker can rank and cap in the renderer exactly as it does the potion
   * items, and asking once when the section opens is what `itemsServing`
   * already does for the same reason. A realm large enough for that to stop
   * being true would want a query, and this is where it would go.
   */
  mobNames(): string[] {
    return [...this.mobs.values()].map((mob) => mob.name).sort((a, b) => a.localeCompare(b));
  }

  /** How many monsters the realm named. Zero on a realm built before v3. */
  get mobCount(): number {
    return this.mobs.size;
  }

  // ---------------------------------------------------------------------
  // Entity builders
  //
  // The join between what the wire saw and what the realm knows, made in
  // main at the moment a block is parsed. Every one of these returns a
  // **whole** entity for a name the realm has never heard of — that is the
  // dual-source rule in `src/shared/entities.ts`, and it is what keeps the
  // client working on a derivative realm rather than degrading to nothing.
  // ---------------------------------------------------------------------

  /**
   * A thing, joined to the realm's row for it where there is one.
   *
   * The wire's facts are the arguments and are never overwritten: the slot a
   * listing named, whether it is in use, and how many charges are left are
   * observations about *this* one, and the realm's row is about the kind.
   */
  buildItemEntity(
    rawName: string,
    observed: {
      slot?: string | null;
      slotSource?: 'realm';
      equipped?: boolean;
      charges?: number | null;
      count?: number;
      rawText?: string;
    } = {}
  ): ItemEntity {
    const name = rawName.trim();
    const known = this.itemsByName.get(name.toLowerCase());
    const entity: ItemEntity = {
      name,
      source: known === undefined ? 'wire' : 'hybrid',
      slot: observed.slot ?? null,
      equipped: observed.equipped ?? false,
      charges: observed.charges ?? null
    };
    if (observed.slotSource !== undefined) entity.slotSource = observed.slotSource;
    if (observed.count !== undefined) entity.count = observed.count;
    if (observed.rawText !== undefined) entity.rawText = observed.rawText;
    if (known === undefined) return entity;

    entity.id = known.id;
    /*
     * And every row the *name* holds, which is what a card prints as this
     * thing's number. `id` above is `itemsByName`'s first row and the one the
     * shops reference; for twenty of the shipped realm's names that is one of
     * several, and printing it would make the same claim `oneRowNamed`
     * refuses to make about a key.
     */
    const rows = this.itemRowsByName.get(name.toLowerCase());
    if (rows !== undefined && rows.length > 0) entity.ids = rows;
    this.fillFromRow(entity, known);
    /*
     * A realm row with nothing observed against it — a shop's shelf, a drop
     * table — is `mdb` rather than `hybrid`. The distinction is what lets a
     * card say "the realm says this shop stocks it" apart from "this is in
     * your pack".
     */
    if (
      observed.slot === undefined &&
      observed.equipped === undefined &&
      observed.charges === undefined &&
      observed.count === undefined &&
      observed.rawText === undefined
    ) {
      entity.source = 'mdb';
    }
    return entity;
  }

  /**
   * A floor item settled to the row this room places — format 42.
   *
   * A name several rows share says nothing about which is lying here, and the
   * entity is built from the first; but a room placing exactly one of them
   * has said, as a lair says which monster row stands in it
   * (`resolveMobRow`). The Treasure Room's `wooden box` is its own fixed row,
   * not the loot row a lookup by name answers with. Anything else comes back
   * as it was.
   */
  itemPlacedHere(item: ItemEntity, room: WorldRoom): ItemEntity {
    const rows = item.ids;
    const placed = room.placed;
    if (rows === undefined || rows.length < 2 || placed === undefined) return item;
    const here = rows.filter((id) => placed.includes(id));
    const known = here.length === 1 ? this.items.get(here[0]!) : undefined;
    if (known === undefined) return item;
    const entity: ItemEntity = {
      name: item.name,
      source: item.source,
      slot: item.slot,
      equipped: item.equipped,
      charges: item.charges,
      ...(item.slotSource === undefined ? {} : { slotSource: item.slotSource }),
      ...(item.count === undefined ? {} : { count: item.count }),
      ...(item.rawText === undefined ? {} : { rawText: item.rawText }),
      id: known.id,
      ids: rows,
      row: { id: known.id }
    };
    this.fillFromRow(entity, known);
    return entity;
  }

  /** What an item's realm row says, onto an entity being built. */
  private fillFromRow(entity: ItemEntity, known: WorldItem): void {
    if (known.price !== undefined) entity.price = known.price;
    if (known.encumbrance !== undefined) entity.encumbrance = known.encumbrance;
    if (known.kind !== undefined) entity.kind = known.kind;
    if (known.worn !== undefined) entity.wornSlotCode = known.worn;
    if (known.slot !== undefined) entity.realmSlot = known.slot;
    if (known.weapon !== undefined) entity.weapon = known.weapon;
    if (known.armour !== undefined) entity.armour = known.armour;
    if (known.uses !== undefined) entity.uses = known.uses;
    if (known.abilities !== undefined) entity.abilities = known.abilities;
    if (known.classes !== undefined) entity.classes = known.classes;
    if (known.races !== undefined) entity.races = known.races;
    if (known.minLevel !== undefined) entity.minLevel = known.minLevel;
    if (known.gettable !== undefined) entity.gettable = known.gettable;
    if (known.notDroppable !== undefined) entity.notDroppable = known.notDroppable;
    if (known.limit !== undefined) entity.limit = known.limit;
    if (known.shops !== undefined) entity.shops = known.shops;
    if (known.mobs !== undefined) entity.droppedBy = known.mobs;
  }

  /**
   * A monster, joined to the realm's row.
   *
   * The name is looked up through `mobNameCandidates` — least stripping first,
   * because `MobNameModifierType` hangs a word off either end and a shorter
   * name is a *different monster* whose disposition decides whether the client
   * swings. `rawName` keeps what the server printed, because that is what a
   * command has to name.
   *
   * `drops` is resolved to entities rather than left as names: choosing a
   * target by what it carries is the question `WorldMob.drops` could not
   * answer, since a bare name has no price and no weight.
   */
  buildMobEntity(
    rawName: string,
    observed: { charmed?: boolean; at?: RoomId | null } = {}
  ): MobEntity {
    const raw = rawName.trim();
    /*
     * Least stripping first (`mobAsPrinted`, inside `mobAt`).
     * `MobNameModifierType` hangs a whole run of words off either end, so
     * `small elite guardsman` has to reach `guardsman` — and the ladder is
     * ordered so the *longest* name that matches wins, because a shorter one
     * is a different monster whose disposition decides whether the client
     * swings. One rule, shared with the classifier, or the two ends of the
     * client disagree about what the realm knows.
     *
     * `at` is the room the name was printed in, where the caller has one: it
     * resolves a name holding several of the realm's rows to the one that
     * spawns here rather than to the worst of them. See `resolveMobRow`.
     */
    const known = this.mobAt(raw, observed.at ?? null);
    const entity: MobEntity = {
      name: known?.name ?? raw,
      rawName: raw,
      source: known === undefined ? 'wire' : 'hybrid',
      charmed: observed.charmed ?? false,
      // A monster the realm cannot place is `null`, and null is never safe —
      // the same three-state `RoomOccupant` has always carried.
      disposition: known?.disposition ?? null,
      uncertain: known?.uncertain ?? false,
      costly: known?.costly ?? 'never'
    };
    if (known === undefined) return entity;

    if (known.row !== undefined) entity.row = known.row;
    // Every `Monsters` row the name holds, for the number a card prints. The
    // fold is by name, so this is the list `row` was resolved out of — and
    // where nothing resolved it, the list is the honest answer. See
    // `entityNumber`.
    if (known.ids !== undefined) entity.ids = known.ids;
    entity.hp = known.hp;
    if (known.span !== undefined) entity.span = known.span;
    if (known.armour !== undefined) entity.armour = known.armour;
    if (known.damageResist !== undefined) entity.damageResist = known.damageResist;
    if (known.magicResist !== undefined) entity.magicResist = known.magicResist;
    if (known.experience !== undefined) entity.experience = known.experience;
    if (known.regen !== undefined) entity.regen = known.regen;
    if (known.regenHours !== undefined) entity.regenHours = known.regenHours;
    if (known.follows !== undefined) entity.follows = known.follows;
    if (known.undead !== undefined) entity.undead = known.undead;
    if (known.abilities !== undefined) entity.abilities = known.abilities;
    if (known.averageDamage !== undefined) entity.averageDamage = known.averageDamage;
    if (known.charmLevel !== undefined) entity.charmLevel = known.charmLevel;
    if (known.casts !== undefined) entity.casts = known.casts;
    if (known.deathSpell !== undefined) entity.deathSpell = known.deathSpell;
    /*
     * Format 20. The profiles ride along whole, and every spell they or the
     * death spell name is resolved here — the decision that reads them is
     * made from the room's occupants in `AutoCombat`, which holds no realm
     * and must not ask one per status line.
     */
    if (known.profiles !== undefined) entity.profiles = known.profiles;
    const named = new Set<number>();
    for (const profile of known.profiles ?? []) {
      for (const attack of profile.attacks) {
        if (attack.kind === 'spell') named.add(attack.spell);
        else if (attack.onHit !== undefined) named.add(attack.onHit);
      }
      for (const cast of profile.casts) named.add(cast.spell);
    }
    if (known.deathSpell !== undefined) named.add(known.deathSpell);
    const spells: Record<number, WorldSpell> = {};
    let resolved = 0;
    for (const id of named) {
      const spell = this.spellById(id);
      if (spell === null) continue;
      spells[id] = spell;
      resolved += 1;
    }
    if (resolved > 0) entity.spells = spells;
    if (known.realmTypes !== undefined && known.realmTypes.length > 0) {
      entity.realmType = known.realmTypes[0];
    }
    if (known.drops !== undefined && known.drops.length > 0) {
      entity.drops = known.drops.map((drop) => this.buildItemEntity(drop));
    }
    return entity;
  }

  /**
   * The creature the realm ties to a room, or null.
   *
   * `npcType` is filled **only from the room's own shop**, which is a join the
   * data supports: the realm records which shop a room holds and `shopKind`
   * reads what kind it is. `Monsters.Type` is deliberately not read as
   * shopkeeper/trainer/guard — measured 2026-09-02, it does not mean that, and
   * a wrong label here would put "banker" on a werewolf.
   */
  buildNpcEntity(room: WorldRoom): NpcEntity | null {
    if (room.npcId === undefined) return null;
    const known = this.mobsById.get(room.npcId);
    if (known === undefined) return null;
    /*
     * The room names the row, so the resident answers as itself rather than as
     * the worst of the rows sharing its name — the same evidence a lair gives,
     * and `disposition` is the one thing here the fold takes a worst-of.
     */
    const row = this.rowsById.get(room.npcId);
    const entity: NpcEntity = {
      name: known.name,
      source: 'mdb',
      id: room.npcId,
      disposition: row === undefined ? known.disposition : row.disposition,
      costly: known.costly
    };
    if (room.shop !== undefined) {
      entity.shopId = room.shop;
      const kind = this.shop(room.shop)?.kind;
      const role = kind === undefined ? undefined : NPC_ROLE_OF[kind];
      if (role !== undefined) entity.npcType = role;
    }
    return entity;
  }

  /**
   * The room's ways out, joined to where each one goes.
   *
   * The wire's directions lead: an exit the server printed is real whatever the
   * realm says, and one the realm knows that the server did not print is not
   * added — the server is the authority on what is *there now*. What the join
   * adds is the destination, its name, what the passage demands and the item
   * that opens it, which is what lets a card draw an obstacle badge and name a
   * key without a round trip.
   */
  buildExitEntities(exits: ReadonlyArray<RoomExit>, from?: WorldRoom | null): ExitEntity[] {
    const known = new Map<string, WorldExit>();
    for (const exit of from?.exits ?? []) known.set(exit.direction.toLowerCase(), exit);
    return exits.map((exit) => {
      const match = known.get(exit.direction.toLowerCase());
      const entity: ExitEntity = {
        direction: exit.direction,
        note: exit.note,
        targetMap: match?.map ?? null,
        targetRoom: match?.room ?? null,
        targetName: null,
        requirement: match?.requirement ?? null
      };
      if (match !== undefined) {
        const destination = this.get(match.map, match.room);
        if (destination !== undefined) {
          entity.targetName = destination.name;
          // The realm's own light level, which is a different claim from the
          // phrase the server prints on arrival. Negative is dark; nothing
          // here encodes a threshold beyond that sign.
          if (destination.light !== undefined) entity.dark = destination.light < 0;
        }
        if (match.requirement !== null) {
          entity.obstacle = describeObstacle(
            match.requirement,
            this,
            from === null || from === undefined
              ? []
              : this.leversHere(roomId(from.map, from.room), match.direction)
          );
          const key = match.requirement.keyId;
          if (key !== undefined) {
            const item = this.item(key);
            entity.keyItem = item === undefined ? null : this.buildItemEntity(item.name);
          }
        }
      }
      return entity;
    });
  }

  /**
   * What a shop stocks, with every item named.
   *
   * The whole point of carrying this: a shop is a property of a *room*, the
   * realm data records which shop a room holds, and so standing in one is
   * enough to know what it sells — without spending a command on `list`.
   * Undefined for a shop number the realm has no stock for, which includes
   * every placeholder row in the table and every realm built before v4.
   */
  shop(id: number): WorldShop | undefined {
    return this.shops.get(id);
  }

  /**
   * Every room the realm says holds a shop, for walking to the nearest one.
   *
   * A shop is a property of a room, so "where can I buy something" is a walk
   * the world graph can plan without asking the server anything.
   */
  /** A monster by the realm's own number. Undefined on a realm built before v9. */
  mobById(id: number): WorldMob | undefined {
    return this.mobsById.get(id);
  }

  /** One row, answering for itself. Undefined for a name the realm places once. */
  mobRow(id: number): WorldMobRow | undefined {
    return this.rowsById.get(id);
  }

  /**
   * Which of a name's rows is standing in this room, and on what evidence.
   *
   * The wire carries no row number, so a name has always folded every row
   * sharing it and taken the worst of them: `gnoll scout` is row 224, a
   * 100-HP scout, and row 2204, an 830-HP one, and the card answered
   * `100–830 hp` and priced the fight at 2,161 hp of chewing. But the *room*
   * is evidence, and a strong one — the realm says which rows it spawns, and
   * a monster does not walk far from where it spawned.
   *
   * Two rungs, and a refusal under both:
   *
   * 1. **Here.** The room's own lair or resident names exactly one of the
   *    rows. Nothing beats this and nothing is searched.
   * 2. **Nearest.** Breadth-first from the room over walkable exits, keeping
   *    the first distance at which each row is reached, and stopping once the
   *    answer can no longer change: past `mobRowMargin` times the nearest hit
   *    there is no runner-up that could still be called close. The nearest row
   *    wins only by that margin, so five steps against a thousand resolves and
   *    five against seven does not.
   *
   * Otherwise null, which leaves the fold and its stated range exactly as they
   * were — an ambiguous room is one to report rather than one to guess at.
   * Doors, keys and level gates are walked through here: a monster that spawns
   * behind a locked door is still the one in front of you, and refusing to
   * count it would make the wrong row look nearest.
   */
  resolveMobRow(name: string, from: RoomId | null): MobRowChoice | null {
    const mob = this.mobAsPrinted(name);
    const ids = mob?.ids;
    // One row is not a choice, and a realm with no per-row records has nothing
    // to resolve *to*: the fold is already every answer the file holds.
    if (mob === undefined || ids === undefined || ids.length < 2) return null;
    if (from === null || !this.rooms.has(from)) return null;
    const wanted = new Set(ids.filter((id) => this.rowsById.has(id)));
    if (wanted.size < 2) return null;

    const key = `${from}|${mob.name}`;
    const held = this.resolvedRows.get(key);
    if (held !== undefined) return held;
    const answer = this.searchMobRow(from, wanted);
    // Bounded like any per-session cache: a character walks through rooms and
    // meets names, and the pair is what would otherwise grow without end.
    if (this.resolvedRows.size >= RESOLVED_ROW_CACHE) this.resolvedRows.clear();
    this.resolvedRows.set(key, answer);
    return answer;
  }

  /** The two rungs of `resolveMobRow`, once the candidates are known. */
  private searchMobRow(from: RoomId, wanted: ReadonlySet<number>): MobRowChoice | null {
    const here = this.rooms.get(from);
    if (here === undefined) return null;

    /*
     * Rung one: what the realm says spawns in this very room. A resident and a
     * lair are both claims about *this* room, and one of them naming exactly
     * one candidate ends the question — there is nothing a distance could add.
     */
    const named = new Set<number>();
    if (here.npcId !== undefined && wanted.has(here.npcId)) named.add(here.npcId);
    if (here.lair !== undefined) {
      for (const id of parseLair(here.lair).ids) if (wanted.has(id)) named.add(id);
    }
    if (named.size === 1) {
      const [id] = [...named];
      return { id: id!, how: 'here', steps: 0, beyond: null };
    }
    // Two of the name's rows spawn in this room: the room cannot tell them
    // apart, and neither can anything downstream of it.
    if (named.size > 1) return null;

    /*
     * Rung two. The reverse index is already built for the Reference card's
     * *spawns in* list, so the target set is a lookup rather than a scan, and
     * the sweep tests each room against a handful of addresses.
     */
    const targets = new Map<RoomId, number>();
    const spawns = this.mobRooms();
    for (const id of wanted) {
      for (const entry of spawns.get(id) ?? []) {
        const at = roomId(entry.room.map, entry.room.room);
        // First writer wins, so a room two rows both spawn in resolves to
        // neither: it is added under the first and read back as a tie below.
        if (!targets.has(at)) targets.set(at, id);
        else if (targets.get(at) !== id) targets.set(at, TIED_ROW);
      }
    }
    if (targets.size === 0) return null;

    /*
     * The margin is what makes this a resolution rather than a coin toss.
     * Nearest-wins on its own would answer *row 224* for a room one step
     * nearer 224 than 2204, which is evidence of nothing — a monster wanders,
     * and it is dragged. So the sweep runs out to `mobRowMargin` times the
     * first hit's distance and the answer stands only if nothing else of the
     * name turned up inside it: a second row found anywhere in that ring is a
     * refusal, and the sweep past it would be spent learning by how much.
     */
    const { mobRowMargin, mobRowRooms } = tuning().world;
    const found = new Map<number, number>();
    const seen = new Set<RoomId>([from]);
    let queue: RoomId[] = [from];
    let closest: number | null = null;
    let reached = 0;
    for (let depth = 0; queue.length > 0 && seen.size <= mobRowRooms; depth += 1) {
      if (closest !== null && depth > closest * mobRowMargin) break;
      reached = depth;
      const next: RoomId[] = [];
      for (const id of queue) {
        const hit = targets.get(id);
        // A room two of the rows share says both are here and neither is
        // nearer, which is a tie at this distance rather than a resolution.
        if (hit === TIED_ROW) return null;
        if (hit !== undefined && !found.has(hit)) {
          if (found.size > 0) return null;
          found.set(hit, depth);
          closest = depth;
        }
        for (const exit of this.rooms.get(id)?.exits ?? []) {
          const to = roomId(exit.map, exit.room);
          if (seen.has(to)) continue;
          seen.add(to);
          next.push(to);
        }
      }
      queue = next;
    }
    const [best] = [...found.entries()];
    if (best === undefined) return null;
    return { id: best[0], how: 'nearest', steps: best[1], beyond: reached };
  }

  /**
   * A monster by name, answering as the row this room resolves it to.
   *
   * The one overlay point. Everything that asks the realm what a name is worth
   * — the card, the appraisal auto-combat ranks on, the health bar's maximum —
   * comes through here, so a room that can tell two rows apart tells all of
   * them at once and none of them can disagree about it. A room that cannot,
   * or a name the realm places once, gets the fold it always got.
   */
  mobAt(name: string, from: RoomId | null): WorldMob | undefined {
    const mob = this.mobAsPrinted(name);
    if (mob === undefined) return undefined;
    const choice = this.resolveMobRow(name, from);
    if (choice === null) return mob;
    const row = this.rowsById.get(choice.id);
    return row === undefined ? mob : mobAsRow(mob, row, choice);
  }

  /**
   * What a room's lair spawns, resolved.
   *
   * The descriptor is verbatim realm data — `(Max 2): 781,190,` — and the
   * numbers are the only key the room table has for its monsters. Resolved
   * here rather than at build time so the descriptor stays what the realm
   * said, and a realm built before v9 simply answers nothing.
   */
  lairOf(room: WorldRoom): WorldMob[] {
    // The clock is discarded here: this asks what spawns, never when.
    return this.lair(room, null)?.mobs ?? [];
  }

  /**
   * The lair whole: how many at once, and what. Null only for a room the
   * realm does not mark as one — the same test the map's glyph makes, so the
   * two cannot disagree. A descriptor naming no monster this table knows
   * (a derivative that added monsters after this data was built) comes back
   * with an empty list rather than null, so the face can say *that* instead
   * of the map promising a lair the card silently declines to show.
   *
   * **By the row, because the descriptor names one.** A lair is the strongest
   * evidence about a monster there is — stronger than the search
   * `resolveMobRow` runs for a name off the wire, because there is nothing to
   * search for: `(Max 1): 224,` says row 224, and row 224 is a 100-HP gnoll
   * scout. Read through the fold, the room quick view answered `100–830 hp`
   * about that room — the range across row 224 and row 2204, an 830-HP scout
   * that spawns somewhere else entirely — and the Room card's own `LAIR` face
   * said the same about the room the character was standing in.
   *
   * **The family is the caller's**, and it is not this file's `info.family`:
   * the clock's only interpretation that is not in the column is GreaterMUD's
   * thirty-second offset, which is a behaviour of the *server* rather than of
   * the data — and on the shipped configuration the two legitimately disagree
   * (a Paradigm-built world file against a GreaterMUD default realm; see
   * `SessionManager.noteFamily`). Null is *unknown*, and reads as the nominal
   * figure, which is the longer of the two.
   */
  lair(room: WorldRoom, family: RealmFamily | null): WorldLair | null {
    if (!room.lair) return null;
    // `parseLair` reads the descriptor, and reads *only* the monster numbers in
    // it — see its own note for the four that were being invented per lair.
    const { max, ids } = parseLair(room.lair);
    const mobs: WorldMob[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const mob = this.mobsById.get(id);
      if (mob === undefined) continue;
      const row = this.rowsById.get(id);
      /*
       * A row is its own identity; the fold's is the name. So where the file
       * carries rows a descriptor naming 224 and 2204 names *two* monsters and
       * gets two lines, and where it does not — a realm built before format 32
       * — the fold is every answer the file holds and two ids of one name are
       * one line, as they have always been.
       */
      const key = row === undefined ? `n:${mob.name}` : `r:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mobs.push(row === undefined ? mob : mobAsRow(mob, row, namedHere(id)));
    }
    /*
     * And when it fills again — `Rooms.Delay` (format 33), read here so the
     * Room card's face and the map's quick view cannot come to two answers
     * about one room's clock. `respawnSeconds` is the one reading of the
     * column and stays that.
     */
    const { greatermudRespawnOffsetSeconds } = tuning().hunting;
    return {
      max,
      respawnSeconds: respawnSeconds(room.delay ?? null, family, {
        greatermudRespawnOffsetSeconds
      }),
      mobs
    };
  }

  /**
   * What a room's lair spawns, weighed as the rows the lair names.
   *
   * `lair()`'s answer in the shape a price is taken from: the same rows, with
   * the drops resolved and the profiles whole, because `weighVerdicts` reads a
   * `MobEntity` and a readout reads a `WorldMob`. Both come off the row the
   * descriptor names — the guard post on the Hillside Path names row 224, a
   * 100-HP scout that lands one blow in twenty-five against a level-12
   * Paladin, not row 2204, the 830-HP one that swings four times a round, and
   * weighed by name the room was expected to kill a character it could barely
   * scratch (todo 01, 2026-09-10).
   *
   * A file written before format 32 has nothing per row and degrades to the
   * fold, which is the dangerous reading rather than the reassuring one.
   * Empty for a room that is not a lair, and for a descriptor naming rows this
   * table lacks.
   */
  lairEntities(room: WorldRoom): MobEntity[] {
    if (!room.lair) return [];
    const entities: MobEntity[] = [];
    for (const id of parseLair(room.lair).ids) {
      const mob = this.mobsById.get(id);
      if (mob === undefined) continue;
      const entity = this.buildMobEntity(mob.name);
      overlayRow(entity, this.rowsById.get(id));
      entities.push(entity);
    }
    return entities;
  }

  /**
   * The room's placed resident (`Rooms.NPC`), weighed as its own row — the
   * same reading `lairEntities` gives a lair, for the room that has a boss
   * rather than a lair. Its clock is the row's `regenHours`, not the room's
   * `delay`. Empty for a room with no resident, or one this table lacks.
   */
  residentEntities(room: WorldRoom): MobEntity[] {
    if (room.npcId === undefined) return [];
    const mob = this.mobsById.get(room.npcId);
    if (mob === undefined) return [];
    const entity = this.buildMobEntity(mob.name);
    overlayRow(entity, this.rowsById.get(room.npcId));
    return [entity];
  }

  /**
   * Every room within `steps` moves of `from`, with the fewest steps to each
   * — a plain breadth-first sweep over the exits and portals, pricing nothing.
   *
   * For a question about the *neighbourhood* (where to hunt, todo 05) rather
   * than a way to one room: a route per candidate costs the main thread
   * 51ms median on Paradigm and there are thousands of candidates, while
   * this walks each room once. A door or a level gate is an exit here; the
   * route the reader then asks for prices it. Bounded by `steps`, and by the
   * realm: a sweep that reaches nothing new stops.
   */
  withinSteps(from: RoomId, steps: number, traveller?: Traveller): Map<RoomId, number> {
    const seen = new Map<RoomId, number>();
    if (!this.rooms.has(from)) return seen;
    seen.set(from, 0);
    let frontier: RoomId[] = [from];
    for (let depth = 1; depth <= steps && frontier.length > 0; depth += 1) {
      const next: RoomId[] = [];
      for (const id of frontier) {
        const room = this.rooms.get(id);
        if (room === undefined) continue;
        const ways = [
          /*
           * **A way this traveller cannot take is not a way** (todo 09,
           * 2026-09-13). Without the traveller this sweep is the plain
           * neighbourhood and a locked door is an exit — which is right for
           * *what is near* and wrong for *where could this character go*: the
           * hunting survey offered lairs behind gates it could not route
           * through, and a loop started on one stood still. `edgePenalty`
           * answers `null` for exactly the conditions that are impassable
           * rather than merely expensive, which is the same test the router
           * makes one step at a time.
           */
          ...room.exits
            .filter(
              (exit) =>
                /*
                 * And a draw is not a way either, whoever is asking. A scatter
                 * reaches no *particular* room, so counting the room its exit
                 * table names as one step away is the reading that had the
                 * hunting survey offering lairs across the Warped Asylum as
                 * neighbours of the ward outside it.
                 */
                exit.requirement?.spellEffect !== 'scatters' &&
                (traveller === undefined ||
                  edgePenalty(exit.requirement ?? null, traveller) !== null)
            )
            .map((exit) => this.beyond(exit)),
          // And the same of a portal, which carries a `level` requirement of
          // its own where the realm gates one (`linkPortals`).
          ...this.portalsFrom(id)
            .filter(
              (portal) =>
                traveller === undefined ||
                edgePenalty(portal.requirement ?? null, traveller) !== null
            )
            .map((portal) => roomId(portal.map, portal.room))
        ];
        for (const to of ways) {
          if (seen.has(to) || !this.rooms.has(to)) continue;
          seen.set(to, depth);
          next.push(to);
        }
      }
      frontier = next;
    }
    return seen;
  }

  /**
   * What a room's own spell does to whoever stands in it, or null.
   *
   * The room carries a spell id; the hazard is on the spell, because 159
   * spells cover 13,603 rooms and writing the same answer onto each of the 845
   * Silver River rooms would be a megabyte for nothing. This is the join, and
   * the one place it is made — `Traveller.hazard`, the route's own steps and
   * the room quick view all come through here.
   *
   * Null for a room with no spell, a spell the realm does not hold, and a
   * spell whose chain reaches nothing worth pricing. The last is the ordinary
   * case: two thirds of the realm's room spells are scenery.
   */
  hazardOf(room: WorldRoom, level?: number | null): SpellHazard | null {
    if (room.spell === undefined) return null;
    const hazard = this.spellById(room.spell)?.hazard ?? null;
    /*
     * Narrowed to the character being planned for, where the realm gates an
     * effect on level and the client knows which character it is (todo 01).
     * This is the one join, so it is the one place the narrowing can be made
     * without a reader forgetting to — and `hazardFor` keeps the whole hazard
     * for an unstated level, which is the ordinary refuse-rather-than-guess
     * answer and what every caller got before.
     */
    return hazard === null ? null : hazardFor(hazard, level);
  }

  shopRooms(): WorldRoom[] {
    return [...this.rooms.values()].filter((room) => room.shop !== undefined);
  }

  /**
   * Where a shop of this name is, by the name the item index states.
   *
   * `WorldItem.shops` names shops; a shop is a property of a *room*; and there
   * was no join between the two, so `Sold by: General Store` was a lead the
   * client could print and not act on. This is the join.
   *
   * **Built once, lazily, and keyed by name.** A scan of 55,806 rooms per
   * clicked shop is the N+1 this codebase already refuses elsewhere, and the
   * index is the same shape `byName` already keeps for room names.
   *
   * Undefined for a name the realm places in no room — 11 of the shipped
   * realm's 242 shops — which is the honest answer rather than an empty room.
   */
  shopPlace(name: string): ShopPlace | undefined {
    const key = name.trim().toLowerCase();
    if (key.length === 0) return undefined;
    const rooms = this.shopsByName().get(key);
    if (rooms === undefined || rooms.length === 0) return undefined;
    const only = rooms.length === 1 ? rooms[0] : undefined;
    /*
     * One room is a place; several is an ambiguity, and it is *reported* with
     * its count rather than resolved by taking the first. Picking would send a
     * character to whichever of six trainers the file happened to list first,
     * which is the confidently wrong answer this project refuses everywhere a
     * location is concerned.
     */
    return only === undefined
      ? {
          at: 'several',
          count: rooms.length,
          rooms: rooms
            .slice(0, 24)
            .map((room) => ({ map: room.map, room: room.room, roomName: room.name }))
        }
      : { at: 'one', map: only.map, room: only.room, roomName: only.name };
  }

  /**
   * Where to buy a thing on the way to somewhere — best first (2026-09-16).
   *
   * Reported: a character in the Alchemist's Hut, asked to fetch a `log raft`
   * for the Silver River, was told *nowhere to buy log raft: 2 rooms hold a
   * shop called Boat Launch* — while standing on a route that walks **through**
   * one of the two. Three separate mistakes met there, and this answers all
   * three: the client ranked shops it could only address by **name**, priced
   * that name at infinity the moment it stood in two rooms, and then asked
   * `shopPlace` to resolve it and was refused for the ambiguity it had created.
   *
   * **The detour is the quantity.** Not the distance from here, which is what
   * this replaced: with the character's real pack, the nearest raft counter by
   * distance is unreachable altogether and the two that are reachable sit 47
   * and 318 steps off the way. What a person asking where to stop for petrol
   * wants is how far off the road it is, and that is
   * `here → counter → there` less `here → there`, priced by this traveller like
   * every other plan main makes. Zero for a counter the route already passes.
   *
   * **The way on is walked carrying what was bought**, which is the whole point
   * of the errand: the raft is being fetched *because* it quietens the river,
   * so pricing the second leg without it would rank every counter by a journey
   * nobody is going to take. `holding` is that traveller.
   *
   * **Price breaks the tie and never more than that** — see
   * `tuning.supplies.dearerSteps`. A counter the realm places nowhere reachable
   * is left out rather than ranked last: there is no walk to it to price.
   *
   * `to` is null for the supply list's own errand, which has no destination —
   * then the trip *is* the detour and this ranks by what it costs to get there.
   */
  buyingPlaces(item: number, from: RoomId, to: RoomId | null, traveller: Traveller): BuyingPlace[] {
    return this.buyingPlacesFor([item], from, to, traveller);
  }

  /**
   * The same for a whole stock list on one pair of sweeps — what topping each
   * row up would add to *this* leg, so a plan can put the shopping on the leg
   * that passes nearest the counter. `buyingPlacesFor`'s reason exactly: a
   * sweep pair per row over a nine-step chain is Dijkstras on the socket's
   * thread for a handful of torches.
   */
  stockingPlaces(
    items: readonly number[],
    from: RoomId,
    to: RoomId | null,
    traveller: Traveller
  ): Array<BuyingPlace & { item: number }> {
    return this.buyingPlacesFor(items, from, to, traveller);
  }

  /**
   * The same for several items at once, on one pair of sweeps: every counter
   * stocking any of them, priced together, each place saying which item it
   * is for. `supplyFor` asks about the two to four things the realm says stop
   * one spell, and a sweep pair per item was eight Dijkstras on the socket's
   * thread for a river crossing (review, 2026-09-21).
   */
  private buyingPlacesFor(
    items: readonly number[],
    from: RoomId,
    to: RoomId | null,
    traveller: Traveller
  ): Array<BuyingPlace & { item: number }> {
    const candidates: Array<{ item: number; room: WorldRoom }> = [];
    for (const item of items) {
      for (const room of this.stockRooms(item)) candidates.push({ item, room });
    }
    if (candidates.length === 0) return [];
    const wanted = new Set(candidates.map(({ room }) => roomId(room.map, room.room)));
    const head = this.sweepTo(from, wanted, traveller);
    /*
     * One sweep backwards from the destination answers both halves at once:
     * what each counter costs to leave from, and — by asking about `from` in
     * the same sweep — the journey the detour is measured against. Two Dijkstras
     * in total, whatever the realm holds counters for, rather than a route per
     * candidate.
     */
    const back =
      to === null
        ? null
        : this.sweepBack(
            new Map([[to, 0]]),
            new Set([...wanted, from]),
            items.reduce((held, item) => this.holding(held, item), traveller),
            true
          );
    /*
     * The journey the detour is measured against. Undefined is a destination
     * nothing reaches from here, which is not this question's to answer and not
     * a reason to say the thing is sold nowhere: the trip to the counter is
     * then the whole of what stopping costs, exactly as when there is no
     * destination at all.
     */
    const base = back?.get(from);
    const places: Array<BuyingPlace & { item: number }> = [];
    for (const { item, room } of candidates) {
      const id = roomId(room.map, room.room);
      const reach = head.get(id);
      // Nothing the router can walk leads there, so there is no detour to
      // state. Left out rather than ranked last: a figure would be a fiction.
      if (reach === undefined) continue;
      const shop = room.shop === undefined ? undefined : this.shops.get(room.shop);
      if (shop === undefined) continue;
      let detour = reach.cost;
      if (back !== null && base !== undefined) {
        const tail = back.get(id);
        // Reachable, but the journey cannot go on from it. Left out for the
        // same reason: stopping here would end the trip rather than delay it.
        if (tail === undefined) continue;
        detour = reach.cost + tail - base;
      }
      places.push({
        map: room.map,
        room: room.room,
        roomName: room.name,
        shop: shop.name,
        markup: shop.markup ?? 0,
        /*
         * Never negative, and the two legs are deliberately priced on
         * *different* graphs: the way there without the thing, the way on with
         * it. Carrying it can only ever make a step cheaper, so the way there
         * costs at least what it would carrying it, and that plus the way on is
         * at least the whole journey carrying it — which is the baseline. A
         * rounded zero is the counter the route already walks through.
         */
        detour: Math.max(0, Math.round(detour)),
        moves: reach.moves,
        item
      });
    }
    const dearer = tuning().supplies.dearerSteps;
    return places.sort(
      (a, b) =>
        buyingRank(a, dearer) - buyingRank(b, dearer) ||
        a.moves - b.moves ||
        a.map - b.map ||
        a.room - b.room
    );
  }

  /**
   * Item id -> the rooms whose counter stocks it, built once.
   *
   * By **id**, like `stockedBy` beside it and for the same reason: a shop
   * stocks rows, and the realm repeats item names across rows.
   */
  private stockRooms(item: number): readonly WorldRoom[] {
    if (this.stocking === null) {
      const index = new Map<number, WorldRoom[]>();
      for (const room of this.rooms.values()) {
        if (room.shop === undefined) continue;
        const shop = this.shops.get(room.shop);
        if (shop === undefined) continue;
        // A shelf may list one row twice; the room is still one place to go.
        const seen = new Set<number>();
        for (const line of shop.items) {
          if (seen.has(line.id)) continue;
          seen.add(line.id);
          const held = index.get(line.id);
          if (held === undefined) index.set(line.id, [room]);
          else held.push(room);
        }
      }
      this.stocking = index;
    }
    return this.stocking.get(item) ?? [];
  }

  /**
   * This traveller, with one more thing in the pack.
   *
   * `carrying` above switches off **every** hazard an item could quieten,
   * because it is asking what the whole kit would buy. This is the narrower
   * question — the character is about to hold *this* row and nothing else new —
   * so the item joins `keys`, which opens the doors it is a key to, and the
   * hazards it stops go quiet through the same `hazardAvoided` join the router
   * uses everywhere. Nothing else about the traveller moves.
   */
  private holding(traveller: Traveller, item: number): Traveller {
    const keys = [...(traveller.keys ?? []), item];
    const priced = traveller.hazard;
    if (priced === undefined) return { ...traveller, keys };
    return {
      ...traveller,
      keys,
      hazard: (room) => {
        const hazard = this.hazardOf(room, traveller.level);
        return hazard !== null && hazardAvoided(hazard, keys) ? null : priced(room);
      }
    };
  }

  /**
   * Where the realm spawns a monster, grouped by the name of the room.
   *
   * The reverse of the two columns the world file has always carried and only
   * ever read forwards — `Rooms.NPC` and `Rooms.Lair`. The Room card could say
   * *this lair holds a snow cat*; nothing could answer *where is a snow cat*,
   * which is the question somebody asking about a monster actually has, and
   * MMUD Explorer's own monster page has answered it for twenty years.
   *
   * **Grouped by room name, and the addresses kept underneath.** `snow cat` is
   * in 236 rooms bearing 25 names: a list of addresses is not somewhere a
   * person can decide to go, and a button that walked to one of the 236 would
   * be the guess `shopPlace` refuses. So a group of one is a place, a group of
   * several is a choice, and the count is stated either way.
   *
   * Undefined for a monster the realm places in no room — 153 of the shipped
   * realm's 1,514 names — rather than an empty list, which reads as a claim
   * that it is nowhere when what the data says is that it is summoned or
   * scripted in.
   */
  mobPlaces(mob: WorldMob, groups = 12, perGroup = 12): MobPlaces | undefined {
    const found = this.spawnRoomsOf(mob);
    if (found.length === 0) return undefined;

    /*
     * One room may be reached both ways — a lair in a room that also has a
     * resident — and `npc` wins, because it is the more specific claim: the
     * realm saying this creature lives here, not that it is one candidate for
     * a regeneration slot.
     */
    const byRoom = new Map<RoomId, MobSpawnRoom>();
    for (const entry of found) {
      const key = roomId(entry.room.map, entry.room.room);
      const already = byRoom.get(key);
      if (already === undefined || (already.via === 'lair' && entry.via === 'npc')) {
        byRoom.set(key, entry);
      }
    }

    /*
     * In the realm's own room order, not in the order the index happened to
     * reach them. A name resolving to several of the realm's rows — `snow cat`
     * is ids 70 and 71 — is walked one row at a time, so the addresses under a
     * group came out interleaved by whichever row placed each: `2/1, 2/3, 2/2`.
     * The list is read and clicked, and the cap decides which of them survive
     * it, so the order has to be the map's rather than the table's.
     */
    const ordered = [...byRoom.values()].sort(
      (a, b) => a.room.map - b.room.map || a.room.room - b.room.room
    );

    const grouped = new Map<string, MobSpawn>();
    for (const entry of ordered) {
      const name = entry.room.name.trim();
      // `via` is part of the key: *lives here* and *may spawn here* are two
      // different answers, and folding them would state the weaker as the
      // stronger for any room that is both.
      const key = `${entry.via}:${name.toLowerCase()}`;
      const group = grouped.get(key);
      if (group === undefined) {
        grouped.set(key, {
          via: entry.via,
          roomName: name,
          count: 1,
          rooms: [{ map: entry.room.map, room: entry.room.room }],
          max: entry.max
        });
        continue;
      }
      group.count += 1;
      if (group.rooms.length < perGroup) {
        group.rooms.push({ map: entry.room.map, room: entry.room.room });
      }
      // A figure the rows disagree about is no figure. Folding to either end
      // would publish a maximum the realm never stated for any of them.
      if (group.max !== entry.max) group.max = null;
    }

    const all = [...grouped.values()].sort(
      (a, b) =>
        // The resident first — it is the specific answer — then the widest
        // spread, which is where the thing is most likely to be found.
        (a.via === b.via ? 0 : a.via === 'npc' ? -1 : 1) ||
        b.count - a.count ||
        a.roomName.localeCompare(b.roomName)
    );
    return {
      spawns: all.slice(0, groups),
      rooms: byRoom.size,
      more: Math.max(0, all.length - groups)
    };
  }

  /**
   * Every placement of this monster, one entry per room and slot, uncapped.
   *
   * A name can hold several of the realm's rows — five `cocoon`s — and each
   * row is placed separately, so every id behind the name contributes. The
   * mob index is keyed by name and `mobsById` maps the ids onto it, so this
   * asks the id index which of its entries *is* this mob rather than keeping
   * a third index of name → ids.
   *
   * Through the fold and not through the argument, because `mobAt` hands
   * back a *copy* re-answered by one row and an identity test against that
   * copy matches nothing: the card lost its whole `spawns in` list the day
   * the room began resolving the name. And where one row was resolved, only
   * that row's rooms are places this monster is — the other row's are where
   * its namesake lives, which is the confusion the resolution exists to end.
   */
  private spawnRoomsOf(mob: WorldMob): MobSpawnRoom[] {
    const found: MobSpawnRoom[] = [];
    const fold = this.mobs.get(mobKey(mob.name));
    const only = mob.row?.id;
    for (const [id, rooms] of this.mobRooms()) {
      if (only !== undefined ? id !== only : this.mobsById.get(id) !== fold) continue;
      found.push(...rooms);
    }
    return found;
  }

  /** The reverse index, built on the first ask. See `mobPlaces`. */
  private mobRooms(): Map<number, MobSpawnRoom[]> {
    if (this.mobRoomsById !== null) return this.mobRoomsById;
    const index = new Map<number, MobSpawnRoom[]>();
    const put = (id: number, entry: MobSpawnRoom): void => {
      const bucket = index.get(id);
      if (bucket === undefined) index.set(id, [entry]);
      else bucket.push(entry);
    };
    for (const room of this.rooms.values()) {
      if (room.npcId !== undefined) put(room.npcId, { room, via: 'npc', max: null });
      if (room.lair === undefined) continue;
      const { max, ids } = parseLair(room.lair);
      for (const id of ids) put(id, { room, via: 'lair', max });
    }
    this.mobRoomsById = index;
    return index;
  }

  private shopsByName(): Map<string, WorldRoom[]> {
    if (this.shopRoomsByName !== null) return this.shopRoomsByName;
    const index = new Map<string, WorldRoom[]>();
    for (const room of this.rooms.values()) {
      if (room.shop === undefined) continue;
      const name = this.shops.get(room.shop)?.name.trim().toLowerCase();
      if (name === undefined || name.length === 0) continue;
      const bucket = index.get(name);
      if (bucket === undefined) index.set(name, [room]);
      else bucket.push(room);
    }
    this.shopRoomsByName = index;
    return index;
  }

  /**
   * The items the realm says would serve a condition — the picker's list
   * (todo 19).
   *
   * An item that carries a usable spell (`itemInvocation`, which is the
   * `CastsSp` the server rewrites into `UseSpell` and deliberately steps over
   * a hit-proc) whose row serves the condition asked about. So a list for
   * *poisoned* holds the antidotes and not the healing potions, which is the
   * reviewer's own requirement and the reason it is a realm query rather than
   * a name match: `cure poison potion` casts `violet potion`, and no amount of
   * reading the two names says they are the same fact.
   *
   * Capped, and sorted by name so the same realm answers the same way twice.
   */
  itemsServing(condition: 'hp' | 'poisoned' | 'blind' | 'diseased', limit = 400): WorldItem[] {
    const found: WorldItem[] = [];
    for (const item of this.items.values()) {
      const invocation = itemInvocation(item);
      if (invocation === null) continue;
      const spell = this.spellById(invocation.spell);
      if (spell === null) continue;
      if (!spellServes(spell.abilities)[condition]) continue;
      found.push(item);
    }
    /*
     * Sorted the way a reader reads a list, which is not the way the default
     * comparison sorts one (todo 00): `localeCompare` on the raw names puts
     * `Kher grass` among the lower-case k's on some locales and ahead of every
     * one on others, so the list looked unsorted where it was merely
     * case-sensitive. Folded, with the raw name as the tie-break so two items
     * differing only in case still have one stable order.
     *
     * The cap is a guard against a pathological realm rather than a page size
     * — the picker scrolls now (todo 00), so a list cut at sixty was hiding
     * items with nothing on screen to say so.
     */
    return found
      .sort(
        (a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name)
      )
      .slice(0, limit);
  }

  /**
   * Every bank counter the realm places, for the settings picker (todo 00).
   *
   * The join `trainersTaking` makes, without the filtering: a bank takes every
   * character and charges nothing, so there is no eligibility to work out —
   * the question is only *which vault*, and every counter is an answer.
   *
   * A row placed in several rooms is several entries, all valid, and the
   * player picks: the balance is the row's, so two rooms holding the same row
   * are two doors onto one vault. Sorted by name then room so the same realm
   * answers the same way twice.
   */
  banks(): BankChoice[] {
    const found: BankChoice[] = [];
    for (const room of this.rooms.values()) {
      if (room.shop === undefined) continue;
      const shop = this.shops.get(room.shop);
      if (shop === undefined || shop.kind !== 'bank') continue;
      found.push({
        shop: room.shop,
        name: shop.name,
        map: room.map,
        room: room.room,
        roomName: room.name
      });
    }
    return found.sort((a, b) => a.name.localeCompare(b.name) || a.map - b.map || a.room - b.room);
  }

  /**
   * What this counter charges for one of this item, in copper, before the
   * buyer's charm (`counterPriceInCopper`). Zero for a thing the realm gives
   * away (`Free` on the listing); null where the file predates the coin
   * (format 47) or the realm holds no such row.
   */
  priceAt(item: number, shop: number): number | null {
    const known = this.items.get(item);
    const place = this.shops.get(shop);
    if (known?.currency === undefined || place === undefined) return null;
    return counterPriceInCopper(known.price ?? 0, known.currency, place.markup ?? 0);
  }

  /**
   * The vaults holding at least `need` copper by this character's own record,
   * best first by what stopping at each adds to the way to `to` (todo 00).
   *
   * `buyingPlacesFor`'s arithmetic over bank rooms instead of counters, on the
   * same two sweeps: the detour, not the distance, since the cash is wanted at
   * the counter and a vault the way already passes costs nothing. A vault
   * nobody has asked is not a candidate — a walk to learn a balance is a guess
   * at one — and the one the record overstates is found out at its counter,
   * where the errand asks `bank` before it withdraws.
   */
  cashPlaces(
    balances: readonly BankBalance[],
    need: number,
    from: RoomId,
    to: RoomId | null,
    traveller: Traveller
  ): CashPlace[] {
    const candidates: Array<{ choice: BankChoice; copper: number }> = [];
    for (const choice of this.banks()) {
      const held = balanceOf({ id: choice.shop, name: choice.name }, balances);
      if (held === null || held.copper < need) continue;
      candidates.push({ choice, copper: held.copper });
    }
    if (candidates.length === 0) return [];
    const wanted = new Set(candidates.map(({ choice }) => roomId(choice.map, choice.room)));
    const head = this.sweepTo(from, wanted, traveller);
    const back =
      to === null
        ? null
        : this.sweepBack(new Map([[to, 0]]), new Set([...wanted, from]), traveller, true);
    const base = back?.get(from);
    const places: CashPlace[] = [];
    for (const { choice, copper } of candidates) {
      const id = roomId(choice.map, choice.room);
      const reach = head.get(id);
      if (reach === undefined) continue;
      let detour = reach.cost;
      if (back !== null && base !== undefined) {
        const tail = back.get(id);
        if (tail === undefined) continue;
        detour = reach.cost + tail - base;
      }
      places.push({
        ...choice,
        copper,
        detour: Math.max(0, Math.round(detour)),
        moves: reach.moves
      });
    }
    return places.sort(
      (a, b) => a.detour - b.detour || a.moves - b.moves || a.map - b.map || a.room - b.room
    );
  }

  /**
   * Every trainer that will take this character, with the room it is in.
   *
   * The join the levelling errand and the settings screen both need: the
   * realm states a band, a class restriction and a markup per shop row
   * (format 35), and the rooms name the shop they hold. `trainersFor` is the
   * rule — cheapest first, never one whose ceiling this level has reached —
   * and this is the part that knows where the rooms are.
   *
   * **Keyed by the shop's row, not by its name.** `shopPlace` answers by name
   * and reports several rooms as an ambiguity, which is right for *the shop
   * that sells torches* and wrong here: two rows may share a name (Paradigm
   * has `Ninja Training Room` twice) and they are different trainers with
   * different bands. A row placed in several rooms is several entries, all
   * eligible, and the caller picks — which for this feature is the player.
   *
   * Empty on a realm with no class read where a trainer restricts by class,
   * and on one built before format 35, where no row states a band at all: a
   * client that cannot tell which trainer takes this character must not walk
   * to one, which is `trainsLevel`'s refusal doing exactly its job.
   */
  trainersTaking(
    level: number,
    classId: number | null
  ): Array<{ trainer: TrainerRow; map: number; room: number; roomName: string }> {
    const rows: TrainerRow[] = [];
    for (const shop of this.shops.values()) {
      if (shop.kind !== 'trainer') continue;
      const row: TrainerRow = { id: shop.id, name: shop.name };
      if (shop.minLevel !== undefined) row.minLevel = shop.minLevel;
      if (shop.maxLevel !== undefined) row.maxLevel = shop.maxLevel;
      if (shop.classOnly !== undefined) row.classOnly = shop.classOnly;
      if (shop.markup !== undefined) row.markup = shop.markup;
      rows.push(row);
    }
    const taking = trainersFor(rows, level, classId);
    if (taking.length === 0) return [];

    const wanted = new Map(taking.map((row, at) => [row.id, at]));
    const found: Array<{ trainer: TrainerRow; map: number; room: number; roomName: string }> = [];
    for (const room of this.rooms.values()) {
      if (room.shop === undefined) continue;
      const at = wanted.get(room.shop);
      if (at === undefined) continue;
      const trainer = taking[at];
      if (trainer === undefined) continue;
      found.push({ trainer, map: room.map, room: room.room, roomName: room.name });
    }
    // Back into the rule's order, which the room scan does not preserve.
    return found.sort(
      (a, b) =>
        (wanted.get(a.trainer.id) ?? 0) - (wanted.get(b.trainer.id) ?? 0) ||
        a.map - b.map ||
        a.room - b.room
    );
  }

  /**
   * The closest room satisfying `want`, by unobstructed steps, as a route.
   *
   * Breadth-first over exits with no requirement — a door, a key, a level gate
   * or a `Text:` phrasing is a step this deliberately does not plan through —
   * so what comes back is walkable as it stands, or null within `limit` steps.
   * For "the nearest shop", which `route` cannot answer without a destination.
   */
  nearest(
    from: RoomId,
    want: (room: WorldRoom) => boolean,
    limit = 30,
    through: (requirement: Requirement) => boolean = () => false
  ): Route | null {
    if (!this.rooms.has(from)) return null;
    const cameFrom = new Map<RoomId, { prev: RoomId; exit: WorldExit }>();
    const depth = new Map<RoomId, number>([[from, 0]]);
    const queue: RoomId[] = [from];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const room = this.rooms.get(id);
      if (!room) continue;
      const here = depth.get(id) ?? 0;
      // Nobody in particular is walking it, so nothing is priced against anybody.
      if (id !== from && want(room)) return this.buildRoute(cameFrom, id, here, {});
      if (here >= limit) continue;
      for (const exit of room.exits) {
        if (exit.requirement !== null && !through(exit.requirement)) continue;
        const next = `${exit.map}/${exit.room}`;
        if (depth.has(next)) continue;
        depth.set(next, here + 1);
        cameFrom.set(next, { prev: id, exit });
        queue.push(next);
      }
    }
    return null;
  }

  /**
   * What kind of place every room bearing a name is, when they agree.
   *
   * For decorating a room's name the moment it is printed — before the room
   * has resolved, because the name line arrives first. Thirteen Town Gates
   * with no shop agree on nothing worth drawing; two Banks that are both
   * banks agree on a bank. Disagreement, or no such room, is undefined: a
   * glyph beside a name is a claim, and this does not guess.
   */
  placeNamed(name: string): { kind: ShopKind; shop: string } | undefined {
    const rooms = this.findByName(name);
    if (rooms.length === 0) return undefined;
    let found: { kind: ShopKind; shop: string } | undefined;
    for (const room of rooms) {
      const shop = room.shop === undefined ? undefined : this.shops.get(room.shop);
      if (!shop?.kind) return undefined;
      if (found && found.kind !== shop.kind) return undefined;
      found = { kind: shop.kind, shop: shop.name };
    }
    return found;
  }

  /**
   * The commands the exits of a room *named* this take, where every room of
   * that name agrees.
   *
   * The same discipline as `placeNamed`, and for the same reason: the console
   * asks on the room's *name* line, before `Obvious exits:` has completed the
   * room and resolved which of the thirteen Town Gates this is. A name shared
   * by several rooms has several exit sets, and offering one of them would put
   * a button on screen that sends a command the room does not take — which on
   * this server is not a button that does nothing, it is one that says the text
   * out loud to everybody standing there.
   *
   * So: undefined unless every room bearing the name offers exactly the same
   * set of `Text:` commands. In practice that is a uniquely-named room, which
   * is what a `go manhole` room almost always is.
   */
  exitCommandsNamed(name: string): string[] | undefined {
    const rooms = this.findByName(name);
    if (rooms.length === 0) return undefined;
    let agreed: string[] | undefined;
    for (const room of rooms) {
      const commands: string[] = [];
      for (const exit of room.exits) {
        const command = exit.requirement?.commands?.[0]?.trim();
        if (command && !commands.includes(command)) commands.push(command);
      }
      if (agreed === undefined) agreed = commands;
      else if (agreed.length !== commands.length || agreed.some((c, i) => c !== commands[i])) {
        return undefined;
      }
    }
    return agreed !== undefined && agreed.length > 0 ? agreed : undefined;
  }

  /**
   * Every name the realm knows, for the console to recognise on hover.
   *
   * Shipped once per session rather than looked up per row: a link provider
   * is asked about the row under the pointer, and a round trip to main per
   * hover is a round trip per hover.
   *
   * **Only the spells a player could cast.** The realm's `Spells` table is not
   * a spellbook — it is every *effect* the engine has, and 848 of the shipped
   * realm's 2,094 rows name no level, mana, energy or abbreviation because
   * nobody casts them: a monster's `spits`, `gazes` and `breathes a jet of
   * frost`, an item's `food` and `drink`, and bare engine words like `fall`,
   * `pool` and `sdf`. Linked on sight they turn ordinary prose into a field of
   * false spells — which is how `Encumbrance:` in an inventory listing came to
   * offer a spell card reading "encumbrance · SPELL · Lasts 1" (id 1236, the
   * effect behind being overloaded).
   *
   * The four fields are the discriminator rather than a list of words to
   * refuse, because the table is realm data and the next realm's effect rows
   * are different words. Every castable spell states at least one of them:
   * `harm` and `mend` carry no abbreviation and are kept by their level and
   * mana, and all 1,246 with any signal survive.
   *
   * `lookup` and the Reference card still search the whole table — somebody
   * asking about `encumbrance` by name should get the realm's answer. This
   * governs only what is underlined without being asked.
   */
  names(): WorldNames {
    return {
      /*
       * Every item name the realm has, not only the ones the detail index
       * carries: recognising a thing is a different question from pricing it,
       * and the two shared a list until `You notice large sign, small sign
       * here.` turned out to name nothing the console knew. A realm converted
       * before v11 ships none, and falls back to the detail index's keys.
       */
      items: this.itemNames.length > 0 ? this.itemNames : [...this.itemsByName.keys()],
      mobs: [...this.mobs.keys()],
      spells: this.spells.filter(isCastable).map((spell) => spell.name.toLowerCase()),
      races: this.races.map((race) => race.name.toLowerCase()),
      classes: this.classes.map((entry) => entry.name.toLowerCase()),
      /*
       * Multi-word room names only — see `WorldNames.rooms` for why the short
       * ones are kept out rather than merely outranked. `byName` is already
       * keyed lower-cased, so this is the keys it holds, filtered.
       */
      rooms: [...this.byName.keys()].filter((name) => name.includes(' '))
    };
  }

  /**
   * Every spell a player could cast, named for a settings picker.
   *
   * The `isCastable` discriminator `names()` already uses, for the same
   * reason: the realm's `Spells` table is every *effect* the engine has, and
   * offering `fall` and `sdf` in a picker would be the false-spell field the
   * console rule exists to prevent. Sorted by name, because a picker filters
   * as somebody types and its resting order should read as a list.
   */
  castableSpells(): SpellOption[] {
    return this.spells
      .filter(isCastable)
      .map((spell) => ({
        name: spell.name,
        short: spell.short ?? null,
        targeting: spellTargeting(spell.targets),
        // What the realm says it serves, so the three cure fields can each
        // offer the spells that answer their own question (todo 00).
        serves: spellServes(spell.abilities)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The realm's row for a spell id, or null.
   *
   * The room's own `Spell` column holds an id, not a word, so `spellNamed`
   * cannot answer it — a room that heals you and a room that drowns you are
   * the same column and only the row tells them apart.
   */
  /**
   * The spell the realm numbers this, or null.
   *
   * Indexed rather than scanned: the router asks this **once per room it
   * expands** since a room's own spell started pricing the way through it
   * (todo 01), and a linear walk of 2,094 rows inside an A* over 57,511 rooms
   * is the hidden `O(N²)` the standards name — measured at 430ms a route
   * against 27ms with the map.
   */
  spellById(id: number): WorldSpell | null {
    return this.spellsById.get(id) ?? null;
  }

  /**
   * The message rows this realm's spells print on a fumble — every
   * `ConfuseMsg` value across the spell table (todo 05). Thirty-odd rows on
   * Paradigm, `You retch uncontrollably!` among them; the classifier reads
   * the character's own line of one as `command-fumbled`.
   */
  confusionMessages(): ReadonlySet<number> {
    if (this.confusionRows === null) {
      const rows = new Set<number>();
      for (const spell of this.spells) {
        for (const [id, value] of spell.abilities ?? []) {
          if (id === CONFUSE_MESSAGE_ABILITY && value > 0) rows.add(value);
        }
      }
      this.confusionRows = rows;
    }
    return this.confusionRows;
  }

  /**
   * Spells matching a name fragment, best first.
   *
   * A prefix match sorts ahead of a match anywhere, because somebody typing
   * `heal` means the spell called Heal rather than the eleven with "heal"
   * somewhere in the name. Bounded — a card shows a list, not a table.
   */
  searchSpells(query: string, limit = 40): WorldSpell[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return this.spells.slice(0, limit);
    const hits: Array<{ spell: WorldSpell; rank: number }> = [];
    for (const spell of this.spells) {
      const name = spell.name.toLowerCase();
      const short = spell.short?.toLowerCase() ?? '';
      const rank = name.startsWith(needle) || short === needle ? 0 : name.includes(needle) ? 1 : -1;
      if (rank < 0) continue;
      hits.push({ spell, rank });
    }
    return hits
      .sort((a, b) => a.rank - b.rank || a.spell.name.localeCompare(b.spell.name))
      .slice(0, limit)
      .map((hit) => hit.spell);
  }

  /**
   * The spell a name or abbreviation names exactly, or null.
   *
   * Case-insensitive, exact only: the wire prints a spell's whole name in a
   * cast confirmation, so a prefix match here would let `bless` resolve to
   * whichever of the realm's blessings sorts first — the confidently wrong
   * answer this codebase refuses everywhere. The abbreviation is accepted
   * because it is the realm's own second spelling of the same row. Null is
   * *the realm does not name it*, which for a converted derivative realm is a
   * real answer and never an error.
   */
  spellNamed(word: string): WorldSpell | null {
    const needle = word.trim().toLowerCase();
    if (needle.length === 0) return null;
    let byShort: WorldSpell | null = null;
    for (const spell of this.spells) {
      if (spell.name.toLowerCase() === needle) return spell;
      if (byShort === null && spell.short?.toLowerCase() === needle) byShort = spell;
    }
    return byShort;
  }

  /**
   * Everything the realm knows about a name, whatever kind of thing it is.
   *
   * One query across monsters, items and spells, because the person asking has
   * a *name* — off a room listing, a pack, a shop shelf — and should not have
   * to know which table answers it. Prefix matches sort first within each
   * kind; each list is capped separately so eleven "heal" spells cannot crowd
   * out the one monster that also matched.
   */
  lookup(query: string, limit = 12, at: RoomId | null = null): WorldLookup {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      return { mobs: [], items: [], spells: [], races: [], classes: [], classNames: {} };
    }

    const rank = (name: string): number =>
      name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : -1;
    const best = <T>(all: Iterable<[string, T]>): T[] => {
      const hits: Array<{ value: T; name: string; rank: number }> = [];
      for (const [name, value] of all) {
        const r = rank(name);
        if (r >= 0) hits.push({ value, name, rank: r });
      }
      return hits
        .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
        .slice(0, limit)
        .map((hit) => hit.value);
    };

    /*
     * A name the server printed with a modifier on it matches nothing as
     * typed, and the answer to it is one specific monster rather than a list —
     * so the fallback is an exact lookup and never the substring search above.
     * Dropping words *and* matching loosely is how `small rat of doom` comes
     * back confidently as something called `doom`.
     */
    let mobs = best(this.mobs.entries());
    if (mobs.length === 0) {
      const printed = this.mobAsPrinted(needle);
      if (printed) mobs = [printed];
    }
    /*
     * And answered as the row the reader's own room resolves each name to,
     * where it can — the card is where the fold was read as a claim about one
     * monster, and `100–830 hp` is what a name holding two rows looks like
     * when nothing has been asked about the room it was clicked in. Unresolved
     * names come back untouched, span and all.
     */
    mobs = mobs.map((mob) => this.mobAt(mob.name, at) ?? mob);

    return {
      mobs,
      items: best(
        [...this.itemsByName.values()].map((item) => [item.name.toLowerCase(), item] as const)
      ).map((item) => this.withPlacements(this.placingHandovers(item))),
      spells: this.searchSpells(query, limit),
      /*
       * Two closed vocabularies of thirteen and fifteen, so the same ranking
       * over the whole list costs nothing and needs no separate search method.
       */
      races: best(this.races.map((race) => [race.name.toLowerCase(), race] as const)),
      classes: best(this.classes.map((entry) => [entry.name.toLowerCase(), entry] as const)),
      classNames: this.classNames()
    };
  }

  /**
   * An item with each of its handovers' rooms named — format 39.
   *
   * The join `shopPlaces` and `QuestStep.place` are: the file carries the
   * `map/room` because that is what the realm states, and `9/146` is not
   * somewhere anybody can picture. Made here rather than at load, because the
   * rooms arrive line by line *after* the header the items are in.
   *
   * A copy, never a write into the cached row — the map holds one object per
   * item and every lookup shares it. Untouched where the realm names no
   * handover, which is the great majority, so this costs nothing per query.
   */
  private placingHandovers(item: WorldItem): WorldItem {
    if (item.from === undefined || item.from.length === 0) return item;
    return {
      ...item,
      from: item.from.map((handover) => {
        if (handover.room === undefined || handover.place !== undefined) return handover;
        const name = this.rooms.get(handover.room as RoomId)?.name.trim();
        return name === undefined || name.length === 0 ? handover : { ...handover, place: name };
      })
    };
  }

  /**
   * An item with the rooms the realm puts it in — format 42.
   *
   * Joined at the lookup for `placingHandovers`' reason: the rooms arrive
   * after the header the items are in. A copy, never a write into the shared
   * row. **Every row the name holds**, as `mobPlaces` takes every row behind
   * a monster's: the lookup answers one row per name, and `nightblack
   * portal`'s first is placed nowhere while its others stand in 26 rooms.
   */
  private withPlacements(item: WorldItem): WorldItem {
    const rows = this.itemRowsByName.get(item.name.trim().toLowerCase()) ?? [item.id];
    const placed = this.itemPlaces(rows);
    return placed === undefined ? item : { ...item, placed };
  }

  /**
   * Every room the realm puts an item in, grouped the way `mobPlaces` groups
   * a monster's: by room name, in the map's own order, the widest spread
   * first, and capped with the counts beside — a coffin stands in 77 rooms
   * and a list of them is a scan, not a lead.
   */
  itemPlaces(rows: readonly number[], groups = 12, perGroup = 12): ItemPlaces | undefined {
    const placedRows = rows.filter((row) => (this.placedIn.get(row) ?? []).length > 0);
    const ids = new Set(placedRows.flatMap((row) => this.placedIn.get(row) ?? []));
    const rooms = [...ids]
      .map((id) => this.rooms.get(id))
      .filter((room): room is WorldRoom => room !== undefined)
      .sort((a, b) => a.map - b.map || a.room - b.room);
    if (rooms.length === 0) return undefined;
    const grouped = new Map<string, PlaceGroup>();
    for (const room of rooms) {
      const name = room.name.trim();
      const group = grouped.get(name.toLowerCase());
      if (group === undefined) {
        grouped.set(name.toLowerCase(), {
          roomName: name,
          count: 1,
          rooms: [{ map: room.map, room: room.room }]
        });
        continue;
      }
      group.count += 1;
      if (group.rooms.length < perGroup) group.rooms.push({ map: room.map, room: room.room });
    }
    const all = [...grouped.values()].sort(
      (a, b) => b.count - a.count || a.roomName.localeCompare(b.roomName)
    );
    // Whether what stands there can be taken is the placed rows' question,
    // not the name's first row's: `wooden box` is loot and furniture both.
    const fixed = placedRows.every((row) => this.items.get(row)?.gettable === false);
    return {
      groups: all.slice(0, groups),
      more: Math.max(0, all.length - groups),
      ...(fixed ? { fixed: true as const } : {})
    };
  }

  /**
   * The realm's row for a name the server *printed* — modifier and all.
   *
   * `MobNameModifierType.Before` and `.After` hang a word off either end of a
   * monster's name, and those words are realm data this client's database does
   * not carry: `small elite guardsman` is a name the table cannot match while
   * `elite guardsman` is right there in it, at 500 hp. Modifiers are not an
   * edge case on the live realm — twenty-four distinct monsters, every one
   * carrying one or none, docs/game-behaviour.md — so a lookup that only ever
   * tries the name as printed misses most of what it was built to answer.
   *
   * `classifyOccupant` has always undone it for the room listing. This is the
   * same rule (`mobNameCandidates`: exact first, then least stripping) for
   * every other caller holding a name off the wire rather than out of the
   * table, so the two cannot come to different conclusions about whether the
   * realm knows a monster.
   */
  mobAsPrinted(name: string): WorldMob | undefined {
    for (const candidate of mobNameCandidates(name)) {
      const found = this.mob(candidate);
      if (found) return found;
    }
    return undefined;
  }

  /** How many spells the realm named. Zero on a realm built before v4. */
  get spellCount(): number {
    return this.spells.length;
  }

  get info(): WorldMeta {
    return this.meta;
  }

  /**
   * The header of a realm file, without indexing the realm behind it.
   *
   * For a question about *which* world a file is — its name, the archive it
   * came from — asked before deciding whether to load it at all. The whole
   * file is still inflated (gzip cannot skip), which is tens of milliseconds
   * against the seconds a full index costs. `null` when the file is missing,
   * unreadable or carries no header.
   */
  static meta(file: string): WorldMeta | null {
    let text: string;
    try {
      text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    } catch {
      return null;
    }
    const end = text.indexOf('\n');
    const first = end === -1 ? text : text.slice(0, end);
    let parsed: unknown;
    try {
      parsed = JSON.parse(first);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    return typeof record['v'] === 'number' ? metaOf(record) : null;
  }

  /** Loads the gzipped JSON-lines file produced by `scripts/build-world.mjs`. */
  static load(file: string): WorldGraph {
    const graph = new WorldGraph();
    if (!fs.existsSync(file)) return graph;

    const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    const lines = text.split('\n');

    for (const [index, line] of lines.entries()) {
      if (line.length === 0) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // One malformed line should cost one room, not the whole realm.
        continue;
      }

      if (index === 0 && typeof parsed['v'] === 'number') {
        graph.meta = metaOf(parsed);
        graph.loadMobs(parsed['mobs']);
        // Only present from v2 on; an older realm file simply names no items.
        for (const entry of Array.isArray(parsed['items']) ? parsed['items'] : []) {
          if (typeof entry !== 'object' || entry === null) continue;
          const record = entry as Record<string, unknown>;
          const id = Number(record['id']);
          if (!Number.isInteger(id)) continue;
          const item: WorldItem = { id, name: String(record['n'] ?? '') };
          if (Array.isArray(record['shops'])) item.shops = record['shops'].map(String);
          if (Array.isArray(record['mobs'])) item.mobs = record['mobs'].map(String);
          // Format 39. Absent before it, and absent for the great majority
          // after — a script hands over 46 of the stock realm's items.
          const from = readHandovers(record['from']);
          if (from.length > 0) item.from = from;
          // Where using it puts you — format 40, and a way into somewhere for
          // `approachItems`. A handful of items per realm.
          const lands = String(record['lands'] ?? '').trim();
          if (lands.length > 0) item.lands = lands as RoomId;
          // And where using it works — format 41. Absent is *wherever you
          // stand*; a pre-41 file says nothing, which reads the same and is
          // the shape format 40 shipped.
          const landsFrom = record['landsFrom'];
          if (Array.isArray(landsFrom)) {
            const where = landsFrom
              .filter((at): at is string => typeof at === 'string' && at.length > 0)
              .map((at) => at as RoomId);
            if (where.length > 0) item.usableIn = where;
          }
          const price = Number(record['price']);
          if (Number.isFinite(price) && price > 0) item.price = price;
          // Format 47: absent is copper, and before it the coin is unknown.
          if (graph.meta.version >= CURRENCY_SINCE) {
            const currency = currencyOfCode(Number(record['cur'] ?? 0));
            if (currency !== null) item.currency = currency;
          }
          const encumbrance = Number(record['enc']);
          if (Number.isFinite(encumbrance) && encumbrance > 0) item.encumbrance = encumbrance;
          /*
           * What it does — format 12, and read *before* the kind rather than
           * inside it.
           *
           * `readItemKind` returns early when the record states no `ItemType`,
           * and the effect pairs used to be read after that gate — so an item
           * with effects and no kind lost every one of them, silently. No item
           * on the shipped realm is in that state, which is exactly why it
           * would not have been noticed: a derivative omitting the column
           * would have dropped the lot with nothing to say so.
           */
          const abilities = readAbilities(record);
          if (abilities.length > 0) item.abilities = abilities;
          /*
           * Who may use it — format 15, and outside `readItemKind` for the
           * same reason the pairs above are: that function returns early on a
           * record with no `ItemType`, and a restriction lost silently is a
           * button the card offers and the server refuses.
           */
          const classes = readIdList(record['cls']);
          if (classes.length > 0) item.classes = classes;
          const races = readIdList(record['race']);
          if (races.length > 0) item.races = races;
          const minLevel = Number(record['lvl']);
          if (Number.isInteger(minLevel) && minLevel > 0) item.minLevel = minLevel;
          /*
           * Format 18. Only the refusals are on disk, so absent is the
           * permissive answer — a derivative realm without the columns must
           * not have its looting and dropping switched off by this client's
           * ignorance of them.
           */
          if (record['ngt'] === 1) item.gettable = false;
          if (record['ndr'] === 1) item.notDroppable = true;
          const limit = Number(record['lim']);
          if (Number.isInteger(limit) && limit > 0) item.limit = limit;
          readItemKind(record, item);
          graph.items.set(id, item);
          for (const [ability, spell] of item.abilities ?? []) {
            if (ability !== HAZARD_ABILITY.castsSpell || spell <= 0) continue;
            const holders = graph.grants.get(spell);
            if (holders === undefined) graph.grants.set(spell, [item]);
            else if (!holders.includes(item)) holders.push(item);
          }
          const key = item.name.trim().toLowerCase();
          if (key.length > 0) {
            if (!graph.itemsByName.has(key)) graph.itemsByName.set(key, item);
            const rows = graph.itemRowsByName.get(key);
            if (rows) rows.push(id);
            else graph.itemRowsByName.set(key, [id]);
          }
        }
        // Both only from v4 on; an older realm names no shops and no spells,
        // and every consumer already has to answer "the realm does not say".
        graph.loadShops(parsed['shops']);
        graph.loadSpells(parsed['spells']);
        // v10. A realm converted by an older build names no races or classes,
        // and every consumer already answers "the realm does not say".
        graph.loadRaces(parsed['races']);
        graph.loadClasses(parsed['classes']);
        // v24. A realm converted before quests were indexed states none, which
        // reads as "this realm scripts no quests" — the same honest absence
        // every index above already answers with.
        graph.loadQuests(parsed['quests']);
        graph.itemNames = (Array.isArray(parsed['itemNames']) ? parsed['itemNames'] : [])
          .map((name) => String(name).trim().toLowerCase())
          .filter((name) => name.length > 0);
        continue;
      }

      const room = graph.toRoom(parsed);
      if (room) graph.add(room);
    }

    graph.linkPortals();
    graph.linkItemLandings();
    graph.linkLevers();
    return graph;
  }

  /**
   * Gives the router every room-script teleport, priced by what it can read.
   *
   * The scripts have been on `WorldRoom.commands` since format 13, card-only,
   * with the routing half deferred (mme.md §6). The first tranche linked only
   * the commands whose every guard was `minlevel`/`maxlevel` and **dropped the
   * edge entirely** for the rest, on the reasoning that a route through a
   * guess walks a character somewhere it cannot get back from.
   *
   * That is the one place in this router that prunes an edge it cannot price,
   * and it is the opposite of what `REQUIREMENT_KINDS` says about an
   * instruction nothing recognises — *passable-but-suspect rather than
   * silently dropped: an exit we do not understand is still an exit, and
   * pruning it strands routes*. It stranded 19,108 of Paradigm's 57,511 rooms
   * and 3,277 of stock's 26,694, measured from the Newhaven Common Room: 186
   * of Paradigm's 255 scripted landings and 106 of stock's 165 were dropped,
   * and with them the only way in to whole regions — Dragon's Fang Hills (766
   * rooms), the Undermountain Caverns (336), the Ancient Darkwood Tree and
   * Morukai behind it, which the realm reaches by `go portal` at 9/1291 under
   * a `checkability 133 5` this client cannot evaluate on Paradigm.
   *
   * So every landing the dataset holds is an edge now, and the guards decide
   * the price rather than whether it exists: `minlevel`/`maxlevel` become the
   * `level` gate they already were, and everything else — `nomonsters`,
   * `roomitem`, `testskill`, `checkability` — goes on `Requirement.unread`,
   * which `edgePenalty` charges the unevaluable figure for. A guarded portal
   * therefore costs about sixty steps of detour: taken when it is the only way
   * there, never preferred while a corridor exists.
   */
  /**
   * An item that teleports **from a particular room** is a portal out of it.
   *
   * Which is all it ever was: the realm gates the potion of levitation's block
   * on `roomitem 993`, item 993 is the `waterfall` standing in `3/1`, and
   * using it anywhere else runs a block that fails on its first step. So the
   * way into the Catacombs is *walk to the pool under the waterfall and drink
   * it there* — one edge out of one room, which every reader that already
   * understands a portal understands for free: the map draws it, `withinSteps`
   * counts the landing as one move from `3/1` (true, unlike *one move from
   * anywhere*), and the router walks to the room and uses it.
   *
   * The requirement is `item`, so `edgePenalty`'s own rung decides the pack —
   * carried free, listed and lacking a wall, never listed discouraged — and
   * the same `spends` entry carries what using it costs.
   */
  private linkItemLandings(): void {
    for (const item of this.items.values()) {
      if (item.lands === undefined || item.usableIn === undefined) continue;
      if (item.name.length === 0) continue;
      const target = this.rooms.get(item.lands);
      if (target === undefined) continue;
      const command = `use ${item.name}`;
      for (const at of item.usableIn) {
        // A guard room outside the dataset is a hole in the data, not a way.
        if (!this.rooms.has(at)) continue;
        const edge: PortalExit = {
          direction: 'portal',
          map: target.map,
          room: target.room,
          requirement: {
            kind: 'item',
            raw: `Item: ${item.id}`,
            keyId: item.id,
            commands: [command],
            ...useGateOf(item)
          }
        };
        this.spends.set(edge, {
          id: item.id,
          name: item.name,
          command,
          uses: item.uses === undefined || item.uses < 0 ? null : item.uses
        });
        const held = this.portals.get(at);
        if (held) held.push(edge);
        else this.portals.set(at, [edge]);
      }
    }
  }

  private linkPortals(): void {
    for (const [id, room] of this.rooms) {
      for (const command of room.commands ?? []) {
        if (command.to === undefined) continue;
        const destination = this.rooms.get(command.to);
        // A teleport out of the dataset is a hole in the data, not a route.
        if (!destination) continue;
        const phrase = command.say[0]?.trim();
        if (!phrase) continue;

        let minLevel: number | undefined;
        let maxLevel: number | undefined;
        const unread: string[] = [];
        /*
         * And the ability gates among them, read into the comparison the
         * server makes. Still `unread` as well — the chip states every
         * condition in the realm's words — because this is what the client can
         * *answer* once `abil` has stated the counters, not a different fact.
         */
        const gates: AbilityGate[] = [];
        for (const entry of command.need ?? []) {
          const [verb, value] = entry.trim().split(/\s+/);
          const figure = Number(value);
          if (verb === 'minlevel' && Number.isInteger(figure)) minLevel = figure;
          else if (verb === 'maxlevel' && Number.isInteger(figure)) maxLevel = figure;
          // The realm's own words, kept whole: the price is the same for every
          // one of them and the chip is what a person reads to decide.
          else {
            unread.push(entry.trim());
            const gate = readAbilityGate(entry);
            if (gate !== null) gates.push(gate);
          }
        }

        const gated = minLevel !== undefined || maxLevel !== undefined;
        const corridor = this.corridorFrom(command, command.to);
        const requirement: Requirement = {
          // A level gate prices and blocks exactly as an exit's `Level:` does;
          // an unguarded portal is a `Text:` exit in everything but the table
          // it came from — a different command, no obstacle.
          kind: gated ? 'level' : 'text',
          raw: [phrase, ...(command.need ?? [])].join('; '),
          commands: [...command.say],
          ...(minLevel !== undefined ? { minLevel } : {}),
          ...(maxLevel !== undefined ? { maxLevel } : {}),
          ...(unread.length > 0 ? { unread } : {}),
          ...(gates.length > 0 ? { abilities: gates } : {}),
          ...(corridor === null ? {} : { corridor })
        };
        const edge: PortalExit = {
          direction: 'portal',
          map: destination.map,
          room: destination.room,
          requirement
        };
        const held = this.portals.get(id);
        if (held) held.push(edge);
        else this.portals.set(id, [edge]);
      }
    }
  }

  /**
   * The timed passage a room command opens, or null (todo 104).
   *
   * The command's own `cast` puts a spell on the character; where that spell,
   * or what it ends in (`EndCast`), carries harm the passage is one to run
   * through. From the landing the rooms are swept breadth-first over their
   * exits, up to the spell's duration in moves, until an exit whose own cast
   * kills the chain (`killsAny`) — that is the way out, and the rooms before
   * it are written into `underSpell`. No duration, or no way out within it,
   * is `ends: false`, which `corridorCost` walls.
   *
   * Sixty-odd ways in on the shipped realm cast something; the dive is the
   * one whose chain reaches harm. A bless off a portal casts and ends in
   * nothing that hurts, and is not a passage at all.
   */
  private corridorFrom(command: RoomCommand, landing: RoomId): Corridor | null {
    if (command.casts === undefined) return null;
    const first = this.spellById(command.casts);
    if (first === null) return null;
    const chain: WorldSpell[] = [];
    const seen = new Set<number>();
    for (let next: number | undefined = first.id; next !== undefined && next > 0;) {
      if (seen.has(next) || chain.length > 4) break;
      seen.add(next);
      const spell = this.spellById(next);
      if (spell === null) break;
      chain.push(spell);
      next = spell.abilities?.find(([ability]) => ability === HAZARD_ABILITY.endCast)?.[1];
    }
    const harms = chain.some((spell) =>
      (spell.abilities ?? []).some(([ability, value]) => HURTS.has(ability) && value !== 0)
    );
    if (!harms) return null;
    const lifts = new Set(chain.map((spell) => spell.id));
    const ticks = first.duration;
    // Bounded by the ticks where the realm states them, and by a stride
    // beyond any passage the shipped realms hold where it does not.
    const reach = ticks ?? 64;
    const depth = new Map<RoomId, number>([[landing, 0]]);
    const queue: RoomId[] = [landing];
    let endAt = Infinity;
    while (queue.length > 0) {
      const id = queue.shift()!;
      const here = depth.get(id) ?? 0;
      if (here >= endAt) break;
      const room = this.rooms.get(id);
      if (room === undefined) continue;
      for (const exit of room.exits) {
        const requirement = exit.requirement;
        const casts = [requirement?.castPre, requirement?.castPost].filter(
          (spell): spell is number => spell !== undefined && spell > 0
        );
        if (casts.some((spell) => this.killsAny(spell, lifts, 0))) {
          endAt = Math.min(endAt, here + 1);
          continue;
        }
        const to = roomId(exit.map, exit.room);
        if (depth.has(to) || here + 1 >= reach) continue;
        depth.set(to, here + 1);
        queue.push(to);
      }
    }
    const ends = endAt !== Infinity;
    const rooms = ends ? endAt : depth.size;
    const corridor: Corridor = {
      spell: first.id,
      name: first.name,
      rooms,
      ends,
      ...(ticks === undefined ? {} : { ticks }),
      ...(chain[1] === undefined ? {} : { then: chain[1].name })
    };
    for (const [id, at] of depth) {
      if (at < rooms && !this.underSpell.has(id)) this.underSpell.set(id, corridor);
    }
    return corridor;
  }

  /**
   * The items whose *use* casts this spell — `Items.Abil-n = CastsSp`, the
   * `grants` index read the other way — for a ward the walk keeps up (todo
   * 105): the waterskin against the desert's spell.
   */
  itemsCasting(spell: number): readonly WorldItem[] {
    return this.grants.get(spell) ?? [];
  }

  /**
   * Every ward this realm writes, for the settings screen to draw (todo 02).
   *
   * The join is the one `Wards` makes at each step, made once over the whole
   * realm instead: a room spell whose hazard names a spell that stops it, and
   * an item whose use casts that spell. A rule with no such item is left out,
   * because what the screen is drawing is the rules this client can act on —
   * the sunstone wristband stops the desert too and no `use` casts it, so it
   * is a thing to go and find rather than a rule to switch on.
   *
   * **Counted over the rooms**, because the count is what says whether the
   * rule matters: the shipped realms each hold exactly one, and it guards 945
   * rooms of desert. One scan of the room table per call, and the call is one
   * settings section opening.
   */
  wards(): WardRule[] {
    const casting = new Map<number, number>();
    for (const room of this.rooms.values()) {
      if (room.spell === undefined) continue;
      casting.set(room.spell, (casting.get(room.spell) ?? 0) + 1);
    }
    const rules: WardRule[] = [];
    for (const [id, rooms] of casting) {
      const cast = this.spellById(id);
      if (cast === null) continue;
      for (const ward of cast.hazard?.avoidedBySpell ?? []) {
        const casts = this.spellById(ward);
        for (const item of this.grants.get(ward) ?? []) {
          rules.push({
            item: item.name,
            ward: casts?.name ?? String(ward),
            hazard: cast.name,
            rooms
          });
        }
      }
    }
    // Widest first: the one that guards a realm's worth of rooms is the one
    // somebody is deciding about.
    return rules.sort((a, b) => b.rooms - a.rooms || a.item.localeCompare(b.item));
  }

  /**
   * The timed passage a room is under, or null: what the session reads to
   * stand every routine down and keep the character moving (todo 104).
   */
  spellOver(room: RoomId): Corridor | null {
    return this.underSpell.get(room) ?? null;
  }

  /**
   * Joins every lever to the exit it opens.
   *
   * The realm keeps a lever in the room it is *pulled in* (`RoomCommand.opens`
   * names the exit) and the exit itself is under no obligation to mention it:
   * `1/1331` north out of Inner Gate reads `Door [301 picklocks/strength]`,
   * and the lever that raises that gate is in the Guardroom next door. So the
   * only way to answer *what opens this step* is to have walked every room's
   * commands once, which is what this does — after the rooms are loaded, for
   * `linkPortals`' reason: the lever's own room and the exit's are two
   * different rows and neither is finished while the file is being read.
   *
   * Measured over the shipped realm: 225 exits have at least one lever, 171
   * with every lever in the exit's own room, 35 with every lever in one other
   * room, 14 spread over several rooms and 5 naming an exit the room does not
   * have. `Walker` serves the first two shapes and refuses the rest out loud;
   * this index states all of them, because refusing needs the same answer as
   * acting.
   */
  private linkLevers(): void {
    for (const [id, room] of this.rooms) {
      for (const command of room.commands ?? []) {
        const opens = command.opens;
        if (opens === undefined) continue;
        // The realm's own spelling, as `Requirement.commands` and
        // `Requirement.actions` are both read: the rest are synonyms for one
        // lever, and the client sends one command.
        const phrase = command.say[0]?.trim();
        if (!phrase) continue;
        const key = leverKey(opens.room, opens.direction);
        const lever: RemoteLever = {
          at: id,
          roomName: room.name,
          say: phrase,
          ...(opens.item === undefined ? {} : { item: opens.item })
        };
        const held = this.levers.get(key);
        if (held) held.push(lever);
        else this.levers.set(key, [lever]);
      }
    }
  }

  /**
   * Every lever the realm says opens this exit, in the order the rooms were
   * read.
   *
   * Empty for the ordinary exit, which is 225 of the shipped realm's exits
   * away from all of them. The caller decides what to do with several: all in
   * one room is an errand, spread over rooms is a journey this client does not
   * plan.
   */
  leversFor(room: RoomId, direction: string): readonly RemoteLever[] {
    return this.levers.get(leverKey(room, direction)) ?? NO_LEVERS;
  }

  /**
   * What a barrier costs when the realm names a word that opens it *here*, or
   * null when nothing here does.
   *
   * One function rather than a price and a predicate beside it, because the
   * price and the plan have to agree about what a wall is: split in two, a
   * door the listed pack could not open after all was charged the wall by one
   * and reported as no wall by the other.
   *
   * `openableHere`'s question asked of a step rather than of a requirement,
   * because a door's levers are never on its requirement: `buildRealm` writes
   * `Requirement.actions` only for an exit that states `Needs N Actions`, and
   * a `Door` states nothing of the kind. So the only place the two ends are
   * joined is the lever index, and this is the one reading of it — shared by
   * the price (`stepCost`), the plan (`blocksAlong`) and the search for
   * another way (`otherWay`), for the reason `openableHere` already gives:
   * three copies of *can this be opened from here* agree exactly until one is
   * edited.
   *
   * Every lever in the room the step leaves from, and the same price
   * `edgePenalty` puts on a hidden exit in that shape, because `Walker` sends
   * both the same way — one command per lever, then the step again. Levers
   * somewhere else leave the wall standing: the detour is still not planned,
   * it is made reactively by `Walker.fetchLever`.
   */
  /**
   * The levers that open this step **without leaving the room**, and nothing
   * where any of them is elsewhere.
   *
   * `openableHere`'s question asked of a step rather than of a requirement,
   * because a door's levers are never on its requirement: `buildRealm` writes
   * `Requirement.actions` only for an exit that states `Needs N Actions`, and
   * a `Door` states nothing of the kind. Public because the *chip* has to ask
   * it too — a plan that says `Door, pick/bash 1000` about a door the client
   * knows opens to `use crowbar` sends a player after a skill nobody has.
   */
  leversHere(from: RoomId, direction: string): readonly RemoteLever[] {
    const levers = this.leversFor(from, direction);
    // Levers **elsewhere** leave the wall standing: this planner does not plan
    // the detour, `Walker.fetchLever` makes it when the server refuses.
    return levers.length > 0 && levers.every((lever) => lever.at === from) ? levers : NO_LEVERS;
  }

  /**
   * The word that opens this step here, for the head of the plan.
   *
   * Asked of `leversHere` and **not** of `leverPrice`, because this is only
   * reached when the price already said *wall* — and the most useful case of
   * that is a lever whose item the listed pack lacks. *Say "use crowbar"
   * here, carrying crowbar* is the errand; *needs 1000 picklocks, your
   * picklocks are not known yet* is the same door with the answer left out.
   */
  private leverSaying(
    from: RoomId,
    direction: string
  ): { opensBySaying?: string; opensItemName?: string } {
    const lever = this.leversHere(from, direction)[0];
    if (lever === undefined) return {};
    const item = lever.item === undefined ? undefined : this.item(lever.item);
    return {
      opensBySaying: lever.say,
      ...(item === undefined ? {} : { opensItemName: item.name })
    };
  }

  private leverPrice(from: RoomId, direction: string, traveller: Traveller): number | null {
    const levers = this.leversHere(from, direction);
    if (levers.length === 0) return null;
    /*
     * And the pack decides, exactly as it does for a hidden exit's levers
     * (`actionItemLacking`): `use crowbar` opens the warehouse door at 1/1104
     * and the server answers *You don't have crowbar to use!* without one. A
     * listed pack lacking it is the wall again — null, so every reader agrees
     * this step is one — while a pack nobody has listed is *nobody has looked*
     * and pays the unevaluated price on top. Todo 13 in a second spelling: a
     * route was planned through *hold up talisman* at the cost of a free
     * lever, by a character with no talisman.
     */
    const open = 25 + 5 * levers.length;
    const wanted = levers
      .map((lever) => lever.item)
      .filter((item): item is number => item !== undefined);
    if (wanted.length === 0 || wanted.every((item) => traveller.keys?.includes(item))) return open;
    return traveller.packKnown === true ? null : open + UNEVALUATED;
  }

  /**
   * The monster index out of the header. Present from v3 on, with a
   * disposition from v5 on.
   *
   * A realm file built before this existed simply names no monsters, and every
   * consumer already has to handle a name the realm cannot place — so an older
   * file degrades to exactly that case rather than failing to load.
   */
  private loadMobs(raw: unknown): void {
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const name = String(record['n'] ?? '').trim();
      const lo = Number(record['hp']);
      if (name.length === 0 || !Number.isFinite(lo) || lo <= 0) continue;
      const hi = Number(record['hi']);
      const ambiguous = Number.isFinite(hi) && hi > lo;
      // The *high* end is what a bar works from: see `WorldMob`. The span is
      // carried alongside so a card can admit the realm data is not certain.
      const mob: WorldMob = {
        name,
        hp: ambiguous ? hi : lo,
        // Null on a realm built before v5, which is the same answer a realm
        // that never stated the column gives: nothing knows, so nothing swings.
        disposition: dispositionFromCode(record['d']),
        uncertain: record['x'] === 1,
        // `a` always, `s` sometimes, absent never. A realm built before this
        // was indexed says nothing, which reads as never — and never is right:
        // it is what every realm without the column also means.
        costly: record['ep'] === 'a' ? 'always' : record['ep'] === 's' ? 'sometimes' : 'never'
      };
      if (ambiguous) mob.span = [lo, hi];
      /*
       * Format 12. Each absent both on an older realm file and on a realm that
       * states no such column, which every consumer already treats the same
       * way: the realm does not say. `positive` refuses zero for the same
       * reason `number()` in `buildRealm` does — a monster with no armour and
       * a realm that never stated one are the same fact, and neither is "0".
       */
      const positive = (key: string): number | undefined => {
        const value = Number(record[key]);
        return Number.isFinite(value) && value > 0 ? value : undefined;
      };
      mob.armour = positive('ac');
      mob.damageResist = positive('dr');
      mob.magicResist = positive('mr');
      mob.experience = positive('xp');
      mob.regen = positive('rgn');
      // Format 36. Written only where every row of the name agrees, so where
      // it is here it answers for the fold as exactly as a row would.
      mob.regenHours = positive('rt');
      mob.follows = positive('fol');
      if (record['und'] === 1) mob.undead = true;
      const drops = Array.isArray(record['drops'])
        ? record['drops'].filter(
            (name): name is string => typeof name === 'string' && name.length > 0
          )
        : [];
      if (drops.length > 0) mob.drops = drops;
      // Format 18. `realmTypes` is carried and read by nothing; see the field.
      const realmTypes = readIdList(record['ty']);
      if (realmTypes.length > 0) mob.realmTypes = realmTypes;
      mob.averageDamage = positive('dmg');
      mob.charmLevel = positive('chl');
      const casts = readIdList(record['cast']);
      if (casts.length > 0) mob.casts = casts;
      const deathSpell = Number(record['ds']);
      if (Number.isInteger(deathSpell) && deathSpell > 0) mob.deathSpell = deathSpell;
      /*
       * Format 20. Two absences, told apart by the file's own version: a
       * realm written with profiles that states none for this name is saying
       * it fights with nothing, which is `[]` and weighs nothing; a realm
       * written before them says nothing at all, which stays absent and is
       * weighed as unknown — never as harmless.
       */
      const profiles = readProfiles(record['pf']);
      if (profiles.length > 0) mob.profiles = profiles;
      else if (this.meta.version >= PROFILES_SINCE) mob.profiles = [];
      // What it resists and ignores — format 14, the worst of the rows sharing
      // this name. See `BuiltMob.ab`.
      const abilities = readAbilities(record);
      if (abilities.length > 0) mob.abilities = abilities;
      this.mobs.set(mobKey(name), mob);
      const ids = (Array.isArray(record['i']) ? record['i'] : []).filter(
        (id): id is number => typeof id === 'number'
      );
      if (ids.length > 0) mob.ids = ids;
      /*
       * Format 32: each row's own answers ride beside its number, and are read
       * only where the writer kept the two lists in step — a list one short
       * would answer for the row beside the one asked about. And only where
       * every written profile was read back, for the same reason:
       * `readProfiles` drops a row it cannot read, which slides every index
       * after it along by one.
       */
      const rows = Array.isArray(record['rw']) ? record['rw'] : [];
      const byRow =
        rows.length === ids.length &&
        (!Array.isArray(record['pf']) || record['pf'].length === profiles.length);
      for (const [k, id] of ids.entries()) {
        this.mobsById.set(id, mob);
        if (!byRow) continue;
        const own = rows[k];
        if (typeof own !== 'object' || own === null) continue;
        const row = own as Record<string, unknown>;
        const hp = Number(row['hp']);
        if (!Number.isFinite(hp) || hp <= 0) continue;
        const at = row['p'];
        const kept: WorldMobRow = {
          id,
          hp,
          disposition: dispositionFromCode(row['d']),
          profile: typeof at === 'number' ? (profiles[at] ?? null) : null
        };
        const stated = (key: string): number | undefined => {
          const value = Number(row[key]);
          return Number.isFinite(value) && value > 0 ? value : undefined;
        };
        kept.armour = stated('ac');
        kept.damageResist = stated('dr');
        kept.magicResist = stated('mr');
        kept.experience = stated('xp');
        kept.regen = stated('rgn');
        kept.regenHours = stated('rt');
        kept.follows = stated('fol');
        kept.averageDamage = stated('dmg');
        kept.charmLevel = stated('chl');
        if (row['und'] === 1) kept.undead = true;
        this.rowsById.set(id, kept);
      }
    }
  }

  /**
   * The shop index out of the header. Present from v4 on.
   *
   * Item numbers are resolved to names here rather than at every use: the item
   * index is already loaded by this point, and a card that had to do the lookup
   * would be doing it per render.
   */
  private loadShops(raw: unknown): void {
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = Number(record['id']);
      if (!Number.isInteger(id)) continue;
      const ids = Array.isArray(record['items']) ? record['items'] : [];

      const stock: WorldShopItem[] = [];
      for (const raw of ids) {
        const item = this.items.get(Number(raw));
        // An id the item index does not carry is a row the realm dropped;
        // naming it "item 1124" would be worse than leaving it out.
        if (!item || item.name.length === 0) continue;
        const line: WorldShopItem = { id: item.id, name: item.name };
        if (item.price !== undefined) line.price = item.price;
        if (item.encumbrance !== undefined) line.encumbrance = item.encumbrance;
        stock.push(line);
      }
      const kind = shopKind(Number(record['t']));
      // A bank stocks nothing and is still a bank: kept for its kind. A
      // stockless row with no kind is the placeholder it looks like.
      if (stock.length === 0 && (kind === undefined || kind === 'shop')) continue;

      const shop: WorldShop = { id, name: String(record['n'] ?? '').trim(), items: stock };
      const markup = Number(record['markup']);
      if (Number.isFinite(markup) && markup > 0) shop.markup = markup;
      if (kind !== undefined) shop.kind = kind;
      // Who the place serves — format 35. Absent before it, and absent on a
      // row the realm leaves open, which is what `restrictedTo` reads as
      // *anybody*.
      for (const [key, field] of [
        ['min', 'minLevel'],
        ['max', 'maxLevel'],
        ['cls', 'classOnly']
      ] as const) {
        const value = Number(record[key]);
        if (Number.isFinite(value) && value > 0) shop[field] = value;
      }
      this.shops.set(id, shop);
    }
  }

  /** The spell index out of the header. Present from v4 on. */
  private loadSpells(raw: unknown): void {
    const spells: WorldSpell[] = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = Number(record['id']);
      const name = String(record['n'] ?? '').trim();
      if (!Number.isInteger(id) || name.length === 0) continue;
      const spell: WorldSpell = { id, name };
      const short = String(record['short'] ?? '').trim();
      if (short.length > 0) spell.short = short;
      for (const [key, field] of [
        ['level', 'level'],
        ['mana', 'mana'],
        ['energy', 'energy'],
        ['dur', 'duration'],
        // Who it may be cast on — format 17. The realm's own number; a realm
        // converted by an older build states none and reads as "does not
        // say", which keeps every picker open rather than emptying it.
        ['tg', 'targets'],
        // Whether resistance can refuse it — format 20, the same rule.
        ['res', 'resist']
      ] as const) {
        const value = Number(record[key]);
        if (Number.isFinite(value) && value > 0) spell[field] = value;
      }
      /*
       * How much easier or harder than the caster's own figure — format 22.
       *
       * Read on its own and **not** in the loop above, because that loop takes
       * only values above zero and this column is signed: 100 of the shipped
       * realm's spells state a negative difficulty, and a spell that is harder
       * than it looks would have been silently read as one that is neither.
       * Same reason `pw` is read separately.
       */
      const difficulty = Number(record['dif']);
      if (Number.isFinite(difficulty) && difficulty !== 0) spell.difficulty = difficulty;
      // The element — format 34; a file written before it names none.
      const element = spellElementOf(typeof record['at'] === 'number' ? record['at'] : null);
      if (element !== undefined) spell.element = element;
      // What casting it does — format 14, and the whole of what a spell card
      // said nothing about: 1,985 of the realm's 1,990 spells carry these.
      const abilities = readAbilities(record);
      if (abilities.length > 0) spell.abilities = abilities;
      /*
       * And how much of it — format 16. The `Abil-n` row above names what a
       * spell affects; on 1,410 spells the magnitude is here instead, and the
       * card read `M.R. 0` off a column the realm genuinely holds a zero in.
       * A realm converted by an older build states none of this and says
       * nothing rather than zero, which is the same answer as always.
       */
      const power = readPair(record['pw']);
      if (power !== null) spell.power = power;
      const cap = Number(record['cap']);
      if (Number.isFinite(cap) && cap > 0) spell.cap = cap;
      for (const [key, field] of [
        ['mig', 'minGrowth'],
        ['mag', 'maxGrowth'],
        ['dug', 'durationGrowth']
      ] as const) {
        const pair = readPair(record[key]);
        if (pair !== null) spell[field] = pair;
      }
      /*
       * What it does to somebody standing in a room that casts it — format 30.
       * Absent on a realm converted before this reader existed, which reads as
       * *this spell harms nobody standing in the room* — the answer every
       * realm gave until now, and the one this exists to correct.
       */
      const hazard = readHazard(record['hz']);
      if (hazard !== null) spell.hazard = hazard;
      spells.push(spell);
    }
    this.spells = spells;
    this.spellsById = new Map(spells.map((spell) => [spell.id, spell]));
    this.confusionRows = null;
  }

  /**
   * The race index out of the header. Present from v10 on.
   *
   * A stat range is written as a two-element array and is kept only when both
   * ends are numbers — half a range is not a range, and a maximum drawn against
   * a missing minimum reads as one starting at zero.
   */
  private loadRaces(raw: unknown): void {
    const races: WorldRace[] = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = Number(record['id']);
      const name = String(record['n'] ?? '').trim();
      if (!Number.isInteger(id) || name.length === 0) continue;
      const race: WorldRace = { id, name };
      for (const key of ['int', 'wil', 'str', 'hea', 'agl', 'chm'] as const) {
        const pair = record[key];
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const low = Number(pair[0]);
        const high = Number(pair[1]);
        if (!Number.isFinite(low) || !Number.isFinite(high)) continue;
        race[key] = [low, high];
      }
      const hp = Number(record['hpPerLevel']);
      if (Number.isFinite(hp) && hp > 0) race.hpPerLevel = hp;
      // Read separately from the hit points, and **without the sign filter**:
      // this is a term of `100 + race + class`, and stock MajorMUD prices a
      // Thief at -20. See `indexRaces` in `buildRealm.ts`.
      const exp = Number(record['expTable']);
      if (Number.isFinite(exp) && exp !== 0) race.expTable = exp;
      // What the race grants — format 14.
      const abilities = readAbilities(record);
      if (abilities.length > 0) race.abilities = abilities;
      races.push(race);
    }
    this.races = races;
  }

  /**
   * The realm's quests, out of the header. Present from v24 on.
   *
   * Read back defensively rather than trusted: this file is on the player's
   * own disk and may have been converted by any build, so a shape that is not
   * a quest is dropped rather than handed to a card that would then render
   * `undefined`. The same reading every index above does.
   */
  private loadQuests(raw: unknown): void {
    const quests: Quest[] = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = Number(record['id']);
      const name = String(record['name'] ?? '').trim();
      const steps = Array.isArray(record['steps']) ? (record['steps'] as Quest['steps']) : [];
      // A quest with no steps is a counter nothing advances, which is not a
      // quest anybody can do.
      if (!Number.isInteger(id) || name.length === 0 || steps.length === 0) continue;
      quests.push({ id, name, steps });
    }
    this.questBook = quests;
  }

  /**
   * Every quest this realm scripts, with what the realm knows about its items
   * and its rooms joined on.
   *
   * Empty for a realm converted before v24 and for one that scripts none —
   * which the card says out loud rather than drawing an empty book.
   *
   * ## Why the join is here and not in the world file
   *
   * `indexQuests` names every item a step demands, and stops there: a quest
   * item is not in `neededItems`, so `indexItems` never gives most of them
   * `shops` or `mobs`. Both halves of the answer are nonetheless already on
   * disk — the shop index stocks ids, and 538 monsters name what they drop —
   * so this is a **join between two indexes the file already holds**, not a
   * third copy of either. Writing it into the header would bump the realm
   * format, invalidate every converted realm on every player's disk, and leave
   * two records of one fact to keep in step.
   *
   * It answers 29 of the shipped realm's 79 item requirements — 24 on a
   * monster and 7 in a shop. The rest name the item and say nothing, which is
   * the refusal `localMap` already makes about a key with no known source.
   *
   * Computed once and held: the book does not change while a realm is loaded,
   * and the card asks for it on every mount.
   */
  quests(): readonly Quest[] {
    this.questsJoined ??= this.questBook.map((quest) => ({
      ...quest,
      steps: quest.steps.map((step) => this.joinStep(step))
    }));
    return this.questsJoined;
  }

  /**
   * One step, with its room named and its items' sources looked up.
   *
   * The step is copied rather than written through: `questBook` is what the
   * file said, and a join that mutated it would make a second call see its own
   * previous answer as the realm's.
   */
  private joinStep(step: QuestStep): QuestStep {
    const joined: QuestStep = { ...step };
    if (step.room !== undefined) {
      const at = asRoomReference(step.room);
      const name = at === null ? undefined : this.get(at.map, at.room)?.name;
      // A room the realm no longer has keeps its address and gains no name,
      // rather than being dropped: the address is still what the realm said.
      if (name !== undefined && name.length > 0) joined.place = name;
      // And what the way there wants carried, where the realm encloses it: a
      // step is *go there and say this*, and the there is routinely behind a
      // door the step says nothing about. See `approachItems`.
      const approach = this.approachItems(step.room);
      if (approach.length > 0) joined.approach = approach;
    }
    const sources: QuestSource[] = [];
    for (const [id, name] of this.itemsDemanded(step)) {
      const known = this.items.get(id);
      /*
       * Both directions here too, and for the same reason as the monsters:
       * `WorldItem.shops` is filled only for an item `indexItems` was asked
       * for and is capped at six, while the shop index stocks ids outright.
       * A shop named by either is a shop that sells it.
       */
      const shops = new Set(known?.shops ?? []);
      for (const shop of this.stockedBy(id)) shops.add(shop);
      /*
       * Both directions, because they cover different items. `WorldItem.mobs`
       * exists only for an item `indexItems` was asked for; the drop lists on
       * the monsters name items by name and cover the rest — which is most of
       * a quest's items. A name the realm gave the step and a name a monster
       * drops are the same string in the same table, so the match is exact
       * rather than fuzzy.
       */
      const mobs = new Set(known?.mobs ?? []);
      if (name !== undefined) for (const mob of this.dropsOf(name)) mobs.add(mob);
      /*
       * And the third answer — format 39, the one the two indexes above could
       * not give. A quest component is handed over by a script, not stocked
       * and not on a drop list, so `acid gland`, `unfertilized eggs` and
       * `double-terminated quartz` were three of the four things PhoenixQuest
       * asks for with nothing at all said about where to get them.
       */
      const from = (known === undefined ? [] : (this.placingHandovers(known).from ?? [])).map(
        // Per handover, not per item: two handovers of one thing are two
        // places, and the way into each is its own question.
        (handover) => this.approaching(handover)
      );
      if (shops.size === 0 && mobs.size === 0 && from.length === 0) continue;
      const source: QuestSource = { id };
      if (shops.size > 0) source.shops = [...shops];
      if (mobs.size > 0) source.mobs = [...mobs];
      if (from.length > 0) source.from = from;
      sources.push(source);
    }
    if (sources.length > 0) joined.sources = sources;
    return joined;
  }

  /**
   * One handover, with what the way to where it happens demands carried.
   *
   * The quest book's own join and nobody else's — see `ItemHandover.approach`
   * for why the Reference card does not pay for it. A copy, like
   * `placingHandovers` beside it, because the item index holds one object per
   * item and every lookup shares it.
   */
  private approaching(handover: ItemHandover): ItemHandover {
    if (handover.room === undefined) return handover;
    const approach = this.approachItems(handover.room as RoomId);
    return approach.length === 0 ? handover : { ...handover, approach };
  }

  /**
   * Every item a step demands, by id, with the name the step gave it.
   *
   * The gates and `takes` overlap almost entirely — a step that consumes an
   * item states `checkitem` beside its `takeitem` — so they are merged here
   * rather than looked up twice. `item-absent` is deliberately included: *not
   * carrying this* is still a sentence about an item, and knowing where the
   * thing comes from is how somebody avoids picking it up.
   */
  private itemsDemanded(step: QuestStep): Map<number, string | undefined> {
    const wanted = new Map<number, string | undefined>();
    // The step's own, and every route's: a class's route routinely asks for a
    // different thing, and an item placed on one route and not the others is
    // still an item somebody has to go and find.
    for (const way of [step, ...(step.ways ?? [])]) {
      for (const gate of way.needs) {
        if (gate.kind !== 'item' && gate.kind !== 'item-absent') continue;
        if (!wanted.has(gate.id) || wanted.get(gate.id) === undefined) {
          wanted.set(gate.id, gate.name);
        }
      }
      for (const item of way.takes) {
        if (!wanted.has(item.id) || wanted.get(item.id) === undefined) {
          wanted.set(item.id, item.name);
        }
      }
    }
    return wanted;
  }

  /**
   * The order a step's several items are best fetched in — todo 01.
   *
   * A step that demands four things states them in the order its own opcodes
   * happen to run, and that is nobody's walk: PhoenixQuest asks for an acid
   * gland, unfertilized eggs, a double-terminated quartz and cave roots, and
   * the realm puts them in four rooms with nothing to do with that list. So
   * this answers the question the list was standing in for — *where do I go
   * first* — as the shortest walk from where the character is standing,
   * through one place for each item, and back to the step's own room.
   *
   * **Exact, not greedy.** Nearest-first is wrong in the ordinary case and
   * wrong in a way nobody can see: it takes the near thing whose neighbour is
   * a long way back. So every order of the items is weighed, over every place
   * each can be got (`errandPlaces`), which is a travelling salesman's path
   * and is solved as one — a subset-and-last table, exponential in the items
   * and bounded by `errandItems` at twice the largest step either shipped
   * world holds.
   *
   * **Chosen in the router's units and reported in moves**, which is
   * `scatterMoves`' rule one card across: the order has to price the lair, the
   * hazard and the door this character cannot force, or it would send somebody
   * through the short way that kills them; the reader wants the number of
   * times they press a direction. The two sweeps carry both.
   *
   * **A plan, not a reading.** It is solved from where the character stood
   * when the card asked, and `QuestErrand.from` says which room that was: it
   * is not re-solved on every step, because the sweeps cost tens of
   * milliseconds each on the thread the socket is on.
   */
  errand(step: QuestStep, from: RoomId, traveller: Traveller): QuestErrand | null {
    const here = this.rooms.get(from);
    if (here === undefined) return null;
    const brought = itemsBrought(step);
    // One thing to fetch is a list and not a walk, and the card draws it the
    // way it always did: there is nothing here for this to add.
    if (brought.length < 2) return null;

    const answer: QuestErrand = {
      block: step.block,
      from,
      ...(here.name.trim().length > 0 ? { fromPlace: here.name } : {}),
      legs: [],
      moves: 0,
      left: []
    };
    const { errandItems, errandPlaces } = tuning().world;

    /*
     * Where each of them can be got, as rooms rather than as the names the
     * card prints. An item the realm places nowhere is not a leg of anything
     * and is never given a position in the walk — the same refusal the card
     * already makes about where it comes from, carried through to the order.
     */
    const placed: Array<{ id: number; name?: string; rooms: RoomId[] }> = [];
    for (const item of brought) {
      const rooms = this.errandRooms(step, item.id);
      const named = item.name === undefined ? {} : { name: item.name };
      if (rooms.length === 0) answer.left.push({ id: item.id, ...named, why: 'unplaced' });
      else placed.push({ id: item.id, ...named, rooms });
    }
    // Fewer than two places to go is not an order, and saying so would be
    // noise on a card that already names where the one of them is.
    if (placed.length < 2) return null;
    if (placed.length > errandItems) {
      return { ...answer, refusal: t('cards.quests.errand.tooMany', { items: placed.length }) };
    }

    const end =
      step.room !== undefined && this.rooms.has(step.room as RoomId) ? (step.room as RoomId) : null;
    const asked = new Set<RoomId>(placed.flatMap((item) => item.rooms));
    if (end !== null) asked.add(end);
    const reach = this.sweepTo(from, asked, traveller);

    /*
     * The nearest few places for each, because a monster that drops one of
     * these spawns in up to sixteen rooms and every one of them is a sweep.
     * Nearest **to the start**, which is the one distance already in hand — a
     * place further off than three others is not where the shortest walk goes
     * unless it was going that way anyway, and the ones kept are then weighed
     * against the whole walk rather than picked by this distance.
     */
    const nodes: Array<{ item: number; room: RoomId }> = [];
    const wanted: Array<{ id: number; name?: string }> = [];
    for (const item of placed) {
      const named = item.name === undefined ? {} : { name: item.name };
      const reachable = item.rooms
        .filter((room) => reach.has(room))
        .sort((a, b) => reach.get(a)!.cost - reach.get(b)!.cost)
        .slice(0, errandPlaces);
      if (reachable.length === 0) {
        answer.left.push({ id: item.id, ...named, why: 'unreachable' });
        continue;
      }
      const at = wanted.length;
      wanted.push({ id: item.id, ...named });
      for (const room of reachable) nodes.push({ item: at, room });
    }
    if (wanted.length === 0) return { ...answer, refusal: t('cards.quests.errand.noWay') };

    const kept = new Set<RoomId>(nodes.map((node) => node.room));
    if (end !== null) kept.add(end);
    const between = new Map<RoomId, Map<RoomId, { cost: number; moves: number }>>();
    for (const room of kept) {
      if (room === end && !nodes.some((node) => node.room === end)) continue;
      between.set(room, this.sweepTo(room, kept, traveller));
    }

    const order = this.bestOrder(nodes, reach, between, end);
    if (order === null) return { ...answer, refusal: t('cards.quests.errand.noWay') };

    let previous: RoomId | null = null;
    for (const index of order) {
      const node = nodes[index]!;
      const measured = (previous === null ? reach : between.get(previous)!).get(node.room)!;
      answer.legs.push({
        item: wanted[node.item]!,
        ...this.errandLeg(node.room),
        moves: measured.moves
      });
      previous = node.room;
    }
    /*
     * And the way back, where the step names a room and the walk can close on
     * it. A one-way exit is a real thing in this realm — the Rancid Sewer's
     * outflow is one — so the last leg is simply absent where the errand
     * cannot get home from the last thing it picks up, which is what the card
     * reads to decide whether to draw it.
     */
    if (end !== null && previous !== null) {
      const home = between.get(previous)!.get(end);
      if (home !== undefined) answer.legs.push({ ...this.errandLeg(end), moves: home.moves });
    }
    answer.moves = answer.legs.reduce((total, leg) => total + leg.moves, 0);
    return answer;
  }

  /** One leg's address, with the room's own name where the realm has one. */
  private errandLeg(room: RoomId): { room: string; place?: string } {
    const name = this.rooms.get(room)?.name.trim() ?? '';
    return { room, ...(name.length > 0 ? { place: name } : {}) };
  }

  /**
   * The cheapest order to visit one place for each item in, ending at `end`.
   *
   * Held and Karp's table — the cheapest way to have collected each *subset*
   * of the items and be standing at each place — which is what makes this
   * exact rather than a nearest-first walk. The subset is over **items**
   * while the position is over **places**, so a thing that can be got in
   * three rooms costs three columns and not three items' worth of table.
   *
   * `null` where no order reaches every item: a pair the realm's one-way
   * exits keep apart is a walk nobody can take, and the refusal above says so
   * rather than dropping an item out of a list presented as complete.
   */
  private bestOrder(
    nodes: ReadonlyArray<{ item: number; room: RoomId }>,
    reach: ReadonlyMap<RoomId, { cost: number; moves: number }>,
    between: ReadonlyMap<RoomId, ReadonlyMap<RoomId, { cost: number; moves: number }>>,
    end: RoomId | null
  ): number[] | null {
    const items = new Set(nodes.map((node) => node.item)).size;
    const full = (1 << items) - 1;
    const width = nodes.length;
    const best = new Float64Array((full + 1) * width).fill(Number.POSITIVE_INFINITY);
    const came = new Int32Array((full + 1) * width).fill(-1);

    for (let at = 0; at < width; at += 1) {
      const first = reach.get(nodes[at]!.room);
      if (first !== undefined) best[(1 << nodes[at]!.item) * width + at] = first.cost;
    }
    for (let mask = 1; mask <= full; mask += 1) {
      for (let at = 0; at < width; at += 1) {
        const cost = best[mask * width + at]!;
        if (!Number.isFinite(cost)) continue;
        const onward = between.get(nodes[at]!.room);
        if (onward === undefined) continue;
        for (let next = 0; next < width; next += 1) {
          const bit = 1 << nodes[next]!.item;
          if ((mask & bit) !== 0) continue;
          const leg = onward.get(nodes[next]!.room);
          if (leg === undefined) continue;
          const total = cost + leg.cost;
          const slot = (mask | bit) * width + next;
          if (total >= best[slot]!) continue;
          best[slot] = total;
          came[slot] = at;
        }
      }
    }

    let cheapest = Number.POSITIVE_INFINITY;
    let last = -1;
    for (let at = 0; at < width; at += 1) {
      const cost = best[full * width + at]!;
      if (!Number.isFinite(cost)) continue;
      /*
       * The way home is part of the order and not a figure added after it: the
       * nearest four things to fetch in the wrong order end a long way from
       * the asker. Where the walk cannot close at all — a one-way exit out of
       * the last room — the order is still the right one for the pickups, so
       * the return leg costs nothing here and is left off the plan above.
       */
      const home = end === null ? 0 : (between.get(nodes[at]!.room)?.get(end)?.cost ?? null);
      const total = cost + (home ?? 0);
      if (total >= cheapest) continue;
      cheapest = total;
      last = at;
    }
    if (last === -1) return null;

    const walk: number[] = [];
    let mask = full;
    let cursor = last;
    while (cursor !== -1) {
      walk.unshift(cursor);
      const before = came[mask * width + cursor]!;
      mask &= ~(1 << nodes[cursor]!.item);
      cursor = before;
    }
    return walk;
  }

  /**
   * Every room the realm places one of a step's items in, as addresses.
   *
   * The three answers `QuestSource` already carries, turned from names into
   * places: a handover states its own room, a monster's is `mobPlaces` and a
   * shop's is `shopPlace` — including a shop name in fourteen rooms, because
   * every one of them sells the thing and the walk is free to pick whichever
   * it passes. A room the realm no longer holds is dropped rather than
   * planned to.
   */
  private errandRooms(step: QuestStep, id: number): RoomId[] {
    const source = step.sources?.find((known) => known.id === id);
    if (source === undefined) return [];
    const rooms = new Set<RoomId>();
    for (const handover of source.from ?? []) {
      if (handover.room !== undefined) rooms.add(handover.room as RoomId);
    }
    for (const who of source.mobs ?? []) {
      const mob = this.mob(who);
      if (mob === undefined) continue;
      for (const spawn of this.mobPlaces(mob)?.spawns ?? []) {
        for (const at of spawn.rooms) rooms.add(roomId(at.map, at.room));
      }
    }
    for (const name of source.shops ?? []) {
      const place = this.shopPlace(name);
      if (place === undefined) continue;
      if (place.at === 'one') rooms.add(roomId(place.map, place.room));
      else for (const at of place.rooms) rooms.add(roomId(at.map, at.room));
    }
    return [...rooms].filter((room) => this.rooms.has(room));
  }

  /**
   * Where the realm says an item comes from: shops that stock it by id, and
   * monsters that drop it by name (todo 07).
   *
   * The public half of the two indexes the quest book already joins, for the
   * one other caller that asks the same question — a route that crosses a
   * keyed door and wants to go and get the key. Both directions, as
   * `joinStep` reads them: a shop's stock list and an item's own `shops`, a
   * monster's drop list and an item's own `mobs`.
   */
  /**
   * One step of a plan, from the room the step before it ends in: what it
   * gathers and how, where it happens, and whether the way there exists
   * (`QuestPlan`, `mudengine-world` › *A plan is steps, and each is priced from
   * the one before*).
   *
   * One step and not the chain, on purpose: a route is an A* per leg (up to
   * 300ms on Paradigm), so the session paces the chain across the event loop
   * between steps rather than holding the socket's thread for the lot. The
   * traveller is handed in with the counters the character *will* hold at this
   * step, which is what opens the ability-gated exits the realm writes on the
   * way into a chain's later rooms.
   */
  planStep(
    quest: Quest,
    step: QuestStep,
    from: RoomId | null,
    carrying: readonly number[] | null,
    traveller: Traveller,
    supplies: readonly number[] = [],
    lap: Traveller = traveller
  ): PlanStep {
    const at = this.planPlace(step.room);
    const index = quest.steps.indexOf(step);
    const own = itemsBrought(step).map((item) =>
      this.planItem(quest, index, item, from, at?.room ?? null, carrying, traveller, lap)
    );
    const snags: PlanSnag[] = [];
    for (const item of own) {
      if (item.source.how === 'unplaced') {
        snags.push({ kind: 'unplaced', item: item.name ?? `#${item.id}` });
      }
    }
    // What the way wants, gathered before anything the step itself wants:
    // every walk this step makes leaves from `from`, and the hunts leave first.
    const bought: PlanItem[] = [];
    let reachable: boolean | null = null;
    let moves: number | undefined;
    if (from !== null && at !== undefined && this.rooms.has(from) && this.rooms.has(at.room)) {
      /*
       * Priced as if what is in hand were used — the pack, and what earlier
       * legs of this plan bought — which is the premise the plan's own rows
       * state (`Route.carrying` makes the same one). Without it the desert is
       * a wall and the leg's figure is the way round, drawn beside a chip
       * that says the way through is safe (review, 2026-09-21).
       */
      const inHand = [...(carrying ?? []), ...supplies];
      /*
       * The ways this step walks, in the order the run walks them: out to
       * each monster it hunts, each from where the last hunt ends, then the
       * leg from there to the act. A hunt is the errand's loop, planned on
       * the lap's traveller, so it is read on `lap` — the shortest way,
       * straight through the desert — never on the plan's, which prices a
       * way round it and buys nothing for the way the run takes (review,
       * 2026-09-21; `mudengine-automation` › *A quest's plan is carried*).
       */
      const hunts: Route[] = [];
      let cursor: RoomId = from;
      for (const item of own) {
        if (item.source.how !== 'kill' || item.source.at === undefined) continue;
        const to = item.source.at.room as RoomId;
        if (!this.rooms.has(to)) continue;
        const way = this.route(cursor, to, this.quietened(lap, inHand));
        if (way.blocked) continue;
        hunts.push(way);
        cursor = to;
      }
      let route = this.route(cursor, at.room, this.quietened(traveller, inHand));
      if (route.blocked) {
        reachable = false;
        snags.push({ kind: 'unreachable', reason: route.reason ?? '' });
      } else {
        reachable = true;
        /*
         * What the ways meet that nothing in hand stops is bought here, once
         * each — two spells the same raft stops are one raft — at the counter
         * least off the way to the *first room casting it*, since a counter
         * the route passes beyond the desert prices at nothing and is no use
         * in it. Then the leg is priced again carrying what was bought, and
         * what that way meets is named but not bought for: one more search,
         * never a chase.
         */
        const spent: number[] = [];
        for (const way of [...hunts, route]) {
          for (const hazard of way.hazards ?? []) {
            if (!this.worthNaming(hazard)) continue;
            if (this.stopperOf(hazard.id, carrying, [...supplies, ...spent]) !== undefined)
              continue;
            const before =
              this.firstCasting(way.steps, hazard.id) ?? way.steps.at(-1)?.to ?? at.room;
            const supply = this.supplyFor(hazard, from, before, carrying, traveller);
            if (supply === undefined) continue;
            bought.push(supply);
            spent.push(supply.id);
          }
        }
        if (spent.length > 0) {
          const again = this.route(
            cursor,
            at.room,
            this.quietened(traveller, [...inHand, ...spent])
          );
          if (!again.blocked) route = again;
        }
        /*
         * Every hazard the router still names is one the pack does not stop:
         * `hazardAvoided` has already silenced the ones it does. A spell that
         * only summons is a lair by another name and not a thing the walk has
         * to survive, so it is not a snag. The rest are named with what
         * settles them, once each across the hunts and the leg, with the most
         * rooms any one way crosses; a timed passage on any of them is named.
         */
        const named = new Map<number, Extract<PlanSnag, { kind: 'hazard' }>>();
        for (const way of [...hunts, route]) {
          for (const hazard of way.hazards ?? []) {
            if (!this.worthNaming(hazard)) continue;
            const seen = named.get(hazard.id);
            if (seen !== undefined) {
              seen.rooms = Math.max(seen.rooms, hazard.rooms);
              continue;
            }
            const safeWith = this.stopperOf(hazard.id, carrying, [...supplies, ...spent]);
            const snag: Extract<PlanSnag, { kind: 'hazard' }> = {
              kind: 'hazard',
              spell: hazard.spell,
              rooms: hazard.rooms,
              unread: hazard.unread,
              moves: hazard.relocates,
              needs: hazard.needs.map((need) => need.name),
              ...(safeWith === undefined ? {} : { safeWith })
            };
            named.set(hazard.id, snag);
            snags.push(snag);
          }
        }
        for (const way of [...hunts, route]) snags.push(...this.corridorsAlong(way.steps));
        // The step is every way it walks and the way out to each counter and
        // back: a figure that left the hunt out, or the tavern's three
        // hundred rooms, would be a plan nobody could keep to. What the fight
        // itself costs is not a number of moves.
        moves = route.steps.length;
        for (const way of hunts) moves += way.steps.length;
        for (const item of [...bought, ...own]) {
          if (item.source.how === 'buy' && item.source.detour !== undefined)
            moves += item.source.detour;
        }
      }
    }
    const items = [...bought, ...own];
    const roll = stepRoll(step);
    return {
      block: step.block,
      act: planAct(step),
      items,
      ...(at === undefined ? {} : { at }),
      reachable,
      ...(moves === undefined ? {} : { moves }),
      snags,
      ...(roll === null ? {} : { roll })
    };
  }

  /** A room the realm names, with its name where the graph holds it. */
  private planPlace(room: string | undefined): PlanPlace | undefined {
    if (room === undefined) return undefined;
    const name = this.rooms.get(room as RoomId)?.name.trim();
    return name === undefined || name.length === 0 ? { room } : { room, place: name };
  }

  /**
   * Every item the realm says stops a room's spell: the ones its script
   * names outright (`failitem`), and the ones whose *use* casts a spell it
   * names (`failspell 711` is the waterskin, through `grants`). In the
   * realm's order, items before spells.
   */
  private stoppersOf(spell: number): WorldItem[] {
    const hazard = this.spellById(spell)?.hazard;
    if (hazard === undefined) return [];
    const found: WorldItem[] = [];
    for (const id of hazard.avoidedBy ?? []) {
      const item = this.items.get(id);
      if (item !== undefined && !found.includes(item)) found.push(item);
    }
    for (const id of hazard.avoidedBySpell ?? []) {
      for (const item of this.grants.get(id) ?? []) if (!found.includes(item)) found.push(item);
    }
    return found;
  }

  /**
   * Whether a hazard the router names is one the plan should: a spell that
   * does something the reader would want to survive — a figure, a chain that
   * could not be read, a teleport. Read off the spell's own facts and never
   * off `RouteHazard.share`, which is null for *unknown health* as well as
   * for *no figure*, and non-null for a summons the session prices as a
   * discouragement (review, 2026-09-21: the swamp's summons on every leg, and
   * the river dropped before the first status line).
   */
  private worthNaming(hazard: RouteHazard): boolean {
    // A passage the way in opens is the route's own entry for what
    // `corridorsAlong` names on the plan; naming it here would say it twice
    // and buy nothing for it, since nothing carried stops one.
    if (hazard.corridor !== undefined) return false;
    const facts = this.spellById(hazard.id)?.hazard;
    if (facts === undefined) return true;
    return facts.damage !== undefined || facts.unread === true || facts.relocates === true;
  }

  /**
   * The traveller with every room spell that `stoppers` stop priced at
   * nothing — `holding`'s wrapper, over both halves of what stops a spell
   * (the item the script names and the item whose use casts the spell it
   * names). One answer per spell, kept for the search's thousands of asks.
   */
  private quietened(traveller: Traveller, stoppers: readonly number[]): Traveller {
    const priced = traveller.hazard;
    if (priced === undefined || stoppers.length === 0) return traveller;
    const settled = new Map<number, boolean>();
    const stopped = (spell: number): boolean => {
      const known = settled.get(spell);
      if (known !== undefined) return known;
      const answer = this.stoppersOf(spell).some((item) => stoppers.includes(item.id));
      settled.set(spell, answer);
      return answer;
    };
    return {
      ...traveller,
      hazard: (room) => (room.spell !== undefined && stopped(room.spell) ? null : priced(room))
    };
  }

  /** The first room on the way that casts the spell, where a supply must be in hand by. */
  private firstCasting(steps: readonly RouteStep[], spell: number): RoomId | undefined {
    return steps.find(
      (step) => step.scatter === undefined && this.rooms.get(step.to)?.spell === spell
    )?.to;
  }

  /**
   * The name of a stopper already in hand: in the pack, or on a `Get` row of
   * an earlier leg of the same plan. Undefined where the walk would meet the
   * spell with nothing against it — which is what `supplyFor` then answers.
   */
  private stopperOf(
    spell: number,
    carrying: readonly number[] | null,
    supplies: readonly number[]
  ): string | undefined {
    for (const item of this.stoppersOf(spell)) {
      if (supplies.includes(item.id) || packHolds(carrying, item.id) === true) return item.name;
    }
    return undefined;
  }

  /**
   * The stopper to buy for a leg, as a `Get` row: of every item the realm
   * says stops the spell, the one whose counter is least off this leg
   * (`buyingPlaces`, the petrol-station price), with how many
   * (`tuning.world.hazardSupplyCount` for a thing that is spent, one for a
   * thing that is not). Undefined where no counter stocks any of them, and
   * the snag then says what it would have taken.
   */
  private supplyFor(
    hazard: RouteHazard,
    from: RoomId,
    to: RoomId,
    carrying: readonly number[] | null,
    traveller: Traveller
  ): PlanItem | undefined {
    const stoppers = this.stoppersOf(hazard.id);
    const place = this.buyingPlacesFor(
      stoppers.map((item) => item.id),
      from,
      to,
      traveller
    )[0];
    const item = place === undefined ? undefined : stoppers.find((each) => each.id === place.item);
    if (place === undefined || item === undefined) return undefined;
    const at = this.planPlace(roomId(place.map, place.room));
    const spent = item.uses !== undefined && item.uses > 0;
    return {
      id: item.id,
      name: item.name,
      held: packHolds(carrying, item.id),
      hand: false,
      source: {
        how: 'buy',
        shops: [place.shop],
        ...(at === undefined ? {} : { at }),
        detour: place.detour
      },
      ...(spent ? { count: tuning().world.hazardSupplyCount } : {}),
      stops: hazard.spell
    };
  }

  /**
   * The timed passages a route walks into: a text exit whose room command
   * puts a spell on the character (`RoomCommand.casts`, format 43) that ends
   * in another (`EndCast`) — *holding breath* into *drowning* — counted from
   * the room it lands in to the exit whose own cast kills it (`killSpell`,
   * on the spell or on what it ends in), else to the route's end with `ends`
   * false, since a leg that stops underwater is a fact the next leg does not
   * carry. Nothing carried stops one; the plan says how many rooms and how
   * many ticks.
   */
  private corridorsAlong(steps: readonly RouteStep[]): PlanSnag[] {
    return this.corridorsOn(steps).map(({ id: _id, ...snag }) => ({ kind: 'corridor', ...snag }));
  }

  /**
   * The passages a route walks into, with the spell's id, for the plan's
   * snag and the route's hazard alike — one reading, so the two cannot count
   * the rooms differently.
   */
  private corridorsOn(steps: readonly RouteStep[]): Array<{
    id: number;
    spell: string;
    rooms: number;
    ends: boolean;
    ticks?: number;
    then?: string;
  }> {
    const found: Array<{
      id: number;
      spell: string;
      rooms: number;
      ends: boolean;
      ticks?: number;
      then?: string;
    }> = [];
    for (const [index, step] of steps.entries()) {
      if (step.requirement?.kind !== 'text') continue;
      // The phrase the walker will send, not any phrase to that room: two
      // words into one pool may cast two different things or nothing.
      const command = this.rooms
        .get(step.from)
        ?.commands?.find((each) => each.casts !== undefined && each.say.includes(step.command));
      const held = command?.casts === undefined ? null : this.spellById(command.casts);
      if (held === null || held === undefined) continue;
      const next = held.abilities?.find(([ability]) => ability === HAZARD_ABILITY.endCast)?.[1];
      if (next === undefined || next <= 0) continue;
      const then = this.spellById(next);
      const lifts = new Set([held.id, next]);
      let rooms = steps.length - index;
      let ends = false;
      for (let ahead = index + 1; ahead < steps.length; ahead += 1) {
        const exit = steps[ahead]?.requirement;
        if (exit?.kind !== 'cast' || exit.castPre === undefined) continue;
        if (this.killsAny(exit.castPre, lifts, 0)) {
          rooms = ahead - index;
          ends = true;
          break;
        }
      }
      found.push({
        id: held.id,
        spell: held.name,
        rooms,
        ends,
        ...(held.duration === undefined ? {} : { ticks: held.duration }),
        ...(then === null ? {} : { then: then.name })
      });
    }
    return found;
  }

  /** Whether a spell, or what it ends in, takes one of `spells` off the character. */
  private killsAny(spell: number, spells: ReadonlySet<number>, depth: number): boolean {
    if (depth > 4) return false;
    const row = this.spellById(spell);
    if (row === null) return false;
    for (const [ability, value] of row.abilities ?? []) {
      if (ability === HAZARD_ABILITY.killSpell && spells.has(value)) return true;
      if (
        ability === HAZARD_ABILITY.endCast &&
        value > 0 &&
        this.killsAny(value, spells, depth + 1)
      )
        return true;
    }
    return false;
  }

  /**
   * How one item a step wants is got, cheapest act first: it is in the pack;
   * an earlier step of this chain hands it over, so the plan already has it;
   * a counter sells it, chosen by how far off the road it is (`buyingPlaces`);
   * a script hands it over for a word; a monster drops it, at the first place
   * the realm spawns one. Nothing named is `unplaced`, which the plan says
   * rather than guesses about.
   */
  private planItem(
    quest: Quest,
    index: number,
    item: { id: number; name?: string; hand: boolean },
    from: RoomId | null,
    to: RoomId | null,
    carrying: readonly number[] | null,
    traveller: Traveller,
    lap: Traveller
  ): PlanItem {
    const held = packHolds(carrying, item.id);
    const base = {
      id: item.id,
      ...(item.name === undefined ? {} : { name: item.name }),
      held,
      hand: item.hand
    };
    if (held === true) return { ...base, source: { how: 'carried' } };
    const earlier = earlierHandover(quest, index, item.id);
    if (earlier !== null) return { ...base, source: { how: 'earlier', rank: earlier } };
    const source = quest.steps[index]?.sources?.find((known) => known.id === item.id);
    const shops = source?.shops ?? [];
    if (shops.length > 0) {
      const origin = from ?? to;
      const best =
        origin === null ? undefined : this.buyingPlaces(item.id, origin, to, traveller)[0];
      const at = best === undefined ? undefined : this.planPlace(roomId(best.map, best.room));
      return {
        ...base,
        source: {
          how: 'buy',
          shops,
          ...(at === undefined ? {} : { at }),
          ...(best === undefined ? {} : { detour: best.detour })
        }
      };
    }
    for (const handover of source?.from ?? []) {
      const at = this.planPlace(handover.room);
      const placed = at === undefined ? {} : { at };
      const word = handover.say?.[0];
      if (handover.kind === 'killed' && handover.who !== undefined) {
        return { ...base, source: { how: 'kill', mob: handover.who, ...placed } };
      }
      if (handover.kind === 'asked' && handover.who !== undefined) {
        return {
          ...base,
          source: {
            how: 'ask',
            who: handover.who,
            ...(word === undefined ? {} : { say: word }),
            ...placed
          }
        };
      }
      if (word !== undefined) return { ...base, source: { how: 'said', say: word, ...placed } };
    }
    const who = source?.mobs?.[0];
    if (who !== undefined) {
      const start = this.huntStart(item, who, from, lap);
      return {
        ...base,
        source: {
          how: 'kill',
          mob: start?.mob ?? who,
          ...(start === undefined ? {} : { at: start.at })
        }
      };
    }
    return { ...base, source: { how: 'unplaced' } };
  }

  /**
   * Where a hunt for this item would start, and for which dropper: the
   * ring's first stop from where the character stands — `droppingPlaces` on
   * the **lap's** traveller, the errand's own choice priced the errand's own
   * way, so the plan names the room the run will walk to — else the
   * monster's first placement in the realm's order, for a character nobody
   * has placed. Undefined where the realm places none.
   */
  private huntStart(
    item: { id: number; name?: string },
    mob: string,
    from: RoomId | null,
    lap: Traveller
  ): { mob: string; at: PlanPlace } | undefined {
    if (from !== null && this.rooms.has(from)) {
      const first = this.droppingPlaces(item, from, lap, { rooms: 1, radius: 0 }).lairs[0];
      const at = first === undefined ? undefined : this.planPlace(first.id);
      if (first !== undefined && at !== undefined) return { mob: first.mob, at };
    }
    const known = this.mob(mob);
    const spawn = known === undefined ? undefined : this.mobPlaces(known)?.spawns[0]?.rooms[0];
    const at = spawn === undefined ? undefined : this.planPlace(roomId(spawn.map, spawn.room));
    return at === undefined ? undefined : { mob, at };
  }

  sourcesOf(item: { id: number; name?: string }): { shops: string[]; mobs: string[] } {
    const known = this.items.get(item.id);
    const shops = new Set(known?.shops ?? []);
    for (const shop of this.stockedBy(item.id)) shops.add(shop);
    const mobs = new Set(known?.mobs ?? []);
    const name = item.name ?? known?.name;
    if (name !== undefined) for (const mob of this.dropsOf(name)) mobs.add(mob);
    return { shops: [...shops], mobs: [...mobs] };
  }

  /**
   * Where to go and kill for an item, from one room: the realm's every
   * placement of a dropper, priced from `from` with `sweepTo` — the router's
   * units for the choice, moves for the sentence, a wall walked as the errand
   * solver walks one — and the ring nearest: the cheapest placement to reach
   * and the placements within `ring.radius` of it, `ring.rooms` at most, in
   * the order a lap walks out from the first. Cheapest-eight-from-here was a
   * march: five maps for an item five monsters drop.
   *
   * Realm-wide, on the index `mobPlaces` reads: the errand's bounded sweep
   * called a raider 88 moves off *nowhere* (2026-09-21; `mudengine-automation`
   * › *A route that needs an item goes and gets it*). The droppers ride along,
   * each with its own placement count, so an empty `lairs` can say which of
   * two it is without welding one dropper's name to another's rooms.
   */
  droppingPlaces(
    item: { id: number; name?: string },
    from: RoomId,
    traveller: Traveller,
    ring: { rooms: number; radius: number }
  ): DropSources {
    const { mobs } = this.sourcesOf(item);
    const spawns = new Map<RoomId, { room: WorldRoom; mob: string }>();
    const droppers: Dropper[] = [];
    for (const name of mobs) {
      const mob = this.mob(name);
      const placed = new Set<RoomId>();
      for (const { room } of mob === undefined ? [] : this.spawnRoomsOf(mob)) {
        const id = roomId(room.map, room.room);
        placed.add(id);
        if (!spawns.has(id)) spawns.set(id, { room, mob: name });
      }
      droppers.push({ mob: name, placed: placed.size });
    }
    if (spawns.size === 0) return { droppers, lairs: [] };
    const priced = [...this.sweepTo(from, new Set(spawns.keys()), traveller)].sort(
      (a, b) => a[1].cost - b[1].cost || a[1].moves - b[1].moves || a[0].localeCompare(b[0])
    );
    const first = priced[0];
    if (first === undefined) return { droppers, lairs: [] };
    const around = this.withinSteps(first[0], ring.radius, traveller);
    const lairs = priced
      .filter(([id]) => around.has(id))
      .sort(
        (a, b) => around.get(a[0])! - around.get(b[0])! || priced.indexOf(a) - priced.indexOf(b)
      )
      .slice(0, Math.max(1, ring.rooms))
      .map(([id, { moves }]) => {
        const { room, mob } = spawns.get(id)!;
        return { id, name: room.name, mob, steps: moves };
      });
    return { droppers, lairs };
  }

  /**
   * What the way into a room demands be carried, or nothing where it is open.
   *
   * Reported 2026-09-15 (todo 02): the quest book said *golden egg — kill
   * necromancer in Amethyst Cave* and stopped. Reaching that cave takes a
   * potion of levitation, a titanium fork and a magical quartz rod; the realm
   * states all three and nothing was reading any of them.
   *
   * **Two halves, because *what encloses this place* and *what opens it* are
   * different questions.** `enclosing` sweeps backwards over every way in that
   * demands no item and gives the question up the moment it reaches the open
   * realm — so what it returns is a pocket with no free entrance, or nothing
   * at all. Inside that pocket the question is then answered **forwards and by
   * trial**: `opensInto` floods from whichever doors the items in hand unlock,
   * which is what the server actually does, and a set of items is *required*
   * when taking any one of them away puts the room out of reach.
   *
   * The trial matters, and the first attempt at this got it wrong by reasoning
   * about frontiers in order instead. The Catacombs' fork doors are all
   * *inside* the pocket, so the frontier chain read the fork as needed at the
   * near gates and then dismissed the potion at the far one as a door the fork
   * already opens — which is exactly backwards: the fork opens nothing from
   * the mainland, and the potion is the only entrance there is. Measured
   * forwards from Town Gates: nothing reaches 44,803 rooms, the fork alone
   * adds none, the potion adds 26, the potion and the fork add 143 more, and
   * only all three reach the Amethyst Cave.
   *
   * **Every item reported is necessary given the others** — that is what the
   * minimisation leaves — and an item that could stand in for one of them is
   * named beside it (`ApproachGate.anyOf`) rather than being picked between.
   * Ordered by when the flood can first use each, which is the order they are
   * fetched in. Where the items to hand do not reach the room at all the
   * answer is nothing: an account the client cannot complete is not one to
   * send somebody out on. Stock's Fine Mansion study is what the trial buys
   * over counting frontiers twice: a skeleton key opens a door into that
   * pocket and the study is not behind it, so the honest answer is the black
   * serpent key alone, and the frontier count said *either*.
   */
  /**
   * Every item that is a way through, as an edge the router can relax.
   *
   * **`WorldItem.lands` was read in one direction only** and that was the
   * whole bug: `waysIn` below feeds `approachItems`, which walks *backwards*
   * to answer what the way into a place wants, so the client could tell a
   * player the Amethyst Cave needs a potion of levitation, a titanium fork and
   * a magical quartz rod and then answer *the realm data joins no path*
   * when asked to walk there. No exit or portal in either database enters the
   * 173 rooms behind the potion — measured both ways, the cave reaches Town
   * Gates and nothing reaches the cave — so for the router those rooms did not
   * exist at all.
   *
   * Modelled as a `PortalExit` because that is what it is: the realm moves the
   * character by coordinates, no compass reasoning applies, and everything
   * downstream that already treats a portal as its own thing is correct about
   * this without being told. The requirement is `item`, which is not a
   * decoration — `edgePenalty`'s `item` rung is exactly the three answers the
   * pack can give, so *carried is free, listed and lacking is a wall, never
   * listed is discouraged* comes out right without a second implementation of
   * a rule this file already states once.
   */
  private itemLandings(): ReadonlyArray<PortalExit> {
    if (this.landings !== null) return this.landings;
    const built: PortalExit[] = [];
    for (const item of this.items.values()) {
      if (item.lands === undefined) continue;
      /*
       * **A landing bound to a room is not one of these.** It is an ordinary
       * way out of that room and `linkItemLandings` has already made it a
       * portal there, so relaxing it from wherever the character stands as
       * well would put the bug back: the potion of levitation used in the
       * Alchemist's Hut is a block that fails on its first step and a server
       * that answers nothing at all.
       */
      if (item.usableIn !== undefined) continue;
      const target = this.rooms.get(item.lands);
      // A landing outside the dataset is a hole in the data, not a way, by the
      // same rule the exit loop applies to an exit pointing nowhere.
      if (target === undefined || item.name.length === 0) continue;
      const command = `use ${item.name}`;
      const exit: PortalExit = {
        direction: 'portal',
        map: target.map,
        room: target.room,
        requirement: {
          kind: 'item',
          raw: `Item: ${item.id}`,
          keyId: item.id,
          commands: [command],
          // Who may use it, so a token the character has not grown into is
          // refused here rather than by the server (`edgePenalty`).
          ...useGateOf(item)
        }
      };
      built.push(exit);
      this.spends.set(exit, {
        id: item.id,
        name: item.name,
        command,
        // `-1` is the realm's word for *for ever* and absent is the same
        // silence format 25 exists to tell apart from it; both are null here,
        // because this field answers *how many* and neither states a number.
        uses: item.uses === undefined || item.uses < 0 ? null : item.uses
      });
    }
    this.landings = built;
    return built;
  }

  /**
   * Everything the landings can reach between them, requirements ignored.
   *
   * One multi-source sweep rather than one per item, because the question is
   * *could any of them help* and the union answers it. Gates are ignored so
   * the answer stays a superset of what any traveller could do with them: it
   * may say yes where the real answer is no, which costs one search, and it
   * must never say no where the real answer is yes, which would lose a route.
   */
  private landingsReach(): ReadonlySet<RoomId> {
    if (this.landingReachable !== null) return this.landingReachable;
    const seen = new Set<RoomId>();
    let frontier: RoomId[] = [];
    for (const exit of this.itemLandings()) {
      const id = roomId(exit.map, exit.room);
      if (this.rooms.has(id) && !seen.has(id)) {
        seen.add(id);
        frontier.push(id);
      }
    }
    while (frontier.length > 0) {
      const next: RoomId[] = [];
      for (const id of frontier) {
        const room = this.rooms.get(id);
        if (room === undefined) continue;
        for (const exit of room.exits) {
          if (exit.requirement?.spellEffect === 'scatters') continue;
          const to = this.beyond(exit);
          if (!seen.has(to) && this.rooms.has(to)) {
            seen.add(to);
            next.push(to);
          }
        }
        for (const portal of this.portalsFrom(id)) {
          const to = roomId(portal.map, portal.room);
          if (!seen.has(to) && this.rooms.has(to)) {
            seen.add(to);
            next.push(to);
          }
        }
      }
      frontier = next;
    }
    this.landingReachable = seen;
    return seen;
  }

  approachItems(room: RoomId): ApproachGate[] {
    const inside = this.enclosing(room);
    if (inside === null) return [];

    const candidates = this.gatesWithin(inside);
    if (candidates.length === 0) return [];
    const opens = (held: ReadonlySet<number>): boolean =>
      this.opensInto(room, inside, held).has(room);
    // Everything the realm offers, and it still does not get there: the client
    // cannot account for this room and says so by saying nothing.
    if (!opens(new Set(candidates))) return [];

    // Minimised one at a time, so what is left is a set no member of which can
    // be dropped — every row the card draws is an errand the realm insists on.
    const kept = [...candidates];
    for (const item of candidates) {
      const without = new Set(kept.filter((held) => held !== item));
      if (!opens(without)) continue;
      kept.splice(kept.indexOf(item), 1);
    }
    if (kept.length === 0) return [];

    return this.orderApproach(room, inside, kept, candidates);
  }

  /**
   * The order the items are used in, each with whatever could stand in for it.
   *
   * The flood is run again, adding at each stage the kept items it can now
   * reach a door for: that is the order somebody fetches them in, and it is
   * the realm's own rather than the id order the minimisation happened to
   * leave. A stand-in is an item *outside* the kept set that the room is still
   * reachable with in place of this one — the alternative the minimisation had
   * to choose between and must not hide.
   */
  private orderApproach(
    room: RoomId,
    inside: ReadonlySet<RoomId>,
    kept: readonly number[],
    candidates: readonly number[]
  ): ApproachGate[] {
    const order: number[] = [];
    const held = new Set<number>();
    while (order.length < kept.length) {
      const next = kept.filter(
        (item) =>
          !held.has(item) &&
          this.opensInto(null, inside, new Set([...held, item])).size >
            this.opensInto(null, inside, held).size
      );
      // Nothing opens anything further on its own — the rest are wanted
      // together, and the id order they are in is as good as any.
      const stage = next.length > 0 ? next : kept.filter((item) => !held.has(item));
      for (const item of stage) {
        order.push(item);
        held.add(item);
      }
    }

    const others = candidates.filter((item) => !kept.includes(item));
    return order.map((item) => {
      const rest = order.filter((held) => held !== item);
      const instead = others.filter((other) =>
        this.opensInto(room, inside, new Set([...rest, other])).has(room)
      );
      return { anyOf: [item, ...instead].map((id) => this.approachItem(id)) };
    });
  }

  /**
   * The pocket a room sits in, or null where the realm leaves it open.
   *
   * Backwards over every way in that demands no item, so what it collects is
   * closed under un-gated entry: every remaining way in wants something. That
   * reasoning holds only while the region stays a pocket — out in the open
   * realm the gates it meets are other pockets' doors, and unbounded it
   * answered an ordinary street with every key in the realm — so it gives the
   * question up past `tuning.world.approachRooms`.
   *
   * **It grows *through* a gate and falls back when that escapes.** The rooms
   * a door is crossed from are taken in too, because the Catacombs' own doors
   * are inside the pocket and a region stopping at the first of them would
   * name one gate and miss the two behind it. When taking a door in lets the
   * open realm flood through, the answer is the **last state that was still a
   * pocket** — which is what keeps the Lake of Fire, whose one door opens onto
   * the mainland, answering *basalt key* instead of saying nothing. Null is
   * the room that was never enclosed at all.
   */
  private enclosing(room: RoomId): Set<RoomId> | null {
    const ways = this.waysInto();
    const cap = tuning().world.approachRooms;
    const inside = new Set<RoomId>([room]);
    let frontier: RoomId[] = [room];
    // Closed under un-gated entry, and so a pocket every remaining way into
    // which wants something. Null until the first closure has run.
    let settled: Set<RoomId> | null = null;

    while (frontier.length > 0) {
      const queue = [...frontier];
      const gated: RoomId[] = [];
      while (queue.length > 0) {
        const at = queue.pop() as RoomId;
        for (const way of ways.get(at) ?? []) {
          // An item that is itself a door comes from nowhere: there is no room
          // to take in, and the item is found again by `gatesWithin`.
          if (way.from === null || inside.has(way.from)) continue;
          if (way.item !== null) {
            gated.push(way.from);
            continue;
          }
          inside.add(way.from);
          if (inside.size > cap) return settled;
          queue.push(way.from);
        }
      }
      settled = new Set(inside);
      frontier = [];
      for (const at of gated) {
        if (inside.has(at)) continue;
        inside.add(at);
        if (inside.size > cap) return settled;
        frontier.push(at);
      }
    }
    return settled;
  }

  /**
   * Every item a way into or within the pocket demands, once each.
   *
   * Both kinds, because both have to be crossed: a door from outside is how
   * you get in and a door between two of its rooms is how you get on. Which
   * of them are actually *needed* is not decided here — that is what the
   * flood and the minimisation are for.
   */
  private gatesWithin(inside: ReadonlySet<RoomId>): number[] {
    const ways = this.waysInto();
    const items = new Set<number>();
    for (const at of inside) {
      for (const way of ways.get(at) ?? []) {
        if (way.item !== null) items.add(way.item);
      }
    }
    return [...items];
  }

  /**
   * Where a pack of these items can get to inside the pocket — the server's
   * own arithmetic, forwards.
   *
   * Seeded from every room outside the pocket that touches it (you are
   * standing in the open realm) and from the landing of every item in hand
   * that is itself a door. A `room` asks a yes/no question and short-circuits;
   * `null` asks how far it got, which is what the ordering compares.
   */
  private opensInto(
    room: RoomId | null,
    inside: ReadonlySet<RoomId>,
    held: ReadonlySet<number>
  ): ReadonlySet<RoomId> {
    const ways = this.waysInto();
    const reached = new Set<RoomId>();
    const queue: RoomId[] = [];
    const arrive = (at: RoomId): void => {
      if (reached.has(at)) return;
      reached.add(at);
      queue.push(at);
    };

    // Every door from outside, and every item that is a door of its own.
    for (const at of inside) {
      for (const way of ways.get(at) ?? []) {
        if (way.from !== null && inside.has(way.from)) continue;
        if (way.item !== null && !held.has(way.item)) continue;
        arrive(at);
      }
    }

    while (queue.length > 0) {
      const at = queue.pop() as RoomId;
      if (room !== null && at === room) return reached;
      for (const exit of this.rooms.get(at)?.exits ?? []) {
        const to = roomId(exit.map, exit.room);
        if (!inside.has(to)) continue;
        const item = itemDemanded(exit.requirement);
        if (item !== null && !held.has(item)) continue;
        arrive(to);
      }
      for (const command of this.rooms.get(at)?.commands ?? []) {
        if (command.to === undefined || !inside.has(command.to)) continue;
        const item = command.opens?.item;
        if (item !== undefined && !held.has(item)) continue;
        arrive(command.to);
      }
    }
    return reached;
  }

  /** One wanted item, with the same three answers a quest source carries. */
  private approachItem(id: number): ApproachItem {
    const known = this.items.get(id);
    const name = known?.name.trim();
    const { shops, mobs } = this.sourcesOf(name === undefined ? { id } : { id, name });
    const from = known === undefined ? [] : (this.placingHandovers(known).from ?? []);
    return {
      id,
      // The realm names every row an exit refers to; `#983` is this admitting
      // it did not, which is what the card refuses to make a control of.
      name: name === undefined || name.length === 0 ? `#${id}` : name,
      ...(shops.length > 0 ? { shops } : {}),
      ...(mobs.length > 0 ? { mobs } : {}),
      ...(from.length > 0 ? { from } : {})
    };
  }

  /**
   * Every way into every room, with the one item it demands where it does.
   *
   * Three columns of the realm state the same thing and all three are read:
   * an exit's `Key:` (a lock, which a skill may also open), the item a hidden
   * exit's own action wants (`RequirementAction.item`), and the item a room
   * script's lever wants (`RoomCommand.opens.item`). A portal command's
   * landing is an edge like any other and is walked with them.
   *
   * **And an item that is itself a door** — format 40. `WorldItem.lands` is
   * where *using* the thing puts you, and that is a way in from **nowhere**:
   * drinking the potion of levitation works wherever you are standing, and it
   * drops you into the Catacombs, which no corridor reaches at all. So the
   * edge carries a `null` source. Without it the Catacombs are a sealed pocket
   * and the client's answer to *how do I get to the necromancer* leaves out
   * the one thing that gets you anywhere near him.
   *
   * A `Key:` names a **wall** only for a character who cannot pick or force
   * it, which is a question about a character and not about a room — so this
   * reads the item and leaves the skill substitute to the router. What the
   * card says is what the way *wants*, never that there is no other way in.
   */
  private waysInto(): Map<RoomId, Array<{ from: RoomId | null; item: number | null }>> {
    if (this.waysIn !== null) return this.waysIn;
    const index = new Map<RoomId, Array<{ from: RoomId | null; item: number | null }>>();
    const add = (into: RoomId, from: RoomId | null, item: number | null): void => {
      const held = index.get(into);
      if (held === undefined) index.set(into, [{ from, item }]);
      else held.push({ from, item });
    };
    for (const [key, room] of this.rooms) {
      for (const exit of room.exits) {
        add(roomId(exit.map, exit.room), key, itemDemanded(exit.requirement));
      }
      for (const command of room.commands ?? []) {
        if (command.to === undefined) continue;
        add(command.to, key, command.opens?.item ?? null);
      }
    }
    for (const item of new Set(this.items.values())) {
      if (item.lands === undefined || !this.rooms.has(item.lands)) continue;
      add(item.lands, null, item.id);
    }
    this.waysIn = index;
    return index;
  }

  /**
   * Which shops are known to stock an item of this id.
   *
   * Built once beside `droppers`, out of the stock lists the shop index already
   * carries. By **id**, not by name: a shop stocks rows, and the realm's own
   * data repeats item names across rows.
   */
  private stockedBy(item: number): readonly string[] {
    if (this.stockists === null) {
      const index = new Map<number, string[]>();
      for (const shop of this.shops.values()) {
        const name = shop.name.trim();
        if (name.length === 0) continue;
        for (const line of shop.items) {
          const held = index.get(line.id);
          if (held === undefined) index.set(line.id, [name]);
          else if (!held.includes(name)) held.push(name);
        }
      }
      this.stockists = index;
    }
    return this.stockists.get(item) ?? [];
  }

  /**
   * Which monsters are known to drop an item of this name.
   *
   * Built once, on the first quest asked for, out of the drop lists the monster
   * index already carries — 538 of the realm's monsters name something. Keyed
   * the way every other name lookup here is keyed, so `Goru-Nezar` and
   * `goru-nezar` are one monster.
   */
  private dropsOf(item: string): readonly string[] {
    if (this.droppers === null) {
      const index = new Map<string, string[]>();
      for (const mob of new Set(this.mobs.values())) {
        for (const drop of mob.drops ?? []) {
          const key = mobKey(drop);
          const held = index.get(key);
          if (held === undefined) index.set(key, [mob.name]);
          else if (!held.includes(mob.name)) held.push(mob.name);
        }
      }
      this.droppers = index;
    }
    return this.droppers.get(mobKey(item)) ?? [];
  }

  /** The class index out of the header. Present from v10 on. */
  private loadClasses(raw: unknown): void {
    const classes: WorldClass[] = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = Number(record['id']);
      const name = String(record['n'] ?? '').trim();
      if (!Number.isInteger(id) || name.length === 0) continue;
      const entryOut: WorldClass = { id, name };
      for (const key of ['magery', 'combat'] as const) {
        const value = Number(record[key]);
        if (Number.isFinite(value) && value > 0) entryOut[key] = value;
      }
      // Negative is a real price here; see `loadRaces`.
      const exp = Number(record['expTable']);
      if (Number.isFinite(exp) && exp !== 0) entryOut.expTable = exp;
      // What the class grants — format 14.
      const abilities = readAbilities(record);
      if (abilities.length > 0) entryOut.abilities = abilities;
      classes.push(entryOut);
    }
    this.classes = classes;
  }

  /**
   * Reads what the spells on a `cast` or `spell` exit do to whoever walks it,
   * and writes the answer onto the requirement.
   *
   * Both exit kinds let everybody through — `CastExit.CanMoveThroughExit` and
   * `SpellTrapExit.CanMoveThroughExit` each return `true` unconditionally — so
   * the instruction string says nothing about whether the character arrives.
   * The realm's own spell table does, in two ways worth telling apart:
   *
   * - A spell carrying `TeleportRoom`/`TeleportMap` puts the character in a
   *   room the exit table does not name, and it is not even a fixed one: the
   *   server rolls `Rand(min, max)` over the spell's own `MinBase`–`MaxBase`
   *   and teleports there (`Spell.RollAndApplySpellAbilities`, then case
   *   `TeleportRoom`). Measured on the shipped realm: 217 of the 293 cast
   *   exits fire one, and of the 157 whose spell is `gloomy teleport`,
   *   `hallway teleport` or `thievry teleport`, **not one** states a
   *   destination inside its own spell's range. The exit's destination is not
   *   where the character ends up.
   * - A spell carrying `TextBlock` hands the character a realm script this
   *   client does not convert, so what it does is genuinely unread — and so is
   *   a spell the realm's table does not hold at all, which used to fall
   *   through to *harmless*.
   * - `EndCast` names another spell to fire when this one ends, so the chain is
   *   followed rather than ignored: `holding breath` says nothing itself and
   *   ends in `drowning`, and `timer` ends in a script.
   *
   * Everything else is an effect on the character rather than on where it is
   * standing, and for a spell trap the size of that effect is the price: the
   * hurt is taken from the spell's own power the way `menace.ts` takes it — the
   * ability's figure where it states one, the mean of the power range where it
   * states zero — without menace's duration and resistance arithmetic, which
   * needs the character and belongs at the decision rather than in the graph.
   */
  private resolveSpells(requirement: Requirement, onMap: number): void {
    if (requirement.kind !== 'cast' && requirement.kind !== 'spell') return;
    const named = [requirement.castPre, requirement.castPost, requirement.spellId].filter(
      (id): id is number => id !== undefined
    );
    if (named.length === 0) {
      // `Cast: pre-0, post-0` names no spell at all, and the server builds a
      // plain exit for it. Left unmarked, which the price reads as plain.
      return;
    }

    /*
     * The chain, not the spell. `EndCast` hands the character *another* spell
     * when this one ends, and `holding breath` (512) is `EndCast 513` —
     * `drowning`. Following it is a reading of the realm's own table, the same
     * reading as looking the exit's own spell up; not following it left three
     * exits priced as plain corridors because the row in front of them said
     * nothing on its own.
     */
    const pending = [...named];
    const seen = new Set<number>();
    let effect: 'script' | 'plain' = 'plain';
    let harm = 0;
    /*
     * Where the chain puts the character, and whether it says so twice over.
     * Two different landings are two answers to one question and there is no
     * honest way to choose between them, so an ambiguous chain is *unread* —
     * which is what the flag this replaced could never express.
     */
    let landing: Landing | null = null;
    let ambiguous = false;
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const spell = this.spellById(id);
      /*
       * **A spell the realm's table does not hold is unread, not harmless.**
       * This defaulted to `plain` — cost nothing — so a realm converted before
       * the spell index existed would have dropped all 293 cast exits from
       * discouraged to free in silence. Unknown is never the reassuring
       * answer, and here the reassuring answer is *walk through it*.
       */
      if (!spell) {
        if (effect === 'plain') effect = 'script';
        continue;
      }
      const [low, high] = spell.power ?? [0, 0];
      const mean = Math.abs(low + high) / 2;
      for (const [ability, value] of spell.abilities ?? []) {
        /*
         * The map half of a teleport says nothing on its own — `landingOf`
         * reads it off the same row when it needs it.
         */
        if (ability === HAZARD_ABILITY.teleportMap) continue;
        if (ability === HAZARD_ABILITY.teleportRoom) {
          /*
           * **Where it puts you, not merely that it does.** This read the pair
           * as one flag and threw the address away, so 49 exits that land in
           * exactly one known room were priced as walls to a room the
           * character never sees, and the 168 that draw one were walked as
           * though the exit table's room were the answer. `landingOf` is
           * `Spell.cs`'s own arithmetic; `null` is a row this reader cannot
           * turn into a room, which is unread and not harmless.
           */
          const where = landingOf(spell, value, onMap);
          if (where === null) {
            if (effect === 'plain') effect = 'script';
            continue;
          }
          if (landing !== null && !sameLanding(landing, where)) ambiguous = true;
          landing = where;
          continue;
        }
        if (ability === HAZARD_ABILITY.textBlock) {
          if (effect === 'plain') effect = 'script';
          continue;
        }
        if (ability === HAZARD_ABILITY.endCast) {
          if (value > 0) pending.push(value);
          continue;
        }
        /*
         * Every other ability that names a *row* rather than a magnitude:
         * `KillSpell`, `Summon`, `%Spell`, `RemovesSpell` and their kin. The
         * teleport pair and `EndCast` are the two this reader looks up, and
         * they are handled above; the rest are numbers it holds and has not
         * looked up, which is the honest definition of unread.
         *
         * It costs one exit on the shipped realm — `pyramid 1 exit temp` ends
         * in `pyramid 1 exit`, whose whole content is `KillSpell 685`, and
         * whether killing a timer fires the teleport that timer was going to
         * fire is not something this client can read. Sixty rooms of
         * discouragement is the cheap side of that question.
         */
        if (abilityShape(ability, 'spell') === 'reference') {
          if (effect === 'plain') effect = 'script';
          continue;
        }
        // A negative heal is a wound by another name — `menace.hazardOf` reads
        // it the same way, and `damnation` is the spell that taught it.
        const hurts = HURTS.has(ability) || (ability === HAZARD_ABILITY.heal && value < 0);
        if (!hurts) continue;
        // `abil.Sum == 0 ? rolledPower : abil.Sum`, the server's own choice of
        // which figure to use.
        const magnitude = value !== 0 ? Math.abs(value) : mean;
        if (magnitude > harm) harm = magnitude;
      }
    }
    /*
     * A landing outranks everything else the chain said — a spell that both
     * hurts and moves you is priced by the move, because where the character
     * is standing decides what every later step means. An ambiguous pair is
     * the one case that falls back, and it falls back to *unread*.
     */
    if (landing !== null && !ambiguous) {
      requirement.spellEffect = scatters(landing) ? 'scatters' : 'teleports';
      requirement.landing = landing;
    } else {
      requirement.spellEffect = landing === null ? effect : 'script';
    }
    if (harm > 0) requirement.damage = Math.round(harm);
  }

  private toRoom(raw: Record<string, unknown>): WorldRoom | null {
    const map = raw['m'];
    const room = raw['r'];
    if (typeof map !== 'number' || typeof room !== 'number') return null;

    const exits: WorldExit[] = [];
    const rawExits = (raw['x'] ?? {}) as Record<string, BuiltExit>;
    for (const direction of DIRECTIONS) {
      const exit = rawExits[direction];
      if (!exit) continue;
      const requirement = parseInstruction(exit.i);
      /*
       * The levers the build joined onto this exit — format 23. On the
       * requirement rather than beside it, because everything that acts on an
       * exit's condition already reads the requirement: `edgePenalty` prices
       * it, `describeObstacle` names it and `Walker` sends it, and none of the
       * three is handed the room.
       */
      const levers = readActions(exit.a);
      if (requirement !== null && levers.length > 0) requirement.actions = levers;
      // What the realm's spell table says a cast or trap exit does, joined here
      // for the reason the levers are joined in the build: once, where the
      // table is, and never in the A*.
      if (requirement !== null) this.resolveSpells(requirement, exit.m);
      exits.push({ direction, map: exit.m, room: exit.r, requirement });
    }

    const result: WorldRoom = {
      map,
      room,
      name: String(raw['n'] ?? ''),
      exits
    };
    if (typeof raw['s'] === 'number') result.shop = raw['s'];
    // Written since the file began and read by nothing until format 18.
    if (typeof raw['npc'] === 'number' && raw['npc'] > 0) result.npcId = raw['npc'];
    /*
     * A descriptor that names no monster at all is not a lair. GreaterMUD
     * writes a single space into `Rooms.Lair` for every ordinary room — all
     * 55,806 of them — and the converter's emptiness test is `!== ''`, which a
     * space passes. The map's glyph is `room.lair !== undefined`, so on that
     * realm every room in the world was drawn as a lair and `lair()` answered
     * *a lair of nothing* for each. Refused here rather than in the converter
     * so a realm a player has already converted is fixed too: `REALM_FORMAT` is
     * in the cache key and this changes no column.
     *
     * A descriptor naming ids this table lacks is a different answer and is
     * kept — that is a derivative adding monsters, which the lair face reports.
     */
    if (typeof raw['lair'] === 'string' && parseLair(raw['lair']).ids.length > 0) {
      result.lair = raw['lair'];
    }
    if (typeof raw['li'] === 'number') result.light = raw['li'];
    // The lair's respawn clock as the realm states it — format 33.
    if (typeof raw['dl'] === 'number' && raw['dl'] !== 0) result.delay = raw['dl'];
    if (typeof raw['sp'] === 'number' && raw['sp'] > 0) result.spell = raw['sp'];
    // What the realm puts on the floor — format 42. Before it the column was
    // the raw string under another key, which nothing read and this does not.
    const placed = Array.isArray(raw['pl'])
      ? raw['pl'].filter((id): id is number => Number.isInteger(id) && (id as number) > 0)
      : [];
    if (placed.length > 0) result.placed = placed;
    /*
     * The words the room answers — format 13. A malformed entry is dropped
     * rather than repaired: this file is written by this client, so a shape
     * that is not a `RoomCommand` is a bug here and not a derivative differing.
     */
    const answers = Array.isArray(raw['cmd'])
      ? raw['cmd'].filter(
          (entry): entry is RoomCommand =>
            typeof entry === 'object' &&
            entry !== null &&
            Array.isArray((entry as RoomCommand).say) &&
            (entry as RoomCommand).say.length > 0
        )
      : [];
    if (answers.length > 0) result.commands = answers;
    return result;
  }

  private add(room: WorldRoom): void {
    this.rooms.set(roomId(room.map, room.room), room);
    /*
     * Trimmed on the way *in* as well as on the way out.
     *
     * `findByName` has always trimmed its query, and the index had not — so a
     * realm record whose name carried trailing padding was indexed under a key
     * no lookup could ever produce, and the room was unfindable by name. Access
     * stores fixed-width text padded, and sixteen rooms in the shipped realm
     * arrived that way; a realm file a player chooses can carry any amount of
     * it. The reader strips the padding now, and this makes it not matter.
     */
    const key = room.name.trim().toLowerCase();
    const bucket = this.byName.get(key);
    if (bucket) bucket.push(room);
    else this.byName.set(key, [room]);
    const id = roomId(room.map, room.room);
    for (const item of room.placed ?? []) {
      const rooms = this.placedIn.get(item);
      if (rooms === undefined) this.placedIn.set(item, [id]);
      else if (!rooms.includes(id)) rooms.push(id);
    }
  }

  get(map: number, room: number): WorldRoom | undefined {
    return this.rooms.get(roomId(map, room));
  }

  /**
   * The scripted teleports a room offers, as the router walks them.
   *
   * For the map's off-plane marks: a portal is not in `WorldRoom.exits` —
   * it comes from the room's script, not the exit table — so a picture that
   * wants to offer *go vortex* as a way out has to ask for it here. Empty
   * for the ordinary room.
   */
  portalsFrom(id: RoomId): readonly PortalExit[] {
    return this.portals.get(id) ?? [];
  }

  byId(id: RoomId): WorldRoom | undefined {
    return this.rooms.get(id);
  }

  /**
   * How many of a draw's rooms the realm holds — what the chip says *one of*.
   *
   * The range as stated is not the count: `landingRooms` cannot filter,
   * because `src/shared` holds no realm. This is the one place that join is
   * made for a sentence, and it is the same join `scatterDoors` makes for the
   * arithmetic.
   */
  landingCount(landing: Landing): number {
    return landingRooms(landing).filter((id) => this.rooms.has(id)).length;
  }

  /**
   * The room an edge actually reaches, which is not always the one it names.
   *
   * An exit whose cast teleports puts the character in the spell's room and
   * never in the exit table's: `TryMoveThroughExit` moves them into the room
   * the table names and the cast moves them straight out again, so the table's
   * room is a place they are in for no time at all and cannot act in. 49 exits
   * in each shipped realm — every wrong square of the Marble Rooms, all of
   * which land in the Grand Hallway (17/2982).
   *
   * **Public because every reader that follows an edge has to come through
   * here**, and the first cut of this was private and several did not: the map
   * drew `17/3082 e` to a Marble Room while the plan walked it to the Grand
   * Hallway, the rest-next-door peek stepped through one expecting to step
   * back, and `CharacterTracker.notice` wrote a permanent *discovery* of a way
   * the realm describes in full, because each tested the table's room.
   *
   * A scatter has no answer to give and keeps the table's room — nothing may
   * walk one, `scatterCosts` reasons about it instead, and a caller that would
   * *follow* an edge must skip one outright rather than believe this.
   */
  beyond(exit: WorldExit | PortalExit): RoomId {
    const landing = exit.requirement?.landing;
    if (landing !== undefined && exit.requirement?.spellEffect === 'teleports') {
      const there = roomId(landing.map, landing.low);
      if (this.rooms.has(there)) return there;
    }
    return roomId(exit.map, exit.room);
  }

  /**
   * Every room, in the order the file listed them.
   *
   * A read-only sweep, beside `byId` and `findByName` because it answers the
   * one question neither can: *does anything in this realm still look like
   * that*. What reads it is the shipped-realm survey in the tests — the
   * assertions that say 293 exits carry a cast and 217 of them scatter you —
   * and those exist because every price in `edgePenalty` is a claim about a
   * file, and a file that changes underneath a claim should fail loudly rather
   * than quietly reroute somebody.
   */
  everyRoom(): IterableIterator<WorldRoom> {
    return this.rooms.values();
  }

  /** Every room with this exact name. Names repeat constantly — 14 "Newhaven…". */
  findByName(name: string): WorldRoom[] {
    return this.byName.get(name.trim().toLowerCase()) ?? [];
  }

  /** Substring search, for a room picker. Capped so a short query cannot hang. */
  searchByName(query: string, limit = 25): WorldRoom[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return [];

    const results: WorldRoom[] = [];
    for (const [name, bucket] of this.byName) {
      if (!name.includes(needle)) continue;
      for (const room of bucket) {
        results.push(room);
        if (results.length >= limit) return results;
      }
    }
    return results;
  }

  /**
   * A* from one room to another.
   *
   * The heuristic is deliberately weak: rooms carry no coordinates, only
   * `map/room` identifiers, so there is no geometry to exploit. Same-map is
   * nearer than cross-map and that is all that can honestly be claimed —
   * anything stronger would be a guess that breaks admissibility and returns
   * routes that are not shortest.
   */
  route(from: RoomId, to: RoomId, traveller: Traveller = {}, options: RouteOptions = {}): Route {
    const start = this.rooms.get(from);
    const goal = this.rooms.get(to);

    if (!start) {
      return {
        steps: [],
        cost: 0,
        blocked: true,
        reason: t('cards.route.reasons.unknownStartRoom', { roomId: from })
      };
    }
    if (!goal) {
      return {
        steps: [],
        cost: 0,
        blocked: true,
        reason: t('cards.route.reasons.unknownDestinationRoom', { roomId: to })
      };
    }
    if (from === to) return { steps: [], cost: 0, blocked: false };

    /*
     * **The way that always arrives first, and only then the one that gambles.**
     *
     * A draw is the last resort by construction — a maze is a maze because
     * walking out of it is not on offer — so asking for it up front would
     * spend the solve's backward sweeps on every route in the realm to
     * discover, almost every time, that there was a corridor all along. It is
     * asked for exactly when there is no corridor, which is the case the old
     * man's cell is: the Warped Asylum has one entrance and stepping through
     * it hands you to the dice.
     */
    const walkable = this.search(from, to, goal, traveller, false, false);
    const draws = walkable.found === null && walkable.drawsAhead;
    const drawn = draws
      ? this.search(from, to, goal, traveller, false, true).found
      : walkable.found;
    /*
     * **And after the dice, the pack.**
     *
     * The same last-resort rule the draw above follows, for the same reason
     * and one rung further down: an item that teleports spends a charge, so it
     * is not something to take on the way to somewhere a corridor already
     * reaches. Asked only when nothing else arrives at all — which is exactly
     * the Catacombs, whose 173 rooms no exit in either database enters, and
     * which is why this is not gated on `RouteOptions.alternatives` the way
     * the shortcut below is. A way that does not otherwise exist is not an
     * alternative; it is the route.
     *
     * Costs nothing where the realm holds no such item, which is every realm
     * but these two and most pairs of rooms in both.
     */
    const landed =
      drawn === null && walkable.landingsAhead && this.landingsReach().has(to)
        ? this.search(from, to, goal, traveller, false, draws, true).found
        : null;
    const found = drawn ?? landed;
    if (found) {
      const route = this.buildRoute(found.cameFrom, to, found.cost, traveller, draws);
      /*
       * A route that crosses a wall — a door the character cannot force, a
       * deadly lair — is offered because refusing outright would hide the only
       * way there is, but it is not the way anybody would choose. So the gates
       * are opened as they are for a refusal, and what the way through them
       * needed is carried on the route: *the shorter way needs amber talisman*
       * is the sentence somebody stopped at a wall can act on, and it is the
       * one the refusal already knows how to say (todo 13). Nothing when the
       * opened way is no shorter, or needs nothing the route lacks.
       */
      /*
       * The way round the worst of it, and what the gates-open way would have
       * needed. **Both, never one instead of the other.** A route holding a
       * deadly lair is already at or above `wallCost`, so it takes the branch
       * below every time — and returning there skipped the search that makes
       * *and there is no other way* checkable, on precisely the routes that
       * say it.
       */
      // Both alternatives only for a route planned to be read: a loop's leg
      // and a walk home are walked, and neither reads a way round.
      const other =
        options.alternatives === true
          ? this.otherWay(from, to, goal, route, traveller, draws)
          : null;
      const equipped =
        options.alternatives === true
          ? this.carrying(from, to, goal, route, traveller, draws)
          : null;
      // And the way that spends a charge to skip the walk — offered, never
      // planned. See `Route.viaItem`.
      const invoked =
        options.alternatives === true
          ? this.viaItem(from, to, goal, route, traveller, draws)
          : null;
      // And a way that is simply not this one — asked for by name, over and
      // over, and defined by what it is not rather than by what it assumes.
      // See `Route.another`.
      const different =
        options.alternatives === true
          ? this.another(from, to, goal, route, traveller, draws)
          : null;
      const planned: Route = {
        ...route,
        ...(other === null ? {} : { otherWay: other }),
        ...(equipped === null ? {} : { carrying: equipped }),
        ...(invoked === null ? {} : { viaItem: invoked }),
        ...(different === null ? {} : { another: different })
      };
      if (found.cost >= tuning().world.wallCost) {
        /*
         * And what the plan *itself* crosses. A door below the character's
         * skills is priced as a wall and walked when nothing else leads
         * there, and until this was named the plan said nothing: eighty-six
         * steps to the Massive Doors, then the walker's *requires 81; this
         * character has 0 picklocks*. The gates-closed path holds nothing
         * pruned, so this names the graded walls and nothing else.
         */
        const walls = this.blocksAlong(found.cameFrom, to, traveller);
        const named: Route = walls.length > 0 ? { ...planned, walls } : planned;
        const opened = this.search(from, to, goal, traveller, true, draws).found;
        if (opened !== null && opened.cost < found.cost) {
          const blocks = this.blocksAlong(opened.cameFrom, to, traveller);
          if (blocks.length > 0) return { ...named, blocks };
        }
        return named;
      }
      return planned;
    }

    /*
     * Nothing walkable, so ask again with the gates open — and report the gates
     * on *that* path.
     *
     * Which pruned edges are worth naming was the open question here, and the
     * answer that is honest rather than merely cheap is: the ones standing on
     * the route this character would otherwise have had. Every pruned edge in a
     * 55,806-room realm is noise — most of them are nowhere near the
     * destination — and a list of forty locked doors says less than none.
     *
     * The second search costs nothing in the common case because it only runs
     * when the first has already failed, which is the case where there is
     * nothing else to spend the time on.
     */
    /*
     * **And the explanation looks through the pack too.** With the gates held
     * open an item landing is passable like any other gate, so `blocksAlong`
     * reports the item it wants — which turns *the realm data joins no path*,
     * about a cave the realm does have a way into, back into *needs potion of
     * levitation*. That first sentence is what this whole change began as a
     * report of, and leaving it on the refusal would have fixed the route and
     * kept the lie for anybody who had not fetched the potion yet.
     */
    /*
     * **The walk is explained first, and the item beside it.** One search
     * with the gates open and the pack enabled explained the cheapest opened
     * way, which for a character standing where a token lands is the token:
     * a level-21 character on the Sandbar was told only that the token of
     * Silvermere needs level 25, and not that the walk out wants a rope and
     * grapple — the half a person can act on (2026-09-21). So the walk's
     * blocks are named, and the item's are added where an item lands
     * somewhere the walk could not reach; a refusal keeps its candidates.
     */
    const ignoring = this.search(from, to, goal, traveller, true, walkable.drawsAhead, false).found;
    const blocks = ignoring ? this.blocksAlong(ignoring.cameFrom, to, traveller) : [];
    const invoked =
      walkable.landingsAhead && this.landingsReach().has(to)
        ? this.search(from, to, goal, traveller, true, walkable.drawsAhead, true).found
        : null;
    const seen = new Set(blocks.map((block) => blockKey(block)));
    const spent =
      invoked === null
        ? []
        : this.blocksAlong(invoked.cameFrom, to, traveller).filter(
            (block) => !seen.has(blockKey(block))
          );
    const named = [...blocks, ...spent];
    const reasons = named.length > 0 ? named : ([{ kind: 'unreachable' }] as RouteBlock[]);
    return {
      steps: [],
      cost: 0,
      blocked: true,
      // Still a sentence, because everything that already reads `reason` goes
      // on working; the facts are beside it for anything that wants more.
      reason: reasons.map(describeBlock).join('; '),
      blocks: reasons
    };
  }

  /**
   * A way round the worst rooms on a route, where there is one.
   *
   * **The sentence this exists for is *and there is no other way*.** The
   * router walls a deadly lair rather than pruning it, so such a room is an
   * expensive option the cheapest route happened to include — and saying
   * there is no other way was asserting an absolute from a relative result.
   * A reader deciding whether to walk into something expected to kill them
   * deserves the client to have actually looked.
   *
   * What counts as *the worst* is deliberately narrow: a room expected to kill
   * (`deadly`), a room whose own spell takes a real share of the bar
   * (`otherWayShare`), and a door this character cannot force or a corridor
   * the server refused this session — priced as walls and walked only when
   * nothing else leads there, which is when the reader most wants the way
   * round. A toll or a plain door is not: those are conditions the reader
   * clears by walking. The rooms are avoided as rooms; a door is avoided as
   * the one *edge* it stands on (`Traveller.avoidEdges`), because the room
   * behind it is where the way round has to arrive.
   *
   * Offered only when it genuinely differs: a way that walks the same worst
   * rooms is the same way with a different corner turned, which is what the
   * player asked not to be shown — *n, n, e from the bank instead of e, n, n*.
   * The cost is one extra A* per route that has something bad on it, and none
   * at all for the ordinary route across town.
   */
  private otherWay(
    from: RoomId,
    to: RoomId,
    goal: WorldRoom,
    route: Route,
    traveller: Traveller,
    draws: boolean
  ): Route | null {
    const { otherWayShare } = tuning().world;
    const worst = new Set<RoomId>();
    const walls = new Set<string>();
    for (const step of route.steps) {
      if (step.deadly === true || (step.hazard ?? 0) >= otherWayShare) worst.add(step.to);
      const edge = `${step.from}|${step.direction}`;
      // A door the realm names a word for is not something to search round:
      // `stepCost` prices it as the lever it is, so this has to read it the
      // same way or the two disagree about what the plan crosses.
      const walled =
        edgeWall(step.requirement, traveller) !== null &&
        this.leverPrice(step.from, step.direction, traveller) === null;
      if (walled || traveller.refused?.has(edge) === true) {
        walls.add(edge);
      }
    }
    // The destination itself is never avoidable: a route that refused to enter
    // the room it is planned to is not a route.
    worst.delete(to);
    if (worst.size === 0 && walls.size === 0) return null;

    /*
     * **With the gates open**, like the search that explains a refusal. A way
     * round a room expected to kill is very often a door this character cannot
     * open — and pruning that door means finding nothing and saying *there is
     * no other way* about a route that exists and merely wants a key. What is
     * impassable is priced rather than removed, and named below.
     */
    const round = this.search(
      from,
      to,
      goal,
      { ...traveller, avoid: worst, avoidEdges: walls },
      true,
      draws
    ).found;
    if (round === null) return null;
    const other = this.buildRoute(round.cameFrom, to, round.cost, traveller, draws);
    /*
     * **A way round is expected to be dearer, so cost is not the test.** That
     * is why it was not chosen, and offering it asks the reader to make the
     * trade the router already made silently. One thing is the test: it must
     * not be deadly itself, because a way round a room expected to kill you
     * that walks into another one has answered the question with the same
     * word.
     *
     * Cost was the test, briefly, and it made the whole search pointless for
     * the case it exists for: pruning can only remove options, so a way round
     * always costs **at least** what the plan costs — and a plan holding a
     * deadly room costs `wallCost`, so every alternative was refused on the
     * one route whose panel says *and there is no other way*.
     *
     * A route that crosses a wall carries what it needs, exactly as the plan
     * does: trading a certain death for a door somebody can go and find the
     * key to is the choice worth putting in front of them, and it is only a
     * choice if the door is named.
     */
    if (other.steps.some((step) => step.deadly === true)) return null;
    const walled = this.blocksAlong(round.cameFrom, to, traveller);
    /*
     * Handed back with no `otherWay` of its own: an alternative is read and
     * chosen, never used to plan a third. `buildRoute` sets none, so this is a
     * statement about what is *not* done rather than something to strip.
     * What it crosses is its own (`walls`), not what a cheaper way needed.
     */
    return walled.length > 0 ? { ...other, walls: walled } : other;
  }

  /**
   * The way this character would take if it carried what stops the rooms on
   * it — the second alternative, and the one the reader asked for by name.
   *
   * *I know there is another way, through the Silvermere River, but it needs
   * a log raft* (todo 01). The plan through the slums is 107 steps because
   * the router priced eighty rooms of river against an empty pack; the way
   * down the river is 88 with a raft. `otherWay` cannot find that route — it
   * avoids rooms the plan priced badly, and the plan avoids the river already
   * — so this asks the opposite question: with every item-stopped hazard
   * switched off, where would the search go?
   *
   * Offered only when it is **materially** shorter, by `alternativeMinSteps`
   * (a way two steps shorter is the same way with a corner cut, which the
   * reader asked not to be shown), and only when it actually crosses a room
   * an item would quieten — a route shorter for any other reason would have
   * been the plan. Built on the *equipped* traveller so its steps are priced
   * as the premise says, while `hazards.needs` still names what the pack
   * lacks; never deadly, by `otherWay`'s rule and for its reason. One more
   * A* per route, and only when asked for (`RouteOptions.alternatives`): a
   * loop's leg is walked, not read.
   */
  /**
   * The way that uses an item to teleport, where it is materially shorter.
   *
   * **Off by default, which is the whole of what separates the two kinds of
   * landing the shipped realms hold.** The potion of levitation is the only
   * entrance the Catacombs have, so `route` walks it above as the last resort
   * it is. Paradigm's seven tokens land on rooms — the Pier, Harbor Square,
   * Rhudaur's doors — that the character could perfectly well walk to, so
   * taking one is a *choice* that costs one of five charges, and a router that
   * spent one unasked would quietly burn a player's recalls to save a stroll.
   * So it is offered beside the plan with what it spends named on the step,
   * and the reader decides.
   *
   * Null where the plan already uses one: that is the route, not an
   * alternative to it. And null unless the way found actually invokes
   * something, because a landings-enabled search that took no landing has
   * simply re-found the plan.
   */
  private viaItem(
    from: RoomId,
    to: RoomId,
    goal: WorldRoom,
    route: Route,
    traveller: Traveller,
    draws: boolean
  ): Route | null {
    if (this.itemLandings().length === 0) return null;
    if (route.steps.some((step) => step.invoke !== undefined)) return null;
    /*
     * A landing route is at least one step, so the most this could ever save
     * is one short of the plan's own length — and below `alternativeMinSteps`
     * that is refused at the bottom of this function anyway. Checked *before*
     * the search rather than after it, because the panel asks for alternatives
     * on every route it draws and most routes are short: without this, every
     * one of them paid a full extra A* to be told what its step count already
     * settled.
     */
    if (route.steps.length - 1 < tuning().world.alternativeMinSteps) return null;
    const found = this.search(from, to, goal, traveller, false, draws, true).found;
    if (found === null) return null;
    const other = this.buildRoute(found.cameFrom, to, found.cost, traveller, draws);
    if (!other.steps.some((step) => step.invoke !== undefined)) return null;
    if (route.steps.length - other.steps.length < tuning().world.alternativeMinSteps) return null;
    // By `carrying`'s own rule: a shorter way through a room that is expected
    // to kill the character is not an offer.
    return other.steps.some((step) => step.deadly === true) ? null : other;
  }

  private carrying(
    from: RoomId,
    to: RoomId,
    goal: WorldRoom,
    route: Route,
    traveller: Traveller,
    draws: boolean
  ): Route | null {
    const priced = traveller.hazard;
    if (priced === undefined) return null;
    const quietened = (room: WorldRoom): boolean => {
      const hazard = this.hazardOf(room, traveller.level);
      return (
        hazard !== null &&
        (hazard.avoidedBy?.length ?? 0) > 0 &&
        !hazardAvoided(hazard, traveller.keys, traveller.spellsUp)
      );
    };
    const equipped: Traveller = {
      ...traveller,
      hazard: (room) => (quietened(room) ? null : priced(room))
    };
    const found = this.search(from, to, goal, equipped, false, draws).found;
    if (found === null) return null;
    const other = this.buildRoute(found.cameFrom, to, found.cost, equipped, draws);
    if (route.steps.length - other.steps.length < tuning().world.alternativeMinSteps) return null;
    if (other.steps.some((step) => step.deadly === true)) return null;
    const crosses = other.steps.some((step) => {
      const room = this.rooms.get(step.to);
      return room !== undefined && quietened(room);
    });
    return crosses ? other : null;
  }

  /**
   * A way that is materially different from the plan — `Route.another`.
   *
   * The plan's own edges are priced `anotherWayPenalty` times over
   * (`Traveller.penalised`, read in `stepCost`) and the search asked again:
   * a soft penalty rather than a pruning, because pruning would refuse every
   * way that shares one bridge with the plan, and a penalty lets the search
   * reuse the plan exactly where leaving it costs more than it saves. What
   * comes back is priced again without the penalty, so its `cost` is what
   * walking it would cost and not what the search paid to find it.
   *
   * Offered when at least `alternativeMinSteps` of its rooms are not on the
   * plan — a corner cut is the plan again — and it is no more than
   * `anotherWayLonger` longer, because a way that differs is expected to be
   * dearer (that is why it was not the plan) and past some point it is a tour
   * rather than a choice. Never walled or deadly, and never for a plan that
   * is, which `otherWay` asks round already; never through a draw, whose
   * steps are priced by a solve this repricing does not repeat; never for a
   * plan that spends an item, which is the last resort and has no variations.
   * One more A* per route planned for a reader, and none for a short one.
   */
  private another(
    from: RoomId,
    to: RoomId,
    goal: WorldRoom,
    route: Route,
    traveller: Traveller,
    draws: boolean
  ): Route | null {
    const { alternativeMinSteps, anotherWayLonger, wallCost } = tuning().world;
    if (draws) return null;
    if (route.steps.length < alternativeMinSteps) return null;
    if (route.cost >= wallCost) return null;
    if (route.steps.some((step) => step.deadly === true || step.invoke !== undefined)) return null;
    const penalised = new Set(route.steps.map((step) => `${step.from}|${step.to}`));
    const found = this.search(from, to, goal, { ...traveller, penalised }, false, false).found;
    if (found === null) return null;
    const cost = this.costAlong(found.cameFrom, to, traveller);
    if (cost >= wallCost) return null;
    const other = this.buildRoute(found.cameFrom, to, cost, traveller, false);
    const onPlan = new Set(route.steps.map((step) => step.to));
    const fresh = other.steps.filter((step) => !onPlan.has(step.to)).length;
    if (fresh < alternativeMinSteps) return null;
    if (other.steps.length > route.steps.length * (1 + anotherWayLonger)) return null;
    return other.steps.some((step) => step.deadly === true) ? null : other;
  }

  /**
   * What a found path costs this traveller, priced plainly — the honest
   * figure for a search that ran under a penalty (`another`).
   */
  private costAlong(
    cameFrom: Map<RoomId, { prev: RoomId; exit: WorldExit | PortalExit }>,
    to: RoomId,
    traveller: Traveller
  ): number {
    const discount = this.discountFor(traveller);
    let cost = 0;
    let cursor = to;
    while (cameFrom.has(cursor)) {
      const { prev, exit } = cameFrom.get(cursor)!;
      const into = this.rooms.get(cursor) ?? null;
      const invoked = this.spends.has(exit as PortalExit);
      cost += this.stepCost(prev, exit, into, traveller, false, discount, invoked) ?? 0;
      cursor = prev;
    }
    return cost;
  }

  /**
   * Every scatter door in the realm, by the spell that draws — built once.
   *
   * Structure only, so it survives every traveller: which rooms hold a door,
   * and what each door draws from. What a door *costs* is asked at the sweep,
   * because that is the half a character changes.
   */
  private scatterDoors(): ReadonlyMap<number, ScatterSpell> {
    if (this.draws !== null) return this.draws;
    const found = new Map<number, ScatterSpell>();
    for (const [at, room] of this.rooms) {
      for (const exit of room.exits) {
        const landing = exit.requirement?.landing;
        if (landing === undefined || exit.requirement?.spellEffect !== 'scatters') continue;
        let spell = found.get(landing.spell);
        /*
         * One spell, one draw. `landingOf` takes the map from the exit where
         * the spell states no `TeleportMap`, so one spell fired from two maps
         * would fold two different room sets under one id — and the mean would
         * then be taken over one map's rooms while the chip named the other's.
         * No spell in either shipped realm does it (`WorldGraph.test.ts` walks
         * the survey); a realm that did would have the spell dropped rather
         * than priced against the wrong rooms.
         */
        if (spell !== undefined && !sameLanding(spell.landing, landing)) {
          found.delete(landing.spell);
          continue;
        }
        if (spell === undefined) {
          /*
           * The rooms the roll can produce that the realm actually holds. A
           * range is `MinBase`–`MaxBase` and nothing promises every number in
           * it is a room — the mean has to be over the outcomes that exist, or
           * a range with a hole in it is priced as though a draw could land
           * the character nowhere.
           */
          const rooms = landingRooms(landing).filter((id) => this.rooms.has(id));
          if (rooms.length === 0) continue;
          found.set(landing.spell, (spell = { landing, rooms, doors: [] }));
        }
        spell.doors.push({ at, exit });
      }
    }
    this.draws = found;
    return found;
  }

  /**
   * Rooms that lead to each room by a move that always arrives — built once.
   *
   * The scatter solve asks *what does it cost from here to the goal*, and
   * that is a question about edges pointing the other way. Built lazily and
   * kept: it is a pure function of the file, and a session that never routes
   * through a draw never pays for it. A draw is left out, because it leads to
   * no particular room and that is the whole of what makes it one.
   */
  private reverse(): ReadonlyMap<RoomId, ReadonlyArray<ReverseEdge>> {
    if (this.backward !== null) return this.backward;
    const into = new Map<RoomId, ReverseEdge[]>();
    const add = (to: RoomId, edge: ReverseEdge): void => {
      if (!this.rooms.has(to)) return;
      const bucket = into.get(to);
      if (bucket === undefined) into.set(to, [edge]);
      else bucket.push(edge);
    };
    for (const [from, room] of this.rooms) {
      for (const exit of room.exits) {
        if (exit.requirement?.spellEffect === 'scatters') continue;
        add(this.beyond(exit), { from, exit });
      }
      for (const portal of this.portalsFrom(from)) add(this.beyond(portal), { from, exit: portal });
    }
    this.backward = into;
    return into;
  }

  /**
   * What it costs to reach each of `wanted` from one room, and in how many
   * moves — `sweepBack` walked forwards, for the errand solver (todo 01).
   *
   * Dijkstra rather than the A* beside it, because the question has many
   * destinations and one origin: the errand wants a whole row of the distance
   * table and a heuristic aimed at one goal cannot settle the others on the
   * way. It stops the moment every room asked about is settled, which is what
   * keeps it to roughly the price of one route to the furthest of them.
   *
   * **Two figures per room, and they are not the same figure.** The cost is
   * the router's own — the lair, the room's spell, the door graded against
   * this character — and is what the order is chosen by; the moves are how
   * many times a player presses a direction along that same cheapest way, and
   * are what the card prints. `scatterMoves` draws exactly this distinction
   * for exactly this reason.
   *
   * **A wall is walked here, unlike in `sweepBack`**, and the difference is
   * what the figure is for. That sweep feeds an expectation of moves, and a
   * hundred thousand inside that arithmetic is not a number of moves. This
   * feeds a plan — the same plan `route` makes, which walks a door it cannot
   * force when there is no other way and says so on the panel. Excluding them
   * was tried first and took four of Paradigm's eleven multi-item steps'
   * orders away with it, PhoenixQuest's own included: the quartz is behind the
   * keep's three doors and the cave roots behind the iron door, both of them
   * *routable* and both reported as no way there. So a wall is priced, which
   * orders a walk crossing two of them behind one crossing none, and what the
   * way itself wants is already drawn under the item (`QuestStep.approach`).
   */
  private sweepTo(
    from: RoomId,
    wanted: ReadonlySet<RoomId>,
    traveller: Traveller
  ): Map<RoomId, { cost: number; moves: number }> {
    const found = new Map<RoomId, { cost: number; moves: number }>();
    const best = new Map<RoomId, number>([[from, 0]]);
    const moves = new Map<RoomId, number>([[from, 0]]);
    const settled = new Set<RoomId>();
    const outstanding = new Set(wanted);
    const open = new MinHeap<RoomId>();
    open.push(0, from);
    const ceiling = tuning().world.errandSweepRooms;
    const discount = this.discountFor(traveller);

    while (open.size > 0 && outstanding.size > 0 && settled.size < ceiling) {
      const id = open.pop()!;
      if (settled.has(id)) continue;
      settled.add(id);
      if (outstanding.delete(id)) found.set(id, { cost: best.get(id)!, moves: moves.get(id)! });
      const here = this.rooms.get(id);
      if (here === undefined) continue;
      const cost = best.get(id)!;
      const step = moves.get(id)!;
      for (const exit of [...here.exits, ...this.portalsFrom(id)]) {
        /*
         * A draw is not an edge — the character picks the door and the realm
         * picks the room — and an errand is a walk somebody follows with a
         * list in front of them. `scatterCosts` is the reader that reasons
         * about one; this is not it.
         */
        if (exit.requirement?.spellEffect === 'scatters') continue;
        const nextId = this.beyond(exit);
        const next = this.rooms.get(nextId);
        if (next === undefined || settled.has(nextId)) continue;
        const price = this.stepCost(id, exit, next, traveller, false, discount);
        if (price === null) continue;
        const tentative = cost + price;
        if (tentative >= (best.get(nextId) ?? Infinity)) continue;
        best.set(nextId, tentative);
        moves.set(nextId, step + 1);
        open.push(tentative, nextId);
      }
    }
    return found;
  }

  /**
   * What it costs each of `wanted` to reach any of `seeds`, walking backwards.
   *
   * Dijkstra over `reverse()`, stopped the moment every room asked about has
   * been settled — which is what keeps it cheap: the rooms asked about are a
   * scatter's landings, they sit inside the maze the scatter closes, and a
   * sweep seeded from the doors of that maze settles all of them in a few
   * rungs. A sweep that cannot settle one exhausts what it can reach and that
   * room is left out, which reads as *there is no way from there*, which is
   * what it is.
   *
   * Bounded by `tuning.world.scatterSweepRooms` as well, for a realm this
   * client has never seen: over the bound the answer is *not known* rather
   * than a figure, and a scatter nobody could price is one the router does not
   * offer. An over-estimate refuses an option; it never invents a way.
   */
  private sweepBack(
    seeds: ReadonlyMap<RoomId, number>,
    wanted: ReadonlySet<RoomId>,
    traveller: Traveller,
    /**
     * Whether a wall is a number to add or a way that is not there.
     *
     * The distinction `sweepTo` draws, in the other direction and for the same
     * reason: what the figure is *for* decides. A scatter's expectation is a
     * count of moves and `wallCost` inside it is not one, so that reader leaves
     * the room unpriced. A detour is a plan — the same plan `route` makes,
     * which walks a door it cannot force when there is no other way and says so
     * — so this reader prices it, and a counter whose way onward crosses one is
     * ranked behind the others rather than reported as nowhere.
     */
    priceWalls = false
  ): Map<RoomId, number> {
    const best = new Map<RoomId, number>(seeds);
    const open = new MinHeap<RoomId>();
    for (const [id, cost] of seeds) open.push(cost, id);
    const outstanding = new Set(wanted);
    for (const id of seeds.keys()) outstanding.delete(id);
    const ceiling = tuning().world.scatterSweepRooms;
    const settled = new Set<RoomId>();
    const reverse = this.reverse();
    const discount = this.discountFor(traveller);

    while (open.size > 0 && outstanding.size > 0 && settled.size < ceiling) {
      const id = open.pop()!;
      if (settled.has(id)) continue;
      settled.add(id);
      outstanding.delete(id);
      const here = this.rooms.get(id);
      if (here === undefined) continue;
      const cost = best.get(id)!;
      for (const { from, exit } of reverse.get(id) ?? []) {
        if (settled.has(from)) continue;
        const price = this.stepCost(from, exit, here, traveller, false, discount);
        /*
         * **A wall is not a number of moves.** The router walks one when
         * nothing else leads anywhere, and says so on the plan — but what this
         * sweep feeds is an expectation the reader sees as *about ten more
         * moves*, and `wallCost` inside that arithmetic made the gloomy maze
         * answer 201,050. The two figures are not in the same units. So the
         * solve declines to build a gamble on a door this character cannot
         * open or a room expected to kill it, and the scatter is left
         * unpriced — which the router then does not offer, so a destination
         * reachable *only* through such a maze is reported unreachable rather
         * than priced in the wrong units. Refusing an option, never inventing
         * one; and the refusal cannot name the gate, because the gate is
         * inside a maze no plan was ever going to hold the steps of.
         *
         * A corridor the server refused this session prices at `wallCost` too
         * and is excluded by the same test, which is the right answer for the
         * same reason: this session cannot walk it.
         */
        if (price === null || (!priceWalls && price >= tuning().world.wallCost)) continue;
        const tentative = cost + price;
        if (tentative >= (best.get(from) ?? Infinity)) continue;
        best.set(from, tentative);
        open.push(tentative, from);
      }
    }
    return best;
  }

  /**
   * What stepping through each scatter is expected to cost, all the way to `to`.
   *
   * **The one piece of arithmetic in this file that is not a shortest path**,
   * because a draw is not a choice: from a room with a scatter door the
   * character picks the door and the realm picks the room. So the quantity is
   * an expectation over an optimal policy, and it satisfies
   *
   * ```
   * V(l) = min( D(l), min over spells s of [ B(s, l) + E(s) ] )
   * E(s) = mean over l in landings(s) of V(l)
   * ```
   *
   * where `D(l)` is the cost from `l` to the goal taking no draw at all and
   * `B(s, l)` is the cost from `l` of reaching a door of `s` and stepping
   * through it. Both are shortest paths — one sweep from the goal and one per
   * spell from its doors — which leaves a fixed point over **as many unknowns
   * as the realm has scattering spells**: six in each shipped realm, five of
   * them the asylum's. Every path from a room either reaches the goal without
   * a draw or takes a first one, so the pair above is exact rather than an
   * estimate, and the mean is over the landings the realm holds.
   *
   * **Solved upward from zero, never downward from infinity.** A mean over a
   * set holding one unreachable landing is infinite, so the pessimistic
   * iteration never takes its first step and every scatter in the realm reads
   * as *no way*: it is a fixed point, just not the least one. From zero the
   * iterates rise to the true value, which is the standard reading for a
   * stochastic shortest path and the one a Monte-Carlo control agrees with
   * (`WorldGraph.test.ts`: 20,000 plays of the asylum, 10.007 moves against a
   * solved 10).
   *
   * Cached for the last goal and traveller because one `route` runs the search
   * twice with the same pair. Spells whose expectation did not converge to a
   * finite figure are left out, so a door nobody could price is a door the
   * router does not offer.
   */
  private scatterCosts(to: RoomId, traveller: Traveller): ReadonlyMap<number, number> {
    const spells = this.scatterDoors();
    if (spells.size === 0) return EMPTY_COSTS;
    if (this.solved !== null && this.solved.to === to && this.solved.traveller === traveller) {
      return this.solved.costs;
    }

    const landings = new Set<RoomId>();
    for (const spell of spells.values()) for (const id of spell.rooms) landings.add(id);

    // `D`: the goal, reached without ever taking a draw.
    const plain = this.sweepBack(new Map([[to, 0]]), landings, traveller);

    // `B`: the cheapest door of each spell, and what stepping through it costs.
    const reach = new Map<number, Map<RoomId, number>>();
    const discount = this.discountFor(traveller);
    for (const [id, spell] of spells) {
      const seeds = new Map<RoomId, number>();
      for (const { at, exit } of spell.doors) {
        const price = this.stepCost(at, exit, null, traveller, false, discount);
        if (price === null) continue;
        if (price < (seeds.get(at) ?? Infinity)) seeds.set(at, price);
      }
      if (seeds.size === 0) continue;
      reach.set(id, this.sweepBack(seeds, landings, traveller));
    }

    /*
     * **Can the goal happen at all from here, allowing draws.**
     *
     * The iteration below climbs from zero, so a scatter nothing can reach the
     * goal through does not settle at infinity — it rises by a step a round
     * for ever, and a round ceiling would then hand back a large number as
     * though it were an expectation. Measured: a route from the Great Library
     * to a marsh road on another map, which no way in the realm connects, came
     * back as a plan that walked into the Warped Asylum and waited.
     *
     * So the landings are first asked the much weaker question — is there any
     * sequence at all, plain moves and lucky draws together, that ends at the
     * goal. That is a least fixed point and it seeds itself on the landings a
     * plain walk already reaches, which is exactly the base case the value
     * iteration needs and the asylum has: one of the nine padded cells *is*
     * the old man's. A spell with a landing that cannot is left unpriced, and
     * the router does not offer it.
     */
    const possible = new Set<RoomId>();
    for (const spell of spells.values()) {
      for (const landing of spell.rooms) {
        if (Number.isFinite(plain.get(landing) ?? Infinity)) possible.add(landing);
      }
    }
    for (let round = 0; round <= spells.size; round += 1) {
      let grew = false;
      for (const [id, spell] of spells) {
        // A draw whose every outcome is a dead end leads nowhere, however
        // easily its door is reached.
        if (!spell.rooms.some((landing) => possible.has(landing))) continue;
        const costs = reach.get(id);
        if (costs === undefined) continue;
        for (const other of spells.values()) {
          for (const landing of other.rooms) {
            if (possible.has(landing)) continue;
            if (!Number.isFinite(costs.get(landing) ?? Infinity)) continue;
            possible.add(landing);
            grew = true;
          }
        }
      }
      if (!grew) break;
    }

    const expectation = new Map<number, number>();
    for (const [id, spell] of spells) {
      if (!reach.has(id)) continue;
      if (spell.rooms.every((landing) => possible.has(landing))) expectation.set(id, 0);
    }
    const { scatterRounds, scatterTolerance } = tuning().world;
    const moved = new Map<number, number>();
    for (const id of expectation.keys()) moved.set(id, Infinity);
    for (let round = 0; round < scatterRounds; round += 1) {
      let worst = 0;
      for (const [id, spell] of spells) {
        if (!expectation.has(id)) continue;
        let total = 0;
        for (const landing of spell.rooms) {
          let value = plain.get(landing) ?? Infinity;
          for (const [other, costs] of reach) {
            const priced = expectation.get(other);
            if (priced === undefined) continue;
            const door = costs.get(landing);
            if (door === undefined) continue;
            value = Math.min(value, door + priced);
          }
          total += value;
        }
        const next = total / spell.rooms.length;
        /*
         * `Infinity - Infinity` is `NaN`, and `NaN < tolerance` is false for
         * ever — so a spell that reaches infinity (the reachability gate above
         * admits one whose only way on is through a draw with a dead end of
         * its own) held `worst` at `NaN` and spent every round of the ceiling
         * on a figure that had already settled. Its own movement is recorded
         * as settled, since it is; the filter below drops it for not being
         * finite, which is the half actually doing the work.
         */
        const before = expectation.get(id)!;
        const step = Number.isFinite(next) && Number.isFinite(before) ? Math.abs(next - before) : 0;
        moved.set(id, step);
        worst = Math.max(worst, step);
        expectation.set(id, next);
      }
      if (worst < scatterTolerance) break;
    }

    /*
     * **Only the figures that stopped moving.** The iteration climbs from
     * zero, so a scatter with no way through rises by a step a round for
     * ever and the ceiling would hand that back as though it were an
     * expectation — a guess wearing a decimal point. Per spell rather than
     * for the set, because they are only coupled where one maze's door is
     * inside another's: the asylum's five settle whatever the gloomy maze on
     * the other side of the realm is doing.
     */
    const costs = new Map<number, number>();
    for (const [id, value] of expectation) {
      if (Number.isFinite(value) && (moved.get(id) ?? Infinity) < scatterTolerance) {
        costs.set(id, value);
      }
    }
    this.solved = { to, traveller, costs };
    return costs;
  }

  /**
   * What a step's exit hands to the dice, where it does — the step's own half
   * of `scatterCosts`.
   *
   * Absent for every ordinary step, and absent too for a scatter the solve
   * could not price: the search never relaxes one of those, so a step wearing
   * a landing and no figure would be a plan claiming a way nothing measured.
   */
  private scatterOn(
    exit: WorldExit | PortalExit,
    to: RoomId,
    traveller: Traveller,
    useDraws: boolean
  ): { scatter?: RouteScatter } {
    if (!useDraws || exit.requirement?.spellEffect !== 'scatters') return {};
    const landing = exit.requirement.landing;
    if (landing === undefined) return {};
    // Priced, so the step is only carried where the search actually had a
    // figure to relax the goal with — and then said in moves, which is a
    // different number. See `scatterMoves`.
    if (this.scatterCosts(to, traveller).get(landing.spell) === undefined) return {};
    const moves = this.scatterMoves(to).get(landing.spell);
    const rooms = this.scatterDoors().get(landing.spell)?.rooms.length;
    if (moves === undefined || rooms === undefined) return {};
    return { scatter: { landing, rooms, moves } };
  }

  /**
   * What a draw costs in **moves**, which is not what it costs the router.
   *
   * `scatterCosts` solves in the A*'s own units, so a lair on the way prices
   * into it: measured on the asylum against a level-20 traveller whose padded
   * cells cost 40% of the bar a pass, the solve answered 19.7 where the walk
   * is nine moves. That is the right number for choosing between routes and
   * the wrong one to put in front of a reader under the word *moves* — the
   * chip would have overstated the wandering twofold, and the route's own
   * `cost` is already on the panel for the priced figure.
   *
   * So the reader's figure is the same solve with nothing priced but the
   * steps. It depends on the destination alone, never on the character, which
   * is what makes it worth keeping realm-wide; `scatterCosts`'s own cache is
   * one slot keyed on traveller identity and would thrash against it.
   */
  private scatterMoves(to: RoomId): ReadonlyMap<number, number> {
    const held = this.plainDraws.get(to);
    if (held !== undefined) return held;
    const solved = this.scatterCosts(to, PLAIN_TRAVELLER);
    // Cleared rather than evicted one by one: this is a convenience, not a
    // correctness store, and a destination asked for twice in a session is
    // the common case where it is asked for at all.
    if (this.plainDraws.size >= tuning().world.scatterMovesKept) this.plainDraws.clear();
    this.plainDraws.set(to, solved);
    return solved;
  }

  /**
   * A step along a route the player saved costs a fraction of an ordinary one.
   *
   * The cross-map heuristic drops to the same fraction while any route is
   * preferred, because the one edge it stands for may be a preferred one: a
   * heuristic above the cheapest possible step is no longer admissible, and A*
   * would pop the goal before the cheaper way had been relaxed.
   */
  private discountFor(traveller: Traveller): number {
    return traveller.preferred !== undefined && traveller.preferred.size > 0
      ? tuning().world.preferredStepCost
      : 1;
  }

  /**
   * What one move costs this traveller, or `null` where it cannot be made.
   *
   * **One arithmetic, three readers.** It lived inside the A*'s inner loop,
   * and the scatter solve has to price the same moves the same way or its
   * answer is about a different realm — a backward sweep that charged nothing
   * for a lair the forward search walls would report a way out of the asylum
   * that the plan then refuses to walk.
   *
   * `into` is `null` for a draw, whose room nobody knows: what waits in it
   * cannot be priced, and pricing the *destination's* lair there would charge
   * the old man's cell to every step of the maze. The rest of the price — the
   * gate, the portal's surcharge, a corridor the server refused this session —
   * is a fact about the move and is charged either way.
   */
  private stepCost(
    from: RoomId,
    exit: WorldExit | PortalExit,
    into: WorldRoom | null,
    traveller: Traveller,
    openGates: boolean,
    discount: number,
    /**
     * Whether this step is an item being used rather than a move being made,
     * in which case it pays `itemLandingCost` **instead of** the portal's own
     * surcharge. A room script's teleport is scenery anybody may walk through
     * as often as they like; this spends a charge somebody has to replace, and
     * pricing the two the same would have the router burn a recall token to
     * save four rooms of walking.
     */
    invoked = false
  ): number | null {
    /*
     * **A draw costs a move here, whatever it costs everywhere else.**
     * `edgePenalty` walls one, and that is the right answer for every reader
     * that wants to arrive in a particular room — you cannot use it to. The
     * router is the one reader that is not asking that: it has solved what
     * stepping through is worth (`scatterCosts`) and is pricing the *move*,
     * which is one move like any other. Charging the wall here as well priced
     * the way into the Warped Asylum at 275,000 steps and put the plan's cost
     * above the figure that makes a route report itself as crossing a wall.
     */
    const priced =
      exit.requirement?.spellEffect === 'scatters' ? 0 : edgePenalty(exit.requirement, traveller);
    // A gate held open is still the worst edge on the map, so the path this
    // finds is the one that was *nearly* walkable rather than a detour
    // through every locked door in the realm.
    const walled = priced === null ? (openGates ? tuning().world.wallCost : null) : priced;
    if (walled === null) return null;
    /*
     * And a barrier the realm names a word for is not a barrier.
     *
     * 28 of Paradigm's exits and 27 of stock's are priced beyond any
     * character's reach — `Door [1000 picklocks/strength]` — and open to
     * anybody who says `use crowbar`, `sit throne`, `push button` or `ask
     * shadow guard morukai` while standing in front of them. The lever was
     * never on the exit's own requirement (`buildRealm` writes `actions` only
     * for an exit that *states* `Needs N Actions`, which a door never does),
     * so nothing reading the requirement could find it and `edgePenalty` —
     * which reads nothing else — called every one of them a wall.
     *
     * Asked only of an edge already priced as a wall, so the hot loop pays one
     * Map lookup on the 0.8% of exits that are walls rather than on all of
     * them; and priced exactly as `edgePenalty` prices a hidden exit whose
     * levers are all in reach, because it is the same rung — `Walker` pulls
     * both, one command per lever.
     *
     * Read off `priced` and never off the gate `openGates` holds open: a
     * pruned edge is impassable for a reason no lever touches — a class the
     * character is not, a listed pack lacking the lever's own item — and that
     * last one is a hidden exit, which certainly *does* have levers here.
     * `leverPrice` answering null leaves the wall exactly where it was.
     */
    const penalty =
      priced !== null && priced >= tuning().world.wallCost
        ? (this.leverPrice(from, exit.direction, traveller) ?? walled)
        : walled;

    // A portal costs its penalty over a plain step, so the router prefers
    // ordinary corridors unless the teleport genuinely shortens the way.
    const surcharge = invoked
      ? tuning().world.itemLandingCost
      : exit.direction === 'portal'
        ? tuning().world.portalPenalty
        : 0;
    const wall = traveller.refused?.has(`${from}|${exit.direction}`) ? 100_000 : 0;
    // The whole step — the door's price and the portal's with it — is
    // discounted along a saved route: the player chose that door. A refusal is
    // not, because the server said no this session.
    const along =
      into !== null &&
      traveller.preferred?.has(`${from}|${roomId(into.map, into.room)}`) === true &&
      discount !== 1
        ? discount
        : 1;
    // And what is waiting in the room being stepped into: a lair priced
    // against this character, or nothing where nothing can be weighed.
    const risk =
      into === null || traveller.danger === undefined ? 0 : dangerPenalty(traveller.danger(into));
    /*
     * And what the room itself does to whoever stands in it. Priced on the
     * same slope as a lair and for the same reason — the step from
     * *unpleasant* to *fatal* is continuous — but it is a **certainty** rather
     * than a fight that might be walked past, which is why it is added rather
     * than taken as the worse of the two: a poisoned lair is both.
     */
    const room =
      into === null || traveller.hazard === undefined ? 0 : dangerPenalty(traveller.hazard(into));
    // And a step along the plan a different way is being asked for, priced
    // over rather than pruned (`another`). Never for a walk.
    const dearer =
      into !== null && traveller.penalised?.has(`${from}|${roomId(into.map, into.room)}`) === true
        ? tuning().world.anotherWayPenalty
        : 1;
    return (1 + penalty + surcharge + risk + room) * along * dearer + wall;
  }

  /**
   * One A* pass. `openGates` prices the three impassable conditions instead of
   * pruning them, which is how the failed case finds a path to explain itself.
   *
   * `drawsAhead` on the result is what makes asking twice affordable: a failed
   * search has already walked everything the character can reach, so it knows
   * whether a scatter door was among it. Without that, every unroutable pair
   * in the realm paid for the solve's sweeps to discover there had never been
   * a draw to take — measured at a p95 of 595ms against 121ms over 40 random
   * pairs, which is the whole of why this is reported rather than assumed.
   */
  private search(
    from: RoomId,
    to: RoomId,
    goal: WorldRoom,
    traveller: Traveller,
    openGates: boolean,
    useDraws: boolean,
    useLandings = false
  ): SearchResult {
    /*
     * A step along a preferred route costs a fraction of an ordinary one. The
     * cross-map heuristic is that same fraction while any route is preferred,
     * because the one edge it stands for may be a preferred one: a heuristic
     * above the cheapest possible step is no longer admissible, and A* would
     * pop the goal before the cheaper way had been relaxed.
     */
    const discount = this.discountFor(traveller);
    const heuristic = (room: WorldRoom): number => (room.map === goal.map ? 0 : discount);
    /*
     * What a draw is worth from here, where there is one to take. Solved once
     * per search rather than per expansion: it is a property of the goal and
     * the traveller, not of the room the door is in. Empty — which is every
     * route in the realm that never meets a scatter — costs the solve nothing,
     * because `scatterCosts` looks for doors before it sweeps for anything.
     */
    let solved: ReadonlyMap<number, number> | null = null;
    const draw = (spell: number): number | undefined => {
      if (!useDraws) return undefined;
      solved ??= this.scatterCosts(to, traveller);
      return solved.get(spell);
    };

    const cameFrom = new Map<RoomId, { prev: RoomId; exit: WorldExit | PortalExit }>();
    const best = new Map<RoomId, number>([[from, 0]]);
    const open = new MinHeap<RoomId>();
    let drawsAhead = false;
    open.push(heuristic(this.rooms.get(from)!), from);

    /*
     * **An item that works wherever you stand is relaxed once, from where the
     * character is standing** — and that is optimal rather than a shortcut
     * taken for speed. Its landing is a fixed address, so using it at the
     * start costs the invocation and nothing else, and using it later costs
     * the invocation *plus* the walk to wherever you used it: the first
     * dominates every other room this search could expand it from.
     *
     * **Only the unbound ones reach here.** An item the realm gates on
     * `roomitem` works in one room and is a portal out of it
     * (`linkItemLandings`), found by the ordinary search like any other edge —
     * which is the whole of the fix for *it is planning it from a spot I am
     * not in*. `itemLandings()` withholds those, so this cannot put the
     * assumption back.
     *
     * The corollary is the reason `withinSteps` does not do this at all: the
     * hunting survey and the map ask *what is near*, and a room the whole
     * realm is one token away from is not a neighbour of anywhere. A bound
     * landing **is** counted there, correctly, because one move from `3/1`
     * really is one move.
     */
    if (useLandings) {
      for (const exit of this.itemLandings()) {
        const nextId = roomId(exit.map, exit.room);
        const next = this.rooms.get(nextId);
        if (next === undefined || nextId === from) continue;
        if (traveller.avoid?.has(nextId) === true) continue;
        const price = this.stepCost(from, exit, next, traveller, openGates, discount, true);
        if (price === null) continue;
        if (price >= (best.get(nextId) ?? Infinity)) continue;
        best.set(nextId, price);
        cameFrom.set(nextId, { prev: from, exit });
        open.push(price + heuristic(next), nextId);
      }
    }

    while (open.size > 0) {
      const currentId = open.pop()!;
      if (currentId === to) {
        // A pass that arrived asks nothing further: the flag is read only on
        // the failure path, and computing it here would price eight lookups
        // onto every successful route in the realm.
        return { found: { cameFrom, cost: best.get(to) ?? 0 }, drawsAhead, landingsAhead: false };
      }

      const current = this.rooms.get(currentId);
      if (!current) continue;
      const currentCost = best.get(currentId) ?? Infinity;

      // The room's exits, and any scripted teleports the router may walk —
      // one relaxation, because a portal is priced like any other gated edge.
      const scripted = this.portals.get(currentId);
      const ways: ReadonlyArray<WorldExit | PortalExit> = scripted
        ? [...current.exits, ...scripted]
        : current.exits;
      for (const exit of ways) {
        /*
         * A draw is not an edge, so it is never relaxed as one: relaxing it
         * would put the exit table's room on the plan and every step after it
         * would be directions from somewhere the character is not. What it
         * *is* is a move to the destination with a price — the moves expected
         * between stepping through and standing there, which is what
         * `scatterCosts` solves — so the goal itself is what it relaxes, and
         * the step through it is the last one the plan can hold.
         */
        if (exit.requirement?.spellEffect === 'scatters') {
          const landing = exit.requirement.landing;
          if (landing !== undefined) drawsAhead = true;
          const expected = landing === undefined ? undefined : draw(landing.spell);
          if (expected === undefined) continue;
          const price = this.stepCost(currentId, exit, null, traveller, openGates, discount);
          if (price === null) continue;
          const tentative = currentCost + price + expected;
          if (tentative >= (best.get(to) ?? Infinity)) continue;
          best.set(to, tentative);
          cameFrom.set(to, { prev: currentId, exit });
          open.push(tentative, to);
          continue;
        }

        const nextId = this.beyond(exit);
        const next = this.rooms.get(nextId);
        // An exit pointing outside the dataset is a hole in the data, not a
        // route; following it would produce a step that cannot be walked.
        if (!next) continue;
        // The one pruning this router does on the traveller's account, and
        // only while it is answering *is there another way*. See `avoid`.
        if (traveller.avoid?.has(nextId) === true) continue;
        if (traveller.avoidEdges?.has(`${currentId}|${exit.direction}`) === true) continue;

        const price = this.stepCost(currentId, exit, next, traveller, openGates, discount);
        if (price === null) continue;
        const tentative = currentCost + price;
        if (tentative >= (best.get(nextId) ?? Infinity)) continue;

        best.set(nextId, tentative);
        cameFrom.set(nextId, { prev: currentId, exit });
        open.push(tentative + heuristic(next), nextId);
      }
    }
    return {
      found: null,
      drawsAhead,
      landingsAhead: this.itemLandings().some((exit) => !best.has(roomId(exit.map, exit.room)))
    };
  }

  /** Every gate on a found path this traveller cannot pass, in walking order. */
  private blocksAlong(
    cameFrom: Map<RoomId, { prev: RoomId; exit: WorldExit | PortalExit }>,
    to: RoomId,
    traveller: Traveller
  ): RouteBlock[] {
    const blocks: RouteBlock[] = [];
    let cursor = to;
    while (cameFrom.has(cursor)) {
      const { prev, exit } = cameFrom.get(cursor)!;
      const blocked = edgeBlock(exit.requirement, traveller);
      if (blocked) {
        const name = this.rooms.get(cursor)?.name ?? cursor;
        const requirement = blocked.requirement;
        if (blocked.kind === 'key' || blocked.kind === 'item') {
          /*
           * Both name a thing the pack does not hold, so both look it up here
           * — this is where the realm's item table is, and `describeBlock` is
           * in `src/shared` where it is not. `Key: 1124` on a route panel is
           * the exact half-read `describeObstacle`'s own header refuses for the
           * chip beside it.
           */
          const wanted = blocked.itemId ?? requirement.keyId;
          const item = wanted === undefined ? undefined : this.item(wanted);
          blocks.unshift({
            kind: blocked.kind === 'key' ? 'key' : 'carry',
            at: prev,
            to: cursor,
            name,
            ...(wanted === undefined
              ? {}
              : blocked.kind === 'key'
                ? { keyId: wanted }
                : { itemId: wanted }),
            ...(item === undefined ? {} : { itemName: item.name })
          });
        } else if (blocked.kind === 'level') {
          // An item's own level gate names the item, not the room it lands
          // in: *token of Silvermere needs level 25* is the sentence, and
          // *Pier needs level 25* is a claim about the wrong thing.
          const gate = requirement.usableBy?.minLevel;
          blocks.unshift({
            kind: 'level',
            at: prev,
            to: cursor,
            name: gate === undefined ? name : (this.spends.get(exit as PortalExit)?.name ?? name),
            level: traveller.level ?? null,
            ...(gate !== undefined
              ? { minLevel: gate }
              : requirement.minLevel === undefined
                ? {}
                : { minLevel: requirement.minLevel }),
            ...(requirement.maxLevel === undefined ? {} : { maxLevel: requirement.maxLevel })
          });
        } else if (blocked.kind === 'toll') {
          /*
           * The price and the purse, so the sentence can state the shortfall
           * rather than assert the character has nothing. Both omitted when
           * genuinely unknown — a gate the realm priced at nothing recorded, and
           * a purse no listing has stated — because absent and zero are
           * different answers and this sentence is read to decide what to do.
           */
          blocks.unshift({
            kind: 'toll',
            at: prev,
            to: cursor,
            name,
            ...(requirement.tollCopper === undefined ? {} : { tollCopper: requirement.tollCopper }),
            ...(traveller.wealth === null || traveller.wealth === undefined
              ? {}
              : { purseCopper: traveller.wealth })
          });
        } else if (blocked.kind === 'ability') {
          /*
           * The counter, the window and what the character holds.
           *
           * `held` is never a guess: this block exists only where
           * `abilityGatesMet` answered *false*, which it does only against a
           * listing, so an id the listing did not name is zero because a
           * complete listing enumerates — the same reading `countersMet` uses.
           *
           * **Named as GreaterMUD's**, because `abil` is GreaterMUD's command:
           * a listing is the one thing that puts a block here, so a realm that
           * cannot state the counters cannot reach this line. An id the enum
           * does not hold leaves the name off and the number stands.
           */
          const gate = (requirement.abilities ?? [])[0];
          const id = gate?.id ?? requirement.abilityId;
          if (id !== undefined) {
            const named = abilityName(id, 'greatermud');
            blocks.unshift({
              kind: 'quest',
              at: prev,
              to: cursor,
              name,
              abilityId: id,
              ...(named === null ? {} : { counterName: named }),
              held: traveller.counters?.sums[id] ?? 0,
              ...(gate?.atLeast === undefined ? {} : { atLeast: gate.atLeast }),
              ...(gate?.atMost === undefined ? {} : { atMost: gate.atMost })
            });
          }
        } else {
          /*
           * The three the character *is*, in one block shape: which condition,
           * what it carries, and whichever half of the gate the realm stated.
           * An alignment window arrives written — `Saint to Seedy` — because
           * it is one fact with two ends, and the sentence should not have to
           * put them back together.
           */
          /*
           * **Named, not numbered.** `admits only class 6` is the `Key: 1124`
           * half-read again, and the table that fixes it is right here —
           * `namedClasses` and `namedRaces` exist for exactly this, and their
           * own doc says so: *a bare list of numbers is the half-read
           * `WorldLookup` already carries `classNames` to avoid*. A row id the
           * realm's table does not hold falls back to the number, which is
           * still more than nothing and is honest about being a number.
           */
          const table =
            blocked.kind === 'class'
              ? this.namedClasses()
              : blocked.kind === 'race'
                ? this.namedRaces()
                : {};
          const named = (id: number | null | undefined): string | number | null =>
            id === null || id === undefined ? null : (table[id] ?? id);
          const mine =
            blocked.kind === 'alignment'
              ? (traveller.alignment ?? null)
              : named(blocked.kind === 'class' ? traveller.classId : traveller.raceId);
          // An item's allow-list is several names where an exit's gate is
          // one, and the item is what admits them, not the room it lands in.
          const allowed =
            blocked.kind === 'class'
              ? requirement.usableBy?.classes
              : blocked.kind === 'race'
                ? requirement.usableBy?.races
                : undefined;
          const admits =
            blocked.kind === 'alignment'
              ? requirement.minAlignment === undefined
                ? undefined
                : `${requirement.minAlignment} to ${requirement.maxAlignment ?? requirement.minAlignment}`
              : allowed !== undefined
                ? allowed.map((id) => String(named(id))).join(', ')
                : (named(blocked.kind === 'class' ? requirement.classOk : requirement.raceOk) ??
                  undefined);
          const refuses =
            named(blocked.kind === 'class' ? requirement.classNo : requirement.raceNo) ?? undefined;
          blocks.unshift({
            kind: 'born',
            at: prev,
            to: cursor,
            name,
            condition: blocked.kind,
            mine,
            ...(admits === undefined ? {} : { admits }),
            ...(refuses === undefined ? {} : { refuses })
          });
        }
      } else {
        // Not pruned, but priced as a wall: a door below both skills, which
        // the plan itself walks when nothing else leads there.
        const wall = edgeWall(exit.requirement, traveller);
        // Named as a wall only where nothing here opens it, the reading
        // `stepCost` priced it by. `Walker.pullLevers` sends the phrase.
        if (wall !== null && this.leverPrice(prev, exit.direction, traveller) === null) {
          const item = wall.keyId === undefined ? undefined : this.item(wall.keyId);
          blocks.unshift({
            kind: 'door',
            at: prev,
            to: cursor,
            name: this.rooms.get(cursor)?.name ?? cursor,
            ...(wall.pickDifficulty === undefined ? {} : { pickDifficulty: wall.pickDifficulty }),
            ...(wall.bashDifficulty === undefined ? {} : { bashDifficulty: wall.bashDifficulty }),
            picklocks: traveller.pickSkill ?? null,
            strength: traveller.strength ?? null,
            ...(wall.keyId === undefined ? {} : { keyId: wall.keyId }),
            ...(item === undefined ? {} : { itemName: item.name }),
            ...this.leverSaying(prev, exit.direction)
          });
        }
      }
      cursor = prev;
    }
    return blocks;
  }

  private buildRoute(
    cameFrom: Map<RoomId, { prev: RoomId; exit: WorldExit | PortalExit }>,
    to: RoomId,
    cost: number,
    traveller: Traveller,
    useDraws = false
  ): Route {
    const steps: RouteStep[] = [];
    let cursor = to;

    while (cameFrom.has(cursor)) {
      const { prev, exit } = cameFrom.get(cursor)!;
      const destination = this.rooms.get(cursor);
      /*
       * **Nothing about the room, where the room is a draw.**
       *
       * `cursor` on a scatter step is the *destination of the journey*, which
       * is the node the search relaxed — so every fact taken off it here would
       * describe a room the character is not walking into. `stepCost` already
       * says so in the price: it passes `into: null` and charges nothing for
       * what waits there, because nobody knows. Carrying the figures anyway
       * made the price and the step disagree about one move, and three readers
       * acted on the step: `AutoLight` was handed the goal's darkness for a
       * room it was not entering, `holdForTrap` reserved health against the
       * old man's own lair before a step that does not reach it, and
       * `lairsAlong().deadly` named a room the step never enters — which
       * `otherWay` then prunes on.
       */
      const drawn = this.scatterOn(exit, to, traveller, useDraws);
      const arriving = drawn.scatter === undefined ? destination : undefined;
      // The figure the step was priced by, so the panel can say what waits
      // there rather than only what the walk costs in total.
      const danger =
        arriving === undefined || traveller.danger === undefined
          ? null
          : traveller.danger(arriving);
      const hazard =
        arriving === undefined || traveller.hazard === undefined
          ? null
          : traveller.hazard(arriving);
      const lairDamage =
        arriving === undefined || traveller.lairDamage === undefined
          ? null
          : traveller.lairDamage(arriving);
      steps.unshift({
        from: prev,
        to: cursor,
        direction: exit.direction,
        // A `Text:` exit is not walked with a direction; it needs its own
        // command, and the first listed phrasing is the canonical one.
        command: exit.requirement?.commands?.[0] ?? DIRECTION_COMMAND[exit.direction as Direction],
        name: destination?.name ?? '',
        requirement: exit.requirement,
        /*
         * The same sentences the map draws, on the step. `requirement.kind`
         * alone put `toll` beside a room name with the price it charges sitting
         * unread in the same object — the exact asymmetry `RouteBlock` already
         * records for a route that was refused outright.
         */
        ...(exit.requirement
          ? {
              obstacle: describeObstacle(
                exit.requirement,
                this,
                // A door's lever is not on the door: the step is what knows
                // where it is standing, so the join is made here.
                this.leversHere(prev, exit.direction)
              )
            }
          : {}),
        // Absent is not dark: `buildRealm` writes a level only when the realm
        // recorded a non-zero one.
        dark: arriving?.light !== undefined && arriving.light < 0,
        // And the level itself, for the light arithmetic: how dark decides
        // whether a torch is worth lighting, and `dark` alone cannot say.
        ...(arriving?.light !== undefined && arriving.light < 0 ? { light: arriving.light } : {}),
        ...(danger !== null && danger > 0 ? { danger } : {}),
        ...(lairDamage !== null && lairDamage > 0 ? { lairDamage } : {}),
        // And what the room itself does to whoever stands in it, by the same
        // rule and from the same call the router priced the step with.
        ...(hazard !== null && hazard > 0 ? { hazard } : {}),
        // And the word, where the share is a discouragement and not a figure.
        ...(hazard !== null && hazard > 0 && arriving !== undefined
          ? hazardWordOf(this.hazardOf(arriving, traveller.level))
          : {}),
        /*
         * **Either of them reaching the wall makes the step deadly.** It was
         * the lair's flag alone, so a room whose own *spell* takes the whole
         * bar — `magma heat` is 30–60 against a level-4 character — priced as
         * a wall, was walked, and said nothing at the head of the plan. The
         * two facts are different and what they mean for the reader is the
         * same one: you are expected to die there.
         */
        ...(Math.max(danger ?? 0, hazard ?? 0) >= tuning().world.deadlyShare
          ? { deadly: true }
          : {}),
        /*
         * And what the step spends, where the step is an item being used
         * rather than a move being made. Keyed on the exit object, which is
         * shared and never rebuilt, so this is a lookup and not a second
         * reading of the item table.
         */
        ...(this.spends.has(exit as PortalExit)
          ? {
              invoke: {
                ...this.spends.get(exit as PortalExit)!,
                // Where it is used, which is the room the step leaves from —
                // the one fact a teleport's row cannot get from its position
                // in the list.
                at: { room: prev, name: this.rooms.get(prev)?.name ?? '' }
              }
            }
          : {}),
        /*
         * And the one step after which the plan stops being a plan. `to` above
         * is already the destination rather than the room this move reaches,
         * because that is the node the search relaxed — see `RouteStep.scatter`
         * — so this is what says the arrival is a draw and what it is expected
         * to cost from here.
         */
        ...drawn
      });
      cursor = prev;
    }

    const hazards = this.hazardsAlong(steps, traveller);
    return { steps, cost, blocked: false, ...(hazards.length > 0 ? { hazards } : {}) };
  }

  /**
   * The room spells a route walks through, folded one entry per spell.
   *
   * Per spell rather than per room because that is the shape of the answer: a
   * route down the Silver River crosses eight hundred rooms of one spell, and
   * a list of eight hundred lines saying *river damage* is a list nobody
   * reads. What the reader wants is the name, how many rooms, what each costs
   * — and above all what would stop it, which is one fact for all of them.
   *
   * `needs` is filtered against the pack, so an item already carried is not
   * offered as a thing to fetch. It is filtered nowhere else: a character
   * whose pack nobody has listed is told what the realm says, which is the
   * honest half-answer rather than silence.
   */
  private hazardsAlong(steps: readonly RouteStep[], traveller: Traveller): RouteHazard[] {
    const folded = new Map<number, RouteHazard>();
    for (const step of steps) {
      // A draw's `to` is the destination, not the room the step reaches, so
      // there is no room here to read a spell off — `buildRoute` withholds
      // every other fact about it for the same reason.
      if (step.scatter !== undefined) continue;
      const room = this.rooms.get(step.to);
      if (room?.spell === undefined) continue;
      const spell = this.spellById(room.spell);
      const hazard = spell?.hazard;
      if (spell === null || hazard === undefined) continue;
      if (hazardAvoided(hazard, traveller.keys, traveller.spellsUp)) continue;
      const seen = folded.get(spell.id);
      if (seen !== undefined) {
        seen.rooms += 1;
        continue;
      }
      folded.set(spell.id, {
        id: spell.id,
        spell: spell.name,
        rooms: 1,
        /*
         * The first room's share stands for all of them, and that is exact
         * rather than a sample: the damage is a figure the realm states per
         * *spell*, and the health it is a share of is the health the route was
         * planned at — so every room casting this spell is priced identically.
         * Null where nothing could be weighed, which is not zero: the count
         * and what stops it are still worth saying.
         */
        share: step.hazard ?? null,
        unread: hazard.unread === true,
        summons: hazard.summons === true,
        relocates: hazard.relocates === true,
        needs: (hazard.avoidedBy ?? []).flatMap((id) => {
          if (traveller.keys?.includes(id) === true) return [];
          const item = this.item(id);
          // A row the item index cannot name is left out: `carry item 3609`
          // is the exact half-read `describeObstacle` refuses for a key.
          return item === undefined ? [] : [{ id, name: item.name }];
        }),
        needsSpell: (hazard.avoidedBySpell ?? []).flatMap((id) => {
          const named = this.spellById(id);
          return named === null ? [] : [named.name];
        })
      });
    }
    // Worst first: the reader is deciding whether to walk it, and the figure
    // that decides is the heaviest one.
    const hazards = [...folded.values()].sort(
      (a, b) => (b.share ?? 0) * b.rooms - (a.share ?? 0) * a.rooms || b.rooms - a.rooms
    );
    /*
     * And the passages the way in puts the character under (todo 104), said
     * as the plan says them: nothing carried stops one, so `needs` is empty
     * and `share` null, and the chip reads *run through* off `corridor`.
     */
    for (const passage of this.corridorsOn(steps)) {
      hazards.push({
        id: passage.id,
        spell: passage.spell,
        rooms: passage.rooms,
        share: null,
        unread: false,
        summons: false,
        relocates: false,
        needs: [],
        needsSpell: [],
        corridor: {
          ends: passage.ends,
          ...(passage.ticks === undefined ? {} : { ticks: passage.ticks }),
          ...(passage.then === undefined ? {} : { then: passage.then })
        }
      });
    }
    return hazards;
  }
}

/**
 * Whether a spell row is one a player could cast, and so worth linking on
 * sight. See `names()` for why the realm's spell table holds far more than
 * spells; a row stating none of these four is an engine effect, not a spell
 * anybody knows the name of.
 */
/**
 * What the person behind a counter is called, from the kind of counter.
 *
 * The **only** sound source for an NPC's role: the realm records which shop a
 * room holds and what kind it is, so `mariana` in a room holding shop 202 is a
 * shopkeeper. Nothing else in the data says what a creature *does* —
 * `Monsters.Type` was measured and does not (see `MobEntity.realmType`) — so
 * a room with no shop leaves `npcType` undefined rather than guessing.
 *
 * There is no `guard` and no `quest` here, deliberately, for the reason the
 * Room card's faces have no healer: do not invent a kind the realm cannot
 * distinguish.
 */
/**
 * The levers on one exit, parsed rather than cast — format 23.
 *
 * Every other field in `parseRoom` is type-checked and this one was taken
 * wholesale, while `describeObstacle` and `Walker.pullLevers` both reach
 * `act.say[0]!` behind a non-null assertion. A realm whose `Action …` cell has
 * a shape this build does not expect would put `undefined` into the obstacle
 * chip and give the walker a rung that sends nothing, returns true and spends
 * a lever budget. Parse, do not validate — the reviewer's find, 2026-09-06.
 *
 * A member that will not parse drops the **whole** list rather than shortening
 * it: `openableHere` counts what is left against nothing, so half a lever set
 * would read as a passage this room can open when it cannot.
 */
function readActions(raw: unknown): RequirementAction[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const actions: RequirementAction[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const say = record['say'];
    if (!Array.isArray(say) || say.length === 0) return [];
    if (!say.every((phrase): phrase is string => typeof phrase === 'string' && phrase.length > 0)) {
      return [];
    }
    const action: RequirementAction = { say: [...say] };
    const item = record['item'];
    if (item !== undefined) {
      if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) return [];
      action.item = item;
    }
    const at = record['at'];
    if (at !== undefined) {
      if (typeof at !== 'object' || at === null) return [];
      const place = at as Record<string, unknown>;
      if (typeof place['map'] !== 'number' || typeof place['room'] !== 'number') return [];
      action.at = { map: place['map'], room: place['room'] };
    }
    actions.push(action);
  }
  return actions;
}

/**
 * One room the realm spawns a monster in, before the grouping.
 *
 * The room itself rather than its address, because the group is keyed on the
 * room's *name* and re-reading it out of the index per entry would be a lookup
 * per room in a scan built to avoid exactly that.
 */
interface MobSpawnRoom {
  room: WorldRoom;
  via: MobSpawn['via'];
  /** The lair's slot count; null for a resident, which has no such figure. */
  max: number | null;
}

const NPC_ROLE_OF: Readonly<Record<ShopKind, NonNullable<NpcEntity['npcType']> | undefined>> = {
  shop: 'shopkeeper',
  bank: 'banker',
  trainer: 'trainer',
  inn: 'innkeeper',
  tavern: 'tavernkeeper',
  temple: 'priest'
};

function isCastable(spell: WorldSpell): boolean {
  return (
    spell.short !== undefined ||
    spell.level !== undefined ||
    spell.mana !== undefined ||
    spell.energy !== undefined
  );
}

/**
 * What kind of thing an item is, read off a v6 header record onto the item.
 *
 * The file carries the realm's *numbers* and this turns them into words, so a
 * correction to `shared/items.ts` reaches a realm converted before it without a
 * rebuild. Every field is optional and absent means the realm does not say;
 * a zero in the file was already left out at build time, so nothing here has
 * to decide whether zero is a fact.
 */
/**
 * The `[id, value]` effect pairs off a realm record, whatever kind it is.
 *
 * Items have carried these since format 12; monsters, spells, races and
 * classes since format 14. Kept as the realm's own numbers — `shared/abilities.ts`
 * names them where they are shown, because the *reading* is a claim from
 * another client's source and may be corrected.
 *
 * A malformed pair is dropped rather than repaired: a realm file this client
 * wrote is the only source, so a shape that is not a pair of numbers is a bug
 * here and not a derivative being different. An absent field is an empty list,
 * which is what a realm built before the format that added it produces — the
 * same answer as a row the realm states no effects for, and every consumer
 * already draws nothing for it.
 */
/**
 * The realm format that first wrote `BuiltMob.pf`, so a name without one can
 * be told apart from a file that never had them. `buildRealm.ts` numbers the
 * formats; this is the one row of that table the reader has to know.
 */
const PROFILES_SINCE = 20;

/** The realm format that states the coin a price is counted in (`BuiltItem.cur`). */
const CURRENCY_SINCE = 47;

/**
 * How many `room|name` resolutions are kept before the table is dropped whole.
 *
 * A character walks through rooms and meets names, so the pair is what grows;
 * a thousand of them is more rooms than a loop visits and a few tens of
 * kilobytes. Cleared rather than evicted one at a time: the next room re-asks
 * for what it needs, and the answer is a breadth-first sweep that has already
 * been paid for once — an LRU here would be bookkeeping for a table that is
 * cheap to refill and never hot after a walk has moved on.
 */
const RESOLVED_ROW_CACHE = 1000;

/** A room two of a name's rows both spawn in: it tells them apart for nobody. */
const TIED_ROW = -1;

/**
 * A monster entity, re-answered by one of the realm's rows rather than by the
 * fold of every row sharing its name.
 *
 * Every magnitude is replaced rather than merged, absences included: a row
 * that states no armour is a row with no armour, and keeping the fold's figure
 * for it would put another row's armour class on this one. Nothing else on the
 * entity is the realm's to say — `charmed` and `rawName` came off the wire.
 */
function overlayRow(entity: MobEntity, row: WorldMobRow | undefined): void {
  if (row === undefined) return;
  entity.row = namedHere(row.id);
  entity.hp = row.hp;
  delete entity.span;
  entity.disposition = row.disposition;
  // One row is certain about itself; the fold's doubt was about its twins.
  entity.uncertain = false;
  entity.armour = row.armour;
  entity.damageResist = row.damageResist;
  entity.magicResist = row.magicResist;
  entity.experience = row.experience;
  entity.regen = row.regen;
  entity.regenHours = row.regenHours;
  entity.follows = row.follows;
  entity.averageDamage = row.averageDamage;
  entity.charmLevel = row.charmLevel;
  entity.undead = row.undead;
  if (entity.profiles !== undefined) entity.profiles = row.profile === null ? [] : [row.profile];
}

/**
 * A row a room names outright — its lair descriptor or its resident.
 *
 * The strongest evidence there is and the only kind that needs no search: the
 * realm states the number, so there is no nearer row and no margin to weigh.
 * `steps: 0` and no radius say exactly that, which is what `MobRowChoice.how`
 * already means by `here`.
 */
function namedHere(id: number): MobRowChoice {
  return { id, how: 'here', steps: 0, beyond: null };
}

/**
 * The fold, answering as one of its rows.
 *
 * `overlayRow`'s twin for the shape the realm's tables are read in, and the
 * reason there are two: a `MobEntity` is built from a name off the wire and
 * filled in on the way out, a `WorldMob` is the shared record every reader
 * holds and must never be written to. Every magnitude the fold took the worst
 * of becomes this row's own, and `span` goes with them — one row is certain
 * about itself, and the doubt was always about its twins.
 */
function mobAsRow(mob: WorldMob, row: WorldMobRow, choice: MobRowChoice): WorldMob {
  const resolved: WorldMob = {
    ...mob,
    hp: row.hp,
    disposition: row.disposition,
    uncertain: false,
    row: choice
  };
  delete resolved.span;
  resolved.armour = row.armour;
  resolved.damageResist = row.damageResist;
  resolved.magicResist = row.magicResist;
  resolved.experience = row.experience;
  resolved.regen = row.regen;
  resolved.regenHours = row.regenHours;
  resolved.follows = row.follows;
  resolved.averageDamage = row.averageDamage;
  resolved.charmLevel = row.charmLevel;
  resolved.undead = row.undead;
  if (mob.profiles !== undefined) resolved.profiles = row.profile === null ? [] : [row.profile];
  return resolved;
}

/** Every figure in a compact slot is a finite number, or the slot is dropped. */
function figures(slot: unknown): number[] | null {
  return Array.isArray(slot) &&
    slot.every((each): each is number => typeof each === 'number' && Number.isFinite(each))
    ? slot
    : null;
}

/**
 * `BuiltMob.pf` back into profiles — format 20.
 *
 * The boundary rule `readAbilities` follows, one field along: a slot that is
 * not the shape `compactProfile` writes is dropped rather than repaired,
 * because the converter is the only writer of this file and anything else is
 * a bug there. A profile that comes back with nothing in it is not one.
 */
function readProfiles(raw: unknown): MobProfile[] {
  const profiles: MobProfile[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const attacks: MobAttack[] = [];
    for (const slot of Array.isArray(record['a']) ? record['a'] : []) {
      const row = figures(slot);
      if (row === null) continue;
      if (row[0] === 1 && row.length === 7) {
        const attack: MobAttack = {
          kind: 'melee',
          chance: row[1]!,
          accuracy: row[2]!,
          min: row[3]!,
          max: row[4]!,
          energy: row[5]!
        };
        if (row[6]! > 0) attack.onHit = row[6]!;
        attacks.push(attack);
      } else if (row[0] === 2 && row.length === 6) {
        attacks.push({
          kind: 'spell',
          chance: row[1]!,
          spell: row[2]!,
          castChance: row[3]!,
          level: row[4]!,
          energy: row[5]!
        });
      }
    }
    const casts: MobCast[] = [];
    for (const slot of Array.isArray(record['c']) ? record['c'] : []) {
      const row = figures(slot);
      if (row === null || row.length !== 3) continue;
      casts.push({ spell: row[0]!, chance: row[1]!, level: row[2]! });
    }
    if (attacks.length > 0 || casts.length > 0) profiles.push({ attacks, casts });
  }
  return profiles;
}

function readAbilities(record: Record<string, unknown>): Array<[number, number]> {
  return Array.isArray(record['ab'])
    ? record['ab'].filter(
        (pair): pair is [number, number] =>
          Array.isArray(pair) &&
          pair.length === 2 &&
          typeof pair[0] === 'number' &&
          typeof pair[1] === 'number'
      )
    : [];
}

/**
 * A `[number, number]` the realm file states, or null.
 *
 * The same boundary rule `readAbilities` follows one field along: a shape that
 * is not a pair of finite numbers is dropped rather than repaired, because the
 * only writer of this file is `buildRealm` and anything else is a bug here. A
 * realm converted before format 16 states none of these, which reads as null —
 * *the realm does not say*, never zero.
 */
function readPair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [a, b] = value;
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [a, b];
}

/**
 * A room spell's hazard, from a record written by `buildRealm` — format 30.
 *
 * The same boundary rule `readPair` follows: a shape that is not what
 * `BuiltSpellHazard` writes is dropped rather than repaired. Absent on every
 * realm converted before this existed, which reads as *no hazard* — the answer
 * the client gave for every room until now.
 */
function readHazard(value: unknown): SpellHazard | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const hazard: SpellHazard = {};
  const damage = Number(record['d']);
  if (Number.isFinite(damage) && damage > 0) hazard.damage = damage;
  const avoidedBy = readIdList(record['av']);
  if (avoidedBy.length > 0) hazard.avoidedBy = avoidedBy;
  const avoidedBySpell = readIdList(record['sp']);
  if (avoidedBySpell.length > 0) hazard.avoidedBySpell = avoidedBySpell;
  if (record['tp'] === 1) hazard.relocates = true;
  if (record['sm'] === 1) hazard.summons = true;
  if (record['u'] === 1) hazard.unread = true;
  const levels = readLevelBands(record['lv']);
  if (levels !== null) hazard.levels = levels;
  // Nothing stated at all is nothing to carry: the writer omits a spell whose
  // chain reaches no harm, so an empty object here is a row that says nothing.
  return Object.keys(hazard).length > 0 ? hazard : null;
}

/**
 * The level bands a hazard's own effects sit behind — format 46, `[min, max]`
 * with `null` for unbounded. A band that bounds nothing is not carried: it is
 * the same fact as an absent one and would make `hazardFor` copy the object
 * for no answer.
 */
function readLevelBands(value: unknown): SpellHazard['levels'] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const band = (raw: unknown): LevelBand | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const [min, max] = raw as [unknown, unknown];
    const read: LevelBand = {};
    if (typeof min === 'number' && Number.isFinite(min)) read.min = min;
    if (typeof max === 'number' && Number.isFinite(max)) read.max = max;
    return read.min === undefined && read.max === undefined ? undefined : read;
  };
  const levels: NonNullable<SpellHazard['levels']> = {};
  const damage = band(record['d']);
  if (damage !== undefined) levels.damage = damage;
  const relocates = band(record['tp']);
  if (relocates !== undefined) levels.relocates = relocates;
  const summons = band(record['sm']);
  if (summons !== undefined) levels.summons = summons;
  return Object.keys(levels).length > 0 ? levels : null;
}

/** `RouteStep.hazardKind` for a spell priced on nothing the realm states. */
function hazardWordOf(hazard: SpellHazard | null): { hazardKind?: 'unread' | 'summons' } {
  if (hazard === null || hazard.damage !== undefined) return {};
  if (hazard.unread === true) return { hazardKind: 'unread' };
  if (hazard.summons === true) return { hazardKind: 'summons' };
  return {};
}

/**
 * A list of the realm's own row ids, from a record written by `buildRealm`.
 *
 * Whole-array validation rather than a cast: this is a boundary, and a file on
 * disk is a payload like any other. A non-integer is dropped rather than
 * carried as `NaN`, which would compare false against every class and quietly
 * turn an allow-list into a refusal.
 */
function readIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is number => Number.isInteger(id) && (id as number) > 0);
}

/**
 * The item's own gate on who may use it, for the edge that spends it —
 * `Requirement.usableBy`, or nothing where the realm gates it on nobody.
 */
function useGateOf(item: WorldItem): { usableBy: ItemUseGate } | Record<never, never> {
  const gate: ItemUseGate = {
    ...(item.classes === undefined ? {} : { classes: item.classes }),
    ...(item.races === undefined ? {} : { races: item.races }),
    ...(item.minLevel === undefined ? {} : { minLevel: item.minLevel })
  };
  return Object.keys(gate).length === 0 ? {} : { usableBy: gate };
}

/**
 * Which half of an item's use gate this traveller fails, or null — through
 * `equipBlock`, the one rule for who may use a thing, so the card that greys
 * a token out and the router that refuses to plan it cannot disagree. The
 * names tables are the card's concern; a block here is named by
 * `blocksAlong`.
 */
function useGateShut(
  requirement: Requirement,
  traveller: Traveller
): 'class' | 'race' | 'level' | null {
  if (requirement.usableBy === undefined) return null;
  const wearer: Wearer = {
    classId: traveller.classId ?? null,
    raceId: traveller.raceId ?? null,
    level: traveller.level ?? null,
    strength: null,
    classNames: {},
    raceNames: {}
  };
  const shut = equipBlock(requirement.usableBy, wearer);
  // Strength is a weapon's, and a use gate carries none.
  return shut === null || shut.kind === 'strength' ? null : shut.kind;
}

/** A block's identity across two explanations of one refusal: the edge. */
function blockKey(block: RouteBlock): string {
  return 'at' in block && 'to' in block ? `${block.kind}|${block.at}|${block.to}` : block.kind;
}

/** A table as `{ id: name }`. Built per call: fifteen entries, and a lookup is a click. */
function namesById(rows: readonly { id: number; name: string }[]): Record<number, string> {
  const names: Record<number, string> = {};
  for (const row of rows) names[row.id] = row.name;
  return names;
}

/**
 * The row the realm names, or null. Shared by races and classes.
 *
 * Case-insensitive and trimmed, because the two sides are the stat sheet's word
 * and the database's, written by different people years apart.
 */
function rowNamed<T extends { name: string }>(rows: readonly T[], name: string): T | null {
  const key = name.trim().toLowerCase();
  if (key.length === 0) return null;
  return rows.find((row) => row.name.trim().toLowerCase() === key) ?? null;
}

/** The row id of the entry with this name, or null. Shared by races and classes. */
function idNamed(rows: readonly { id: number; name: string }[], name: string): number | null {
  return rowNamed(rows, name)?.id ?? null;
}

/**
 * `BuiltItem.from` as the reader's own words — format 39.
 *
 * The converter writes the owner's kind (`npc`, `room`, `death`, which is what
 * the traversal calls them) and this turns each into the **act**: a word said
 * to a monster, a word said in a room, a monster killed. Parsed rather than
 * trusted, like every other boundary here — a kind the union does not name is
 * dropped, because a handover the client cannot describe is worse than one it
 * does not mention.
 *
 * The room *name* is not read here: it is a join against the room index, made
 * where the lookup is answered (`handoversOf`).
 */
function readHandovers(raw: unknown): ItemHandover[] {
  const KINDS: Record<string, ItemHandover['kind']> = {
    npc: 'asked',
    room: 'said',
    death: 'killed'
  };
  const found: ItemHandover[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const kind = KINDS[String(record['k'])];
    if (kind === undefined) continue;
    const who = String(record['w'] ?? '').trim();
    const room = String(record['at'] ?? '').trim();
    const say = (Array.isArray(record['say']) ? record['say'] : [])
      .map((word) => String(word).trim())
      .filter((word) => word.length > 0);
    found.push({
      kind,
      ...(who.length > 0 ? { who } : {}),
      ...(/^\d+\/\d+$/.test(room) ? { room } : {}),
      ...(say.length > 0 ? { say } : {})
    });
  }
  return found;
}

function readItemKind(record: Record<string, unknown>, item: WorldItem): void {
  const type = Number(record['type']);
  if (!Number.isInteger(type)) return;
  const kind = itemKind(type);
  if (kind !== null) item.kind = kind;

  const worn = Number(record['worn']);
  if (Number.isInteger(worn) && worn > 0) item.worn = worn;
  const slot = Number.isInteger(worn) ? WORN_SLOT[worn] : undefined;
  if (slot !== undefined) item.slot = slot;

  /*
   * Any non-zero count, so the realm's `-1` — unlimited — comes back as the
   * fact it is rather than as an absence indistinguishable from silence. A
   * realm converted before format 25 states none, which reads as *unstated*
   * and is correct for it: it is not claiming the item is limited either.
   */
  const uses = Number(record['uses']);
  if (Number.isFinite(uses) && uses !== 0) item.uses = uses;

  const wpn = record['wpn'];
  if (kind === 'weapon' && typeof wpn === 'object' && wpn !== null) {
    const raw = wpn as Record<string, unknown>;
    const weapon: NonNullable<WorldItem['weapon']> = {
      min: Number(raw['min']) || 0,
      max: Number(raw['max']) || 0
    };
    const spd = Number(raw['spd']);
    if (Number.isFinite(spd) && spd > 0) weapon.speed = spd;
    const str = Number(raw['str']);
    if (Number.isFinite(str) && str > 0) weapon.strength = str;
    const acc = Number(raw['acc']);
    if (Number.isFinite(acc) && acc > 0) weapon.accuracy = acc;
    const weaponType = Number(raw['kind']);
    const word = Number.isInteger(weaponType) ? WEAPON_TYPE[weaponType] : undefined;
    if (word !== undefined) weapon.type = word;
    // The half of `WeaponType` a reader acts on, kept apart from the word:
    // a two-handed weapon leaves no off-hand slot.
    const held = Number.isInteger(weaponType) ? WEAPON_CLASS[weaponType] : undefined;
    if (held !== undefined) weapon.hands = held.hands;
    item.weapon = weapon;
  }

  const arm = record['arm'];
  if (kind === 'armour' && typeof arm === 'object' && arm !== null) {
    const raw = arm as Record<string, unknown>;
    const armour: NonNullable<WorldItem['armour']> = {};
    const ac = Number(raw['ac']);
    if (Number.isFinite(ac) && ac > 0) armour.ac = ac;
    const dr = Number(raw['dr']);
    if (Number.isFinite(dr) && dr > 0) armour.dr = dr;
    const armourType = Number(raw['kind']);
    const material = Number.isInteger(armourType) ? ARMOUR_TYPE[armourType] : undefined;
    if (material !== undefined) armour.material = material;
    item.armour = armour;
  }
}
