/**
 * A* over the room graph, and what an edge costs a traveller.
 *
 * Ported from `mudengine/src/engine/path.coffee` with two changes: every
 * instruction kind priced, where the original knew seven and treated the rest
 * as free (a `Text:` exit is a command, not a direction), and a real priority
 * queue, where it re-sorted the open list every iteration — O(n² log n) over
 * 55,806 rooms. Reads the realm as a `RoomIndex`, never as `WorldGraph` or
 * `Catalogue`; the graph keeps a one-line delegation per public method. The
 * decisions the prices encode: `mudengine-world` › `parts/routing.md`.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { describeObstacle } from './obstacle';
import type { PortalExit, RoomIndex } from './RoomIndex';
import { abilityName } from '../../shared/abilities';
import { alignmentRank, type Alignment } from '../../shared/alignment';
import { equipBlock, type Wearer } from '../../shared/gear';
import {
  abilityGatesMet,
  blockItem,
  describeBlock,
  DIRECTION_COMMAND,
  hazardAvoided,
  itemDemanded,
  landingRooms,
  openableHere,
  roomId,
  sameLanding,
  type Direction,
  type Landing,
  type Requirement,
  type RoomId,
  type Route,
  type RouteBlock,
  type RouteHazard,
  type RouteInvocation,
  type RouteScatter,
  type RouteStep,
  type SpellHazard,
  type WorldExit,
  type WorldRoom
} from '../../shared/world';

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
   * character's own loops (`Errands.preferredEdges`), and absent from
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
   * `Inventory.ItemStacks`. Filled by `Errands.travellerNow` from the
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
   * Which of those two the walker may spend: *Auto-Pick Locks* and *Auto-Bash
   * Doors* (`movement.pickLocks`, `movement.bashDoors`). A skill the walker
   * will not use is no way through, however high: planned on it, the walk
   * stops at the lock. Absent is both, which is every caller that is not a
   * session — the builder's drafts, the tests, a realm read without a
   * character.
   */
  forcing?: { pick: boolean; bash: boolean };
  /**
   * The ways and places this traveller keeps out of (`movement.keepOutOf`,
   * todo 806): a word a way's script phrase says, or a room's name does.
   * `allowed` are the words this walk may cross anyway — ones the player chose
   * to walk through, and ones the route starts or ends inside. The rest prune
   * an edge outright rather than price it, because a price is walked when
   * nothing else leads there — with the gates open too, since `otherWay` holds
   * them open to find a walkable way; only a refusal's explanation lifts them,
   * to name one. Every word, allowed or not, flags the step that crosses it
   * (`RouteStep.keptOut`). Absent keeps out of nothing.
   */
  keepOut?: { words: readonly string[]; allowed?: readonly string[] };
  /**
   * This character's `Classes` row id, for a class-gated exit.
   *
   * The stat sheet prints the realm's own word (`Class: Paladin`) and the
   * exit states a row id, so the join is `WorldGraph.classId` and it happens
   * once, at `Errands.travellerNow`. Null or absent means nobody has
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
   * it once at `Errands.travellerNow`. Two exits in the shipped realm
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

/** Handed back for the realm that scatters nobody, so no caller allocates to say "none". */
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
  /**
   * Whether a room the pass expanded has an exit demanding an item the
   * traveller does not hold. A* expands every room cheaper than the answer,
   * and holding an item only ever makes its own edges cheaper, so where this
   * is false no keyed way can beat the plan and `keyedWay` is not asked — the
   * extra search cost a panel route a fifth again on Paradigm.
   */
  keysAhead: boolean;
}

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
  // A channel the walker is not allowed to use is graded as no skill at all:
  // the wall, still walkable when nothing else leads there, never a price the
  // plan pays on the strength of a command nobody will send.
  const { pick, bash } = traveller.forcing ?? FORCING_BOTH;
  if (pickDifficulty !== undefined)
    costs.push(gradedCost(pick ? traveller.pickSkill : null, pickDifficulty, base));
  if (bashDifficulty !== undefined)
    costs.push(gradedCost(bash ? traveller.strength : null, bashDifficulty, base));
  return Math.min(...costs);
}

