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
import zlib from 'node:zlib';

import { t } from '../app/i18n';
import { describeObstacle } from './obstacle';
import { parseInstruction } from './instructions';
import type { BuiltExit } from './buildRealm';
import type { Quest, QuestSource, QuestStep } from '../../shared/quests';
import {
  type WorldLair,
  asRoomReference,
  DIRECTIONS,
  DIRECTION_COMMAND,
  describeBlock,
  mobKey,
  roomId,
  type RouteBlock,
  type Direction,
  type Requirement,
  type Route,
  type RouteStep,
  type RoomId,
  type WorldExit,
  type WorldItem,
  type WorldLookup,
  type ShopPlace,
  type MobPlaces,
  type MobSpawn,
  type RequirementAction,
  openableHere,
  parseLair,
  type WorldShop,
  type WorldShopItem,
  hazardAvoided,
  type RouteHazard,
  type SpellHazard,
  type WorldSpell,
  type WorldRace,
  type WorldClass,
  type WorldMob,
  type MobAttack,
  type MobCast,
  type MobProfile,
  type WorldNames,
  type RoomCommand,
  type RemoteLever,
  type WorldRoom,
  type ShopKind,
  shopKind
} from '../../shared/world';
import { alignmentRank, type Alignment } from '../../shared/alignment';
import { HAZARD_ABILITY, abilityShape } from '../../shared/abilities';
import { dispositionFromCode, mobNameCandidates, type MobDisposition } from '../../shared/mobs';
import {
  ARMOUR_TYPE,
  WEAPON_CLASS,
  WEAPON_TYPE,
  WORN_SLOT,
  bareName,
  itemKind
} from '../../shared/items';
import { tuning } from '../app/tuning';
import { spellTargeting } from '../../shared/spellcraft';
import type { ExitEntity, ItemEntity, MobEntity, NpcEntity } from '../../shared/entities';
import type { RoomExit } from '../../shared/character';
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
  kind: 'key' | 'level' | 'toll' | 'class' | 'race' | 'alignment' | 'item';
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
      if (wanted === undefined || traveller.keys?.includes(wanted)) return null;
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