/**
 * Lower case and words only, padded: how a kept-out word is matched against
 * the realm's own text, so `vortex` finds `go vortex` and not `vortexes`.
 */
function plainWords(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/** A traveller's kept-out words, each with its matchable form. */
interface KeepOutWords {
  all: ReadonlyArray<{ word: string; plain: string }>;
  /** Those not allowed: the ones that prune. */
  pruning: ReadonlyArray<{ word: string; plain: string }>;
}

/** Whether two routes walk the same rooms in the same order. */
function sameSteps(a: Route, b: Route): boolean {
  return (
    a.steps.length === b.steps.length && a.steps.every((step, i) => step.to === b.steps[i]!.to)
  );
}

/** `Traveller.forcing` absent: both skills are the walker's to spend. */
const FORCING_BOTH = { pick: true, bash: true } as const;

/**
 * The skills a door names that the walker is switched off from using, for the
 * block that says so: *bashing doors is switched off* is a setting somebody
 * can change, where *you have 150 strength* against a 30 door reads as the
 * client contradicting itself.
 */
function switchedOff(
  requirement: Requirement,
  traveller: Traveller
): Array<'picklocks' | 'strength'> {
  const { pick, bash } = traveller.forcing ?? FORCING_BOTH;
  const off: Array<'picklocks' | 'strength'> = [];
  if (!pick && requirement.pickDifficulty !== undefined) off.push('picklocks');
  if (!bash && requirement.bashDifficulty !== undefined) off.push('strength');
  return off;
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

/**
 * Cost added by an edge's requirement, or `null` to prune it entirely.
 *
 * The numbers are relative and only have to order routes sensibly: a plain
 * corridor is 1, so a door at 12 means "worth a dozen extra rooms to avoid".
 * The original used −500 for a door, which is a *negative* cost and makes A*
 * prefer doors while breaking admissibility; that looks like a bug rather than
 * an intent, and it is not reproduced.
 */
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
       * Searchable costs the search — `Barriers.searchFor` sends it.
       *
       * An action-gated one costs the levers where the realm puts every one of
       * them in the room the exit leaves from, because `Levers.pullLevers`
       * sends those too: it is the same rung, priced the same way, one command
       * per lever. 150 of the shipped realm's 217 are that shape.
       *
       * Everything else stays expensive rather than impossible, which is what
       * this line has always said. The levers are somewhere else, and this
       * planner still does not plan the detour: `Levers.fetchLever` makes it
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
       * `Errands.refusedEdges` then wrote a **real** corridor off for
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
       * (`Router.beyond`). It was a wall while the destination was
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
       * `WorldGraph.resolveSpells` read off the realm's own spell table rather
       * than out of the instruction string.
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
       * refusal and has `Errands.refusedEdges` write a real corridor off
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

/**
 * A* and the sweeps beside it over one realm's rooms, with what each caches.
 * One per graph, which hands over its tables and the catalogue's rows as the index.
 */
export class Router {
  private readonly rooms: ReadonlyMap<RoomId, WorldRoom>;
  private readonly portals: ReadonlyMap<RoomId, readonly PortalExit[]>;
  private readonly spends: ReadonlyMap<PortalExit, Omit<RouteInvocation, 'at'>>;
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
  /** Every item the realm demands on an exit and names — `namedExitItems`. */
  private exitItems: readonly number[] | null = null;
  /** The rooms whose name says a kept-out word, per word — `roomsNamed`. */
  private namedRooms = new Map<string, ReadonlySet<WorldRoom>>();
  /** A traveller's kept-out words, prepared once per list — `keepOutOf`. */
  private keepOuts = new WeakMap<object, KeepOutWords>();
  /** An exit's script phrases in matchable form, per phrase list — `keptOut`. */
  private plainPhrases = new WeakMap<readonly string[], readonly string[]>();
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

  constructor(private readonly index: RoomIndex) {
    // Held rather than asked for: read on every edge of every search, and the
    // index fills its tables but never replaces one.
    this.rooms = index.roomsById;
    this.portals = index.portalsByRoom;
    this.spends = index.spendsByEdge;
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
   * back, and `RoomTracker.notice` wrote a permanent *discovery* of a way
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
    // Kept out of, from wherever this is asked: see `Traveller.keepOut`.
    const who = traveller === undefined ? undefined : this.insideOf(traveller, [from]);
    const open = (exit: WorldExit | PortalExit): boolean => {
      if (who === undefined) return true;
      const next = this.rooms.get(this.beyond(exit));
      return next === undefined || this.keptOut(who, exit, next) === null;
    };
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
                  edgePenalty(exit.requirement ?? null, traveller) !== null) &&
                open(exit)
            )
            .map((exit) => this.beyond(exit)),
          // And the same of a portal, which carries a `level` requirement of
          // its own where the realm gates one (`WorldGraph.linkPortals`).
          ...this.portalsFrom(id)
            .filter(
              (portal) =>
                (traveller === undefined ||
                  edgePenalty(portal.requirement ?? null, traveller) !== null) &&
                open(portal)
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
     * **The ways and places kept out of** (todo 806). A walk that starts or
     * ends inside one may cross it. For a reader, the way through is planned
     * with every word allowed and flagged, and where it crosses one the way
     * round is planned too and carried beside it: the player chooses. Walked
     * unwatched, the words prune.
     */
    if ((this.keepOutOf(traveller)?.pruning.length ?? 0) > 0) {
      traveller = this.insideOf(traveller, [from, to]);
      const pruning = this.keepOutOf(traveller)?.pruning ?? [];
      if (options.alternatives === true && pruning.length > 0) {
        const words = traveller.keepOut!.words;
        // Through them, with its alternatives kept out: those are offered
        // without the two cards, so none of them may cross a word unasked.
        const through = this.plan(
          from,
          to,
          goal,
          { ...traveller, keepOut: { words, allowed: words } },
          options,
          traveller
        );
        const crossed = [
          ...new Set(
            through.steps.flatMap((step) =>
              step.keptOut !== undefined && pruning.some(({ word }) => word === step.keptOut)
                ? [step.keptOut]
                : []
            )
          )
        ];
        if (through.blocked || crossed.length === 0) return through;
        /*
         * And where there is no way round without a key the player lacks, the
         * way round once it is fetched: the Dark-Elf Castle's four-key way by
         * the moat, against two vortexes and the Plane.
         */
        const round = this.plan(from, to, goal, traveller, {}, traveller);
        const unlocks = round.blocked
          ? this.keyedWay(from, to, goal, null, traveller, false)
          : null;
        return {
          ...through,
          keptOut: { words: crossed, round: unlocks === null ? round : { ...round, unlocks } }
        };
      }
    }
    return this.plan(from, to, goal, traveller, options, traveller);
  }

  /**
   * `route` past its checks and the kept-out choice: the plan for `traveller`,
   * and the alternatives a reader chooses between planned for `others` — the
   * same traveller, except on the way through what the player keeps out of,
   * whose alternatives keep out of it (todo 806).
   */
  private plan(
    from: RoomId,
    to: RoomId,
    goal: WorldRoom,
    traveller: Traveller,
    options: RouteOptions,
    others: Traveller
  ): Route {
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
        options.alternatives === true ? this.otherWay(from, to, goal, route, others, draws) : null;
      const equipped =
        options.alternatives === true ? this.carrying(from, to, goal, route, others, draws) : null;
      // And the way that spends a charge to skip the walk — offered, never
      // planned. See `Route.viaItem`.
      const invoked =
        options.alternatives === true ? this.viaItem(from, to, goal, route, others, draws) : null;
      // And a way that is simply not this one — asked for by name, over and
      // over, and defined by what it is not rather than by what it assumes.
      // See `Route.another`.
      const different =
        options.alternatives === true ? this.another(from, to, goal, route, others, draws) : null;
      // And the way through a door whose key is worth going to get. See
      // `Route.unlocks`.
      const keyed =
        options.alternatives === true && walkable.keysAhead
          ? this.keyedWay(from, to, goal, route, others, draws)
          : null;
      const planned: Route = {
        ...route,
        ...(other === null ? {} : { otherWay: other }),
        ...(equipped === null ? {} : { carrying: equipped }),
        ...(invoked === null ? {} : { viaItem: invoked }),
        ...(different === null ? {} : { another: different }),
        ...(keyed === null ? {} : { unlocks: keyed })
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
    /*
     * The explanation crosses what the player keeps out of, so a refusal on
     * its account names the word (`keptOut` blocks) rather than calling two
     * joined rooms unjoined; `blocksAlong` reads the words that prune.
     */
    const words = traveller.keepOut?.words;
    const explaining: Traveller =
      words === undefined ? traveller : { ...traveller, keepOut: { words, allowed: words } };
    const ignoring = this.search(
      from,
      to,
      goal,
      explaining,
      true,
      walkable.drawsAhead,
      false
    ).found;
    const blocks = ignoring ? this.blocksAlong(ignoring.cameFrom, to, traveller) : [];
    const invoked =
      walkable.landingsAhead && this.landingsReach().has(to)
        ? this.search(from, to, goal, explaining, true, walkable.drawsAhead, true).found
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
    /*
     * And what fetching would open: the way once the pack holds what the
     * refusal names, where those items alone are enough — else the realm asked
     * as though every key it names were carried, since the path that explains
     * a refusal can end at a door no key opens while a keyed way goes round.
     * Only for a reader, like every other alternative, and only for a refusal
     * a door or an item explains: an exhaustive search holding every key, for
     * two rooms nothing joins, was a fifth of the panel's planning time.
     */
    const doors = blocks.some(
      (block) => block.kind === 'key' || block.kind === 'door' || block.kind === 'carry'
    );
    const unlocks =
      options.alternatives === true && doors
        ? (this.unlocked(from, to, goal, others, blocks, walkable.drawsAhead) ??
          this.keyedWay(from, to, goal, null, others, walkable.drawsAhead))
        : null;
    return {
      steps: [],
      cost: 0,
      blocked: true,
      // Still a sentence, because everything that already reads `reason` goes
      // on working; the facts are beside it for anything that wants more.
      reason: reasons.map(describeBlock).join('; '),
      blocks: reasons,
      ...(unlocks === null ? {} : { unlocks })
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
    if (this.index.itemLandings().length === 0) return null;
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
      const hazard = this.index.hazardOf(room, traveller.level);
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

  /** A traveller's kept-out words, prepared once per list. See `Traveller.keepOut`. */
  private keepOutOf(traveller: Traveller): KeepOutWords | null {
    const keepOut = traveller.keepOut;
    if (keepOut === undefined || keepOut.words.length === 0) return null;
    let prepared = this.keepOuts.get(keepOut);
    if (prepared === undefined) {
      const allowed = new Set((keepOut.allowed ?? []).map(plainWords));
      const all = keepOut.words
        .map((word) => ({ word, plain: plainWords(word) }))
        .filter(({ plain }) => plain.trim().length > 0);
      prepared = { all, pruning: all.filter(({ plain }) => !allowed.has(plain)) };
      this.keepOuts.set(keepOut, prepared);
    }
    return prepared;
  }

  /** Every room whose name says this word — built once per word. */
  private roomsNamed(plain: string): ReadonlySet<WorldRoom> {
    let found = this.namedRooms.get(plain);
    if (found === undefined) {
      const rooms = new Set<WorldRoom>();
      for (const room of this.rooms.values()) {
        if (plainWords(room.name).includes(plain)) rooms.add(room);
      }
      found = rooms;
      this.namedRooms.set(plain, found);
    }
    return found;
  }

  /**
   * The kept-out word this step crosses — into a room whose name says it, or
   * by a way whose script phrase does — of the words that prune, or of all of
   * them (`every`). Null for none.
   */
  private keptOut(
    traveller: Traveller,
    exit: WorldExit | PortalExit,
    into: WorldRoom,
    every = false
  ): string | null {
    const prepared = this.keepOutOf(traveller);
    if (prepared === null) return null;
    const commands = exit.requirement?.commands;
    let phrases: readonly string[] | undefined;
    if (commands !== undefined) {
      phrases = this.plainPhrases.get(commands);
      if (phrases === undefined) {
        phrases = commands.map(plainWords);
        this.plainPhrases.set(commands, phrases);
      }
    }
    const find = (words: KeepOutWords['all']): string | null => {
      for (const { word, plain } of words) {
        if (this.roomsNamed(plain).has(into)) return word;
        if (phrases?.some((phrase) => phrase.includes(plain)) === true) return word;
      }
      return null;
    };
    // A word that still prunes first, so a step crossing two says the one
    // this walk may not cross whatever order the list is in.
    const pruned = find(prepared.pruning);
    return pruned !== null || !every ? pruned : find(prepared.all);
  }

  /**
   * This traveller allowed whatever these rooms are inside: a walk that
   * starts or ends in a place kept out of may cross it, since the character
   * is there or asked to go.
   */
  private insideOf(traveller: Traveller, rooms: readonly RoomId[]): Traveller {
    const prepared = this.keepOutOf(traveller);
    if (prepared === null || prepared.pruning.length === 0) return traveller;
    const places = rooms.flatMap((id) => {
      const room = this.rooms.get(id);
      return room === undefined ? [] : [room];
    });
    const inside = prepared.pruning.filter(({ plain }) =>
      places.some((room) => this.roomsNamed(plain).has(room))
    );
    if (inside.length === 0) return traveller;
    const keepOut = traveller.keepOut!;
    return {
      ...traveller,
      keepOut: {
        words: keepOut.words,
        allowed: [...(keepOut.allowed ?? []), ...inside.map(({ word }) => word)]
      }
    };
  }

  /**
   * The way a refused route would take once the pack holds what refused it.
   *
   * Only where **every** block is an item the realm names: a key and a level
   * gate on one way is a key that ends the errand at the gate. Planned for
   * real, holding them all, rather than assumed from the gates-open path,
   * because a second lock nobody reached can stand behind the first.
   */
  private unlocked(
    from: RoomId,
    to: RoomId,
    goal: WorldRoom,
    traveller: Traveller,
    blocks: readonly RouteBlock[],
    draws: boolean
  ): Route | null {
    if (blocks.length === 0) return null;
    const needs = new Map<number, { id: number; name: string }>();
    for (const block of blocks) {
      const item = blockItem(block);
      if (item === null) return null;
      needs.set(item.id, item);
    }
    for (const id of needs.keys()) {
      if (this.fetchPrice(id, from, this.holdingOthers(traveller, needs.keys(), id)) === null) {
        return null;
      }
    }
    const held = [...needs.keys()].reduce((who, item) => this.holding(who, item), traveller);
    const found = this.search(from, to, goal, held, false, draws).found;
    if (found === null || found.cost >= tuning().world.wallCost) return null;
    return {
      ...this.buildRoute(found.cameFrom, to, found.cost, held, draws),
      needs: [...needs.values()]
    };
  }

  /**
   * The way through a door this character holds no key for — `Route.unlocks`
   * (todo 805).
   *
   * A locked door the character cannot open is pruned or walled, and either
   * way it loses to any way round however long: 155 steps against one,
   * standing at the black star key's door, and the key that opens it was never
   * weighed. So the journey is planned again as though every item the realm
   * names on an exit were carried, and what that way uses is what it needs.
   *
   * **The fetch is priced, never free**: `keyFetchTrips` times the walk to the
   * nearest room that stocks each item or places a monster that drops it
   * (`fetchPrice`). A drop is a fight and a chance, so this is a floor under
   * the errand rather than its cost — enough to stop the offer sending anybody
   * further for a key than the way round would have taken. Offered where that
   * total beats `plan` by `alternativeMinSteps`; for a refused route (`plan`
   * null) wherever it exists. An item nothing sources is not offered at all.
   * Never walled or deadly, and never the plan's own steps again.
   */
  private keyedWay(
    from: RoomId,
    to: RoomId,
    goal: WorldRoom,
    plan: Route | null,
    traveller: Traveller,
    draws: boolean
  ): Route | null {
    const { alternativeMinSteps, keyFetchTrips, wallCost } = tuning().world;
    // A keyed way costs at least a step, so a plan this cheap cannot be beaten
    // by the margin — asked before the search, as `viaItem` asks.
    if (plan !== null && plan.cost <= alternativeMinSteps) return null;
    const carried = traveller.keys ?? [];
    const extra = this.namedExitItems().filter((id) => !carried.includes(id));
    if (extra.length === 0) return null;
    const equipped: Traveller = { ...traveller, keys: [...carried, ...extra] };
    // Bounded by what would have to be beaten, which also makes it cheaper
    // than the plan's own search: it expands only rooms the margin leaves in.
    const ceiling = plan === null ? Infinity : plan.cost - alternativeMinSteps;
    const found = this.search(from, to, goal, equipped, false, draws, false, ceiling).found;
    if (found === null || found.cost >= wallCost) return null;
    if (plan !== null && found.cost + alternativeMinSteps > plan.cost) return null;
    const route = this.buildRoute(found.cameFrom, to, found.cost, equipped, draws);
    if (route.steps.some((step) => step.deadly === true)) return null;
    const needs = new Map<number, { id: number; name: string }>();
    for (const step of route.steps) {
      const id = itemDemanded(step.requirement);
      if (id === null || carried.includes(id) || needs.has(id)) continue;
      const name = this.index.item(id)?.name.trim() ?? '';
      if (name.length === 0) return null;
      needs.set(id, { id, name });
    }
    if (needs.size === 0) return null;
    if (plan !== null && sameSteps(route, plan)) return null;
    let fetching = 0;
    for (const id of needs.keys()) {
      const price = this.fetchPrice(id, from, this.holdingOthers(traveller, needs.keys(), id));
      if (price === null) return null;
      fetching += keyFetchTrips * price;
    }
    if (plan !== null && found.cost + fetching + alternativeMinSteps > plan.cost) return null;
    return { ...route, needs: [...needs.values()] };
  }

  /**
   * This traveller holding every one of `needs` but `item` — how the errand,
   * which fetches them in turn, reaches a key that lies behind another's door.
   * Never `item` itself: a key behind its own door is not somewhere to go.
   */
  private holdingOthers(traveller: Traveller, needs: Iterable<number>, item: number): Traveller {
    const others = [...needs].filter((id) => id !== item);
    return others.length === 0
      ? traveller
      : { ...traveller, keys: [...(traveller.keys ?? []), ...others] };
  }

  /** Every item id the realm demands on an exit and names — built once. */
  private namedExitItems(): readonly number[] {
    if (this.exitItems !== null) return this.exitItems;
    const ids = new Set<number>();
    for (const room of this.rooms.values()) {
      for (const exit of room.exits) {
        const id = itemDemanded(exit.requirement ?? null);
        if (id !== null && (this.index.item(id)?.name.trim() ?? '').length > 0) ids.add(id);
      }
    }
    this.exitItems = [...ids];
    return this.exitItems;
  }

  /**
   * What reaching the nearest room where this item can be had costs, in the
   * router's units: a counter that stocks it, or a room the realm places a
   * monster that drops it. Null where the realm names none this traveller can
   * reach — which is not something to send anybody for.
   */
  private fetchPrice(item: number, from: RoomId, traveller: Traveller): number | null {
    const rooms = this.index.sourceRooms(item);
    if (rooms.size === 0) return null;
    let best: number | null = null;
    for (const { cost } of this.sweepTo(from, rooms, traveller).values()) {
      if (best === null || cost < best) best = cost;
    }
    return best;
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
  sweepTo(
    from: RoomId,
    wanted: ReadonlySet<RoomId>,
    traveller: Traveller
  ): Map<RoomId, { cost: number; moves: number }> {
    traveller = this.insideOf(traveller, [from]);
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
  sweepBack(
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
    traveller = this.insideOf(traveller, [...seeds.keys()]);
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
    // A way or a place kept out of is no way, gates open or not: `otherWay`
    // holds them open to find a way somebody may walk. A refusal's own
    // explanation lifts the words instead (`route`). See `Traveller.keepOut`.
    if (into !== null && this.keptOut(traveller, exit, into) !== null) return null;
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
    useLandings = false,
    /** A cost past which no answer is wanted — `keyedWay`'s bound. */
    ceiling = Infinity
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
    let keysAhead = false;
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
     * (`WorldGraph.linkItemLandings`), found by the ordinary search like any
     * other edge — which is the whole of the fix for *it is planning it from a
     * spot I am not in*. `WorldGraph.itemLandings()` withholds those, so this
     * cannot put the assumption back.
     *
     * The corollary is the reason `withinSteps` does not do this at all: the
     * hunting survey and the map ask *what is near*, and a room the whole
     * realm is one token away from is not a neighbour of anywhere. A bound
     * landing **is** counted there, correctly, because one move from `3/1`
     * really is one move.
     */
    if (useLandings) {
      for (const exit of this.index.itemLandings()) {
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
        return {
          found: { cameFrom, cost: best.get(to) ?? 0 },
          drawsAhead,
          landingsAhead: false,
          keysAhead
        };
      }

      const current = this.rooms.get(currentId);
      if (!current) continue;
      const currentCost = best.get(currentId) ?? Infinity;
      // The heap pops in order, so the first room past the ceiling means every
      // way left is past it too.
      if (currentCost + heuristic(current) > ceiling) break;

      // The room's exits, and any scripted teleports the router may walk —
      // one relaxation, because a portal is priced like any other gated edge.
      const scripted = this.portals.get(currentId);
      const ways: ReadonlyArray<WorldExit | PortalExit> = scripted
        ? [...current.exits, ...scripted]
        : current.exits;
      for (const exit of ways) {
        if (!keysAhead) {
          const item = itemDemanded(exit.requirement ?? null);
          keysAhead = item !== null && traveller.keys?.includes(item) !== true;
        }
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
      landingsAhead: this.index
        .itemLandings()
        .some((exit) => !best.has(roomId(exit.map, exit.room))),
      keysAhead
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
      // A way or place kept out of, which only a gates-open search crosses.
      const into = this.rooms.get(cursor);
      const kept = into === undefined ? null : this.keptOut(traveller, exit, into);
      if (kept !== null) {
        blocks.unshift({ kind: 'keptOut', at: prev, to: cursor, name: into!.name, word: kept });
      }
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
          const item = wanted === undefined ? undefined : this.index.item(wanted);
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
           * half-read again, and the table that fixes it is on the index —
           * `WorldGraph.namedClasses` and `namedRaces` exist for exactly this,
           * and their own doc says so: *a bare list of numbers is the half-read
           * `WorldLookup` already carries `classNames` to avoid*. A row id the
           * realm's table does not hold falls back to the number, which is
           * still more than nothing and is honest about being a number.
           */
          const table =
            blocked.kind === 'class'
              ? this.index.namedClasses()
              : blocked.kind === 'race'
                ? this.index.namedRaces()
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
        // `stepCost` priced it by. `Levers.pullLevers` sends the phrase.
        if (wall !== null && this.leverPrice(prev, exit.direction, traveller) === null) {
          const item = wall.keyId === undefined ? undefined : this.index.item(wall.keyId);
          const off = switchedOff(wall, traveller);
          blocks.unshift({
            kind: 'door',
            at: prev,
            to: cursor,
            name: this.rooms.get(cursor)?.name ?? cursor,
            ...(wall.pickDifficulty === undefined ? {} : { pickDifficulty: wall.pickDifficulty }),
            ...(wall.bashDifficulty === undefined ? {} : { bashDifficulty: wall.bashDifficulty }),
            picklocks: traveller.pickSkill ?? null,
            strength: traveller.strength ?? null,
            ...(off.length === 0 ? {} : { switchedOff: off }),
            ...(wall.keyId === undefined ? {} : { keyId: wall.keyId }),
            ...(item === undefined ? {} : { itemName: item.name }),
            ...this.leverSaying(prev, exit.direction)
          });
        }
      }
      cursor = prev;
    }
    // A way or place kept out of is named where the way enters it, once: the
    // Plane is four hundred rooms of one word.
    const said = new Set<string>();
    return blocks.filter((block) => {
      if (block.kind !== 'keptOut') return true;
      if (said.has(block.word)) return false;
      said.add(block.word);
      return true;
    });
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
                this.index,
                // A door's lever is not on the door: the step is what knows
                // where it is standing, so the join is made here.
                this.index.leversHere(prev, exit.direction)
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
          ? hazardWordOf(this.index.hazardOf(arriving, traveller.level))
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
         * And a lair the router could not weigh (an unread bar, a monster the
         * arithmetic cannot price), which is not a lair that costs nothing:
         * the kept-out cards say so rather than *no lairs* (todo 806).
         */
        ...(arriving?.lair !== undefined && traveller.danger !== undefined && danger === null
          ? { lairUnweighed: true }
          : {}),
        // And the kept-out word it crosses, allowed or not, for the chip and
        // for what a walk the player chose may cross again (`crossing`).
        ...(destination === undefined
          ? {}
          : (() => {
              const word = this.keptOut(traveller, exit, destination, true);
              return word === null ? {} : { keptOut: word };
            })()),
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
      const spell = this.index.spellById(room.spell);
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
          const item = this.index.item(id);
          // A row the item index cannot name is left out: `carry item 3609`
          // is the exact half-read `describeObstacle` refuses for a key.
          return item === undefined ? [] : [{ id, name: item.name }];
        }),
        needsSpell: (hazard.avoidedBySpell ?? []).flatMap((id) => {
          const named = this.index.spellById(id);
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
    for (const passage of this.index.corridorsOn(steps)) {
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
  holding(traveller: Traveller, item: number): Traveller {
    const keys = [...(traveller.keys ?? []), item];
    const priced = traveller.hazard;
    if (priced === undefined) return { ...traveller, keys };
    return {
      ...traveller,
      keys,
      hazard: (room) => {
        const hazard = this.index.hazardOf(room, traveller.level);
        return hazard !== null && hazardAvoided(hazard, keys) ? null : priced(room);
      }
    };
  }

  /**
   * The word that opens this step here, for the head of the plan.
   *
   * Asked of `WorldGraph.leversHere` and **not** of `leverPrice`, because this
   * is only reached when the price already said *wall* — and the most useful
   * case of that is a lever whose item the listed pack lacks. *Say "use crowbar"
   * here, carrying crowbar* is the errand; *needs 1000 picklocks, your
   * picklocks are not known yet* is the same door with the answer left out.
   */
  private leverSaying(
    from: RoomId,
    direction: string
  ): { opensBySaying?: string; opensItemName?: string } {
    const lever = this.index.leversHere(from, direction)[0];
    if (lever === undefined) return {};
    const item = lever.item === undefined ? undefined : this.index.item(lever.item);
    return {
      opensBySaying: lever.say,
      ...(item === undefined ? {} : { opensItemName: item.name })
    };
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
   * it is made reactively by `Levers.fetchLever`.
   */
  private leverPrice(from: RoomId, direction: string, traveller: Traveller): number | null {
    const levers = this.index.leversHere(from, direction);
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
    for (const exit of this.index.itemLandings()) {
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
}

/** `RouteStep.hazardKind` for a spell priced on nothing the realm states. */
function hazardWordOf(hazard: SpellHazard | null): { hazardKind?: 'unread' | 'summons' } {
  if (hazard === null || hazard.damage !== undefined) return {};
  if (hazard.unread === true) return { hazardKind: 'unread' };
  if (hazard.summons === true) return { hazardKind: 'summons' };
  return {};
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