export function edgePenalty(requirement: Requirement | null, traveller: Traveller): number | null {
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
       * `Rune`, `Mandos Quest`, `GuildmasterQuest`) that the wire states
       * nowhere: the server reads `GetAbility(id).Sum`, which folds the race,
       * the class, everything worn and everything running, and no listing this
       * client can ask for prints it. So it stays discouraged, and the chip
       * carries the realm's own words for a person to judge by.
       */
      return requirement.abilityId === undefined ? 0 : UNEVALUATED;

    case 'cast':
      /*
       * **A cast exit never refuses anybody**, and 217 of the shipped realm's
       * 293 move the character somewhere the exit table does not name.
       *
       * `CastExit.CanMoveThroughExit` returns `true` unconditionally and
       * `TryMoveThroughExit` moves first and casts second (a reading of the
       * server's source, not a capture). So the old flat discouragement was
       * wrong twice over: it priced 76 plain corridors as half-walls, and it
       * priced a scatter maze as a corridor.
       *
       * `relocates` is a wall rather than a prune, and the reason is the
       * character standing inside one: pruning every scattering exit makes the
       * gloomy maze unroutable and strands whoever is in it, where a wall
       * leaves a way out that the walker re-plans from after each unexpected
       * arrival — which is how anybody gets out of a scatter maze. It is not a
       * refusal, so nothing writes the corridor off.
       *
       * `script` keeps the old discouragement, and that is the honest answer
       * rather than an unchanged one: the spell hands the character a
       * `TextBlock` this client does not convert, 40 of the 56 are called
       * `pyramid 4 arch fail`, and a script named *fail* is a gate under
       * another name.
       */
      if (requirement.spellEffect === 'relocates') return tuning().world.wallCost;
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
      if (requirement.spellEffect === 'relocates') return tuning().world.wallCost;
      if (requirement.spellEffect === 'script') return UNEVALUATED;
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
   * Each row's own profile and disposition, by row number — format 31.
   *
   * A name off the wire folds every row sharing it (`mobs`); a lair names a
   * row. `null` in the first is a row that states no attack; a row absent
   * from either is a file written before the format, and falls back to the
   * fold. See `lairEntities`.
   */
  private readonly rowProfiles = new Map<number, MobProfile | null>();
  private readonly rowDispositions = new Map<number, MobDisposition | null>();
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
    return rows === undefined || rows.length !== 1 ? null : rows[0]!;
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
  buildMobEntity(rawName: string, observed: { charmed?: boolean } = {}): MobEntity {
    const raw = rawName.trim();
    /*
     * Least stripping first. `MobNameModifierType` hangs a whole run of words
     * off either end, so `small elite guardsman` has to reach `guardsman` —
     * and the ladder is ordered so the *longest* name that matches wins,
     * because a shorter one is a different monster whose disposition decides
     * whether the client swings. One rule, shared with the classifier, or the
     * two ends of the client disagree about what the realm knows.
     */
    let known: WorldMob | undefined;
    for (const candidate of mobNameCandidates(raw)) {
      known = this.mob(candidate);
      if (known !== undefined) break;
    }
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

    entity.hp = known.hp;
    if (known.span !== undefined) entity.span = known.span;
    if (known.armour !== undefined) entity.armour = known.armour;
    if (known.damageResist !== undefined) entity.damageResist = known.damageResist;
    if (known.magicResist !== undefined) entity.magicResist = known.magicResist;
    if (known.experience !== undefined) entity.experience = known.experience;
    if (known.regen !== undefined) entity.regen = known.regen;
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
    const entity: NpcEntity = {
      name: known.name,
      source: 'mdb',
      id: room.npcId,
      disposition: known.disposition,
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
          entity.obstacle = describeObstacle(match.requirement, this);
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

  /**
   * What a room's lair spawns, resolved.
   *
   * The descriptor is verbatim realm data — `(Max 2): 781,190,` — and the
   * numbers are the only key the room table has for its monsters. Resolved
   * here rather than at build time so the descriptor stays what the realm
   * said, and a realm built before v9 simply answers nothing.
   */
  lairOf(room: WorldRoom): WorldMob[] {
    return this.lair(room)?.mobs ?? [];
  }

  /**
   * The lair whole: how many at once, and what. Null only for a room the
   * realm does not mark as one — the same test the map's glyph makes, so the
   * two cannot disagree. A descriptor naming no monster this table knows
   * (a derivative that added monsters after this data was built) comes back
   * with an empty list rather than null, so the face can say *that* instead
   * of the map promising a lair the card silently declines to show.
   */
  lair(room: WorldRoom): WorldLair | null {
    if (!room.lair) return null;
    // `parseLair` reads the descriptor, and reads *only* the monster numbers in
    // it — see its own note for the four that were being invented per lair.
    const { max, ids } = parseLair(room.lair);
    const mobs: WorldMob[] = [];
    for (const id of ids) {
      const mob = this.mobsById.get(id);
      if (mob && !mobs.includes(mob)) mobs.push(mob);
    }
    return { max, mobs };
  }

  /**
   * What a room's lair spawns, weighed as the rows the lair names.
   *
   * `lair()` answers by name, which is right for a readout — the card says
   * what *a* gnoll scout is — and wrong for a price: a name folds every row
   * sharing it and takes the worst, and the guard post on the Hillside Path
   * names row 224, a 100-HP scout that lands one blow in twenty-five against
   * a level-12 Paladin, not row 2204, the 830-HP one that swings four times a
   * round. Weighed by name the room was expected to kill a character it could
   * barely scratch (todo 01, 2026-09-10).
   *
   * So each row's own profile and disposition (format 31) replace the fold's
   * here, and only here: the wire never carries a row number, so a monster
   * *standing in the room* is still weighed by name. A file written before
   * the format has nothing per row and degrades to the fold, which is the
   * dangerous reading rather than the reassuring one. Empty for a room that
   * is not a lair, and for a descriptor naming rows this table lacks.
   */
  lairEntities(room: WorldRoom): MobEntity[] {
    if (!room.lair) return [];
    const entities: MobEntity[] = [];
    for (const id of parseLair(room.lair).ids) {
      const mob = this.mobsById.get(id);
      if (mob === undefined) continue;
      const entity = this.buildMobEntity(mob.name);
      if (this.rowProfiles.has(id)) {
        const own = this.rowProfiles.get(id);
        entity.profiles = own === null || own === undefined ? [] : [own];
      }
      if (this.rowDispositions.has(id)) {
        entity.disposition = this.rowDispositions.get(id) ?? null;
        // One row is certain about itself; the fold's doubt was about its twins.
        entity.uncertain = false;
      }
      entities.push(entity);
    }
    return entities;
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
  hazardOf(room: WorldRoom): SpellHazard | null {
    if (room.spell === undefined) return null;
    return this.spellById(room.spell)?.hazard ?? null;
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
    const found: MobSpawnRoom[] = [];
    /*
     * A name can hold several of the realm's rows — five `cocoon`s — and each
     * row is placed separately, so every id behind the name contributes. The
     * mob index is keyed by name and `mobsById` maps the ids onto it, so this
     * asks the id index which of its entries *is* this mob rather than keeping
     * a third index of name → ids.
     */
    for (const [id, rooms] of this.mobRooms()) {
      if (this.mobsById.get(id) !== mob) continue;
      found.push(...rooms);
    }
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
        targeting: spellTargeting(spell.targets)
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
  lookup(query: string, limit = 12): WorldLookup {
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

    return {
      mobs,
      items: best(
        [...this.itemsByName.values()].map((item) => [item.name.toLowerCase(), item] as const)
      ),
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
          const price = Number(record['price']);
          if (Number.isFinite(price) && price > 0) item.price = price;
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
    graph.linkLevers();
    return graph;
  }

  /**
   * Gives the router the room-script teleports it can honestly price.
   *
   * The scripts have been on `WorldRoom.commands` since format 13, card-only,
   * with the routing half deferred (mme.md §6). What is linked now is the
   * tranche whose conditions the router can genuinely evaluate against the
   * traveller: a destination the dataset holds, and guards that are nothing
   * but `minlevel`/`maxlevel` — 60 of the shipped realm's 249 teleport
   * commands. The rest (`nomonsters`, `roomitem`, `testskill`, …) are
   * conditions about the moment or the pack that this client cannot read at
   * plan time, and a route through a guess is how a character is walked
   * somewhere it cannot get back from; they stay facts the Room card states.
   */
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
        let readable = true;
        for (const entry of command.need ?? []) {
          const [verb, value] = entry.trim().split(/\s+/);
          const figure = Number(value);
          if (verb === 'minlevel' && Number.isInteger(figure)) minLevel = figure;
          else if (verb === 'maxlevel' && Number.isInteger(figure)) maxLevel = figure;
          else {
            readable = false;
            break;
          }
        }
        if (!readable) continue;

        const gated = minLevel !== undefined || maxLevel !== undefined;
        const requirement: Requirement = {
          // A level gate prices and blocks exactly as an exit's `Level:` does;
          // an unguarded portal is a `Text:` exit in everything but the table
          // it came from — a different command, no obstacle.
          kind: gated ? 'level' : 'text',
          raw: [phrase, ...(command.need ?? [])].join('; '),
          commands: [...command.say],
          ...(minLevel !== undefined ? { minLevel } : {}),
          ...(maxLevel !== undefined ? { maxLevel } : {})
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
        const lever: RemoteLever = { at: id, roomName: room.name, say: phrase };
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
      // Format 31: the row's own answers ride beside its number, one entry
      // per row, and are read only where the writer kept them in step.
      // And only where every written profile was read back, or the indexes
      // would point one along: `readProfiles` drops a row it cannot read.
      const byRow =
        Array.isArray(record['pr']) &&
        record['pr'].length === ids.length &&
        Array.isArray(record['pf']) &&
        record['pf'].length === profiles.length;
      const howByRow = typeof record['pd'] === 'string' && record['pd'].length === ids.length;
      for (const [k, id] of ids.entries()) {
        this.mobsById.set(id, mob);
        if (byRow) {
          const at = (record['pr'] as unknown[])[k];
          this.rowProfiles.set(id, typeof at === 'number' ? (profiles[at] ?? null) : null);
        }
        if (howByRow)
          this.rowDispositions.set(id, dispositionFromCode((record['pd'] as string)[k]));
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
      if (shops.size === 0 && mobs.size === 0) continue;
      const source: QuestSource = { id };
      if (shops.size > 0) source.shops = [...shops];
      if (mobs.size > 0) source.mobs = [...mobs];
      sources.push(source);
    }
    if (sources.length > 0) joined.sources = sources;
    return joined;
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
  private resolveSpells(requirement: Requirement): void {
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
    let effect: 'relocates' | 'script' | 'plain' = 'plain';
    let harm = 0;
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
        if (ability === HAZARD_ABILITY.teleportRoom || ability === HAZARD_ABILITY.teleportMap) {
          effect = 'relocates';
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
    requirement.spellEffect = effect;
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
      if (requirement !== null) this.resolveSpells(requirement);
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
    if (typeof raw['sp'] === 'number' && raw['sp'] > 0) result.spell = raw['sp'];
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

    const found = this.search(from, to, goal, traveller, false);
    if (found) {
      const route = this.buildRoute(found.cameFrom, to, found.cost, traveller);
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
        options.alternatives === true ? this.otherWay(from, to, goal, route, traveller) : null;
      const equipped =
        options.alternatives === true ? this.carrying(from, to, goal, route, traveller) : null;
      const planned: Route = {
        ...route,
        ...(other === null ? {} : { otherWay: other }),
        ...(equipped === null ? {} : { carrying: equipped })
      };
      if (found.cost >= tuning().world.wallCost) {
        const opened = this.search(from, to, goal, traveller, true);
        if (opened !== null && opened.cost < found.cost) {
          const blocks = this.blocksAlong(opened.cameFrom, to, traveller);
          if (blocks.length > 0) return { ...planned, blocks };
        }
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
    const ignoring = this.search(from, to, goal, traveller, true);
    const blocks = ignoring ? this.blocksAlong(ignoring.cameFrom, to, traveller) : [];
    const reasons = blocks.length > 0 ? blocks : ([{ kind: 'unreachable' }] as RouteBlock[]);
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
   * (`deadly`), and a room whose own spell takes a real share of the bar
   * (`otherWayShare`). A door or a toll is not — those are conditions the
   * reader can clear, and the refusal already names them (`Route.blocks`).
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
    traveller: Traveller
  ): Route | null {
    const { otherWayShare } = tuning().world;
    const worst = new Set<RoomId>();
    for (const step of route.steps) {
      if (step.deadly === true || (step.hazard ?? 0) >= otherWayShare) worst.add(step.to);
    }
    if (worst.size === 0) return null;
    // The destination itself is never avoidable: a route that refused to enter
    // the room it is planned to is not a route.
    worst.delete(to);
    if (worst.size === 0) return null;

    /*
     * **With the gates open**, like the search that explains a refusal. A way
     * round a room expected to kill is very often a door this character cannot
     * open — and pruning that door means finding nothing and saying *there is
     * no other way* about a route that exists and merely wants a key. What is
     * impassable is priced rather than removed, and named below.
     */
    const round = this.search(from, to, goal, { ...traveller, avoid: worst }, true);
    if (round === null) return null;
    const other = this.buildRoute(round.cameFrom, to, round.cost, traveller);
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
    const blocks = this.blocksAlong(round.cameFrom, to, traveller);
    /*
     * Handed back with no `otherWay` of its own: an alternative is read and
     * chosen, never used to plan a third. `buildRoute` sets none, so this is a
     * statement about what is *not* done rather than something to strip.
     */
    return blocks.length > 0 ? { ...other, blocks } : other;
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
  private carrying(
    from: RoomId,
    to: RoomId,
    goal: WorldRoom,
    route: Route,
    traveller: Traveller
  ): Route | null {
    const priced = traveller.hazard;
    if (priced === undefined) return null;
    const quietened = (room: WorldRoom): boolean => {
      const hazard = this.hazardOf(room);
      return (
        hazard !== null &&
        (hazard.avoidedBy?.length ?? 0) > 0 &&
        !hazardAvoided(hazard, traveller.keys)
      );
    };
    const equipped: Traveller = {
      ...traveller,
      hazard: (room) => (quietened(room) ? null : priced(room))
    };
    const found = this.search(from, to, goal, equipped, false);
    if (found === null) return null;
    const other = this.buildRoute(found.cameFrom, to, found.cost, equipped);
    if (route.steps.length - other.steps.length < tuning().world.alternativeMinSteps) return null;
    if (other.steps.some((step) => step.deadly === true)) return null;
    const crosses = other.steps.some((step) => {
      const room = this.rooms.get(step.to);
      return room !== undefined && quietened(room);
    });
    return crosses ? other : null;
  }

  /**
   * One A* pass. `openGates` prices the three impassable conditions instead of
   * pruning them, which is how the failed case finds a path to explain itself.
   */
  private search(
    from: RoomId,
    to: RoomId,
    goal: WorldRoom,
    traveller: Traveller,
    openGates: boolean
  ): {
    cameFrom: Map<RoomId, { prev: RoomId; exit: WorldExit | PortalExit }>;
    cost: number;
  } | null {
    /*
     * A step along a preferred route costs a fraction of an ordinary one. The
     * cross-map heuristic is that same fraction while any route is preferred,
     * because the one edge it stands for may be a preferred one: a heuristic
     * above the cheapest possible step is no longer admissible, and A* would
     * pop the goal before the cheaper way had been relaxed.
     */
    const preferring = traveller.preferred !== undefined && traveller.preferred.size > 0;
    const discount = preferring ? tuning().world.preferredStepCost : 1;
    const heuristic = (room: WorldRoom): number => (room.map === goal.map ? 0 : discount);

    const cameFrom = new Map<RoomId, { prev: RoomId; exit: WorldExit | PortalExit }>();
    const best = new Map<RoomId, number>([[from, 0]]);
    const open = new MinHeap<RoomId>();
    open.push(heuristic(this.rooms.get(from)!), from);

    while (open.size > 0) {
      const currentId = open.pop()!;
      if (currentId === to) return { cameFrom, cost: best.get(to) ?? 0 };

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
        const nextId = roomId(exit.map, exit.room);
        const next = this.rooms.get(nextId);
        // An exit pointing outside the dataset is a hole in the data, not a
        // route; following it would produce a step that cannot be walked.
        if (!next) continue;
        // The one pruning this router does on the traveller's account, and
        // only while it is answering *is there another way*. See `avoid`.
        if (traveller.avoid?.has(nextId) === true) continue;

        const priced = edgePenalty(exit.requirement, traveller);
        // A gate held open is still the worst edge on the map, so the path this
        // finds is the one that was *nearly* walkable rather than a detour
        // through every locked door in the realm.
        const penalty = priced === null ? (openGates ? tuning().world.wallCost : null) : priced;
        if (penalty === null) continue;

        // A portal costs its penalty over a plain step, so the router prefers
        // ordinary corridors unless the teleport genuinely shortens the way.
        const surcharge = exit.direction === 'portal' ? tuning().world.portalPenalty : 0;
        const wall = traveller.refused?.has(`${currentId}|${exit.direction}`) ? 100_000 : 0;
        // The whole step — the door's price and the portal's with it — is
        // discounted along a saved route: the player chose that door. A
        // refusal is not, because the server said no this session.
        const along =
          preferring && traveller.preferred!.has(`${currentId}|${nextId}`) ? discount : 1;
        // And what is waiting in the room being stepped into: a lair priced
        // against this character, or nothing where nothing can be weighed.
        const risk = traveller.danger === undefined ? 0 : dangerPenalty(traveller.danger(next));
        /*
         * And what the room itself does to whoever stands in it. Priced on the
         * same slope as a lair and for the same reason — the step from
         * *unpleasant* to *fatal* is continuous — but it is a **certainty**
         * rather than a fight that might be walked past, which is why it is
         * added rather than taken as the worse of the two: a poisoned lair is
         * both.
         */
        const room = traveller.hazard === undefined ? 0 : dangerPenalty(traveller.hazard(next));
        const tentative = currentCost + (1 + penalty + surcharge + risk + room) * along + wall;
        if (tentative >= (best.get(nextId) ?? Infinity)) continue;

        best.set(nextId, tentative);
        cameFrom.set(nextId, { prev: currentId, exit });
        open.push(tentative + heuristic(next), nextId);
      }
    }
    return null;
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
          blocks.unshift({
            kind: 'level',
            at: prev,
            to: cursor,
            name,
            level: traveller.level ?? null,
            ...(requirement.minLevel === undefined ? {} : { minLevel: requirement.minLevel }),
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
          const admits =
            blocked.kind === 'alignment'
              ? requirement.minAlignment === undefined
                ? undefined
                : `${requirement.minAlignment} to ${requirement.maxAlignment ?? requirement.minAlignment}`
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
      }
      cursor = prev;
    }
    return blocks;
  }

  private buildRoute(
    cameFrom: Map<RoomId, { prev: RoomId; exit: WorldExit | PortalExit }>,
    to: RoomId,
    cost: number,
    traveller: Traveller
  ): Route {
    const steps: RouteStep[] = [];
    let cursor = to;

    while (cameFrom.has(cursor)) {
      const { prev, exit } = cameFrom.get(cursor)!;
      const destination = this.rooms.get(cursor);
      // The figure the step was priced by, so the panel can say what waits
      // there rather than only what the walk costs in total.
      const danger =
        destination === undefined || traveller.danger === undefined
          ? null
          : traveller.danger(destination);
      const hazard =
        destination === undefined || traveller.hazard === undefined
          ? null
          : traveller.hazard(destination);
      const lairDamage =
        destination === undefined || traveller.lairDamage === undefined
          ? null
          : traveller.lairDamage(destination);
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
        ...(exit.requirement ? { obstacle: describeObstacle(exit.requirement, this) } : {}),
        // Absent is not dark: `buildRealm` writes a level only when the realm
        // recorded a non-zero one.
        dark: destination?.light !== undefined && destination.light < 0,
        // And the level itself, for the light arithmetic: how dark decides
        // whether a torch is worth lighting, and `dark` alone cannot say.
        ...(destination?.light !== undefined && destination.light < 0
          ? { light: destination.light }
          : {}),
        ...(danger !== null && danger > 0 ? { danger } : {}),
        ...(lairDamage !== null && lairDamage > 0 ? { lairDamage } : {}),
        // And what the room itself does to whoever stands in it, by the same
        // rule and from the same call the router priced the step with.
        ...(hazard !== null && hazard > 0 ? { hazard } : {}),
        // And the word, where the share is a discouragement and not a figure.
        ...(hazard !== null && hazard > 0 && destination !== undefined
          ? hazardWordOf(this.hazardOf(destination))
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
          : {})
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
      const room = this.rooms.get(step.to);
      if (room?.spell === undefined) continue;
      const spell = this.spellById(room.spell);
      const hazard = spell?.hazard;
      if (spell === null || hazard === undefined) continue;
      if (hazardAvoided(hazard, traveller.keys)) continue;
      const seen = folded.get(spell.id);
      if (seen !== undefined) {
        seen.rooms += 1;
        continue;
      }
      folded.set(spell.id, {
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
    return [...folded.values()].sort(
      (a, b) => (b.share ?? 0) * b.rooms - (a.share ?? 0) * a.rooms || b.rooms - a.rooms
    );
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
  // Nothing stated at all is nothing to carry: the writer omits a spell whose
  // chain reaches no harm, so an empty object here is a row that says nothing.
  return Object.keys(hazard).length > 0 ? hazard : null;
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
