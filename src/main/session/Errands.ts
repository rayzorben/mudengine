/**
 * The session's reading of the realm for one character: what it costs to move
 * right now (the traveller), what a lair or a room's own spell costs it, where
 * a counter, a trainer, an item and a hunting ground are, and how a quest step
 * is planned and priced. It answers; the walks and errands that act on the
 * answers are `Travel`'s and the automation modules'. Nothing under
 * `automation/` sees `WorldGraph`, and this is the layer that keeps it so. See
 * `mudengine-session` › *Travel and errands are adapters beside the session*.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SessionModule } from '../automation/Module';
import type { KeyedWay } from '../automation/AutoKeys';
import type { RestAwayPlanner } from '../automation/RestAway';
import type { WardSources } from '../automation/Wards';
import type { WalkerEvents } from '../automation/walk/ports';
import type { ItemSources } from '../automation/ItemErrand';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { RouteOptions, Traveller, WorldGraph } from '../world/WorldGraph';
import { LairCosts } from '../world/LairCosts';
import { preferredEdges } from '../world/loopDraft';
import { capabilitiesOf, poisonRefusesRest, type Capabilities } from '../../shared/abilities';
import { ownAlignment, packRows, type CharacterState } from '../../shared/character';
import { chargedInCopper } from '../../shared/coins';
import { commandOf } from '../../shared/commands';
import type { AutomationConfig, SupplyItem } from '../../shared/config';
import type { FightSink } from '../../shared/fights';
import {
  addFiller,
  compareSpots,
  estimateSpot,
  moveDelayMs,
  orderRing,
  respawnSeconds,
  sizeLoop,
  type FillerInput,
  type HealingCast,
  type HuntingAdvice,
  type HuntingAssumptions,
  type HuntingConstants,
  type HuntingRoom,
  type HuntingSpot,
  type SpotCharacter,
  type SpotEstimate,
  type SpotInput,
  type SpotMob
} from '../../shared/hunting';
import { bareName, sameItem } from '../../shared/items';
import { afflictionsOf, protectionOf, weighRoom, type MenacePlayer } from '../../shared/menace';
import { attacksOnSight } from '../../shared/mobs';
import { dodge, regeneration, swing, type ProwessSheet } from '../../shared/prowess';
import type { RealmFamily } from '../../shared/realm';
import {
  countersNow,
  planSpan,
  questReading,
  rollChance,
  type PlanCash,
  type PlanItem,
  type PlanStep,
  type QuestErrand,
  type QuestPlan,
  type QuestWatched
} from '../../shared/quests';
import { holdsMovement, spellServes } from '../../shared/spellcraft';
import {
  castsToKill,
  chooseAttackSpell,
  healPower,
  type SpellChoiceInput
} from '../../shared/spellchoice';
import { statedNow } from '../../shared/stated';
import { carriedCount } from '../../shared/supplies';
import { trainingCost } from '../../shared/training';
import {
  lairPass,
  passShare,
  prowessSheetOf,
  weighVerdicts,
  wieldedWeapon,
  type LairPass
} from '../../shared/verdict';
import {
  asDirection,
  hazardAvoided,
  nameAnswersTo,
  parseLair,
  roomAddress,
  roomId,
  type BuyingPlace,
  type RoomId,
  type Route,
  type TrainerChoice,
  type WorldRoom
} from '../../shared/world';

/** No preferred corridors: one value, so a session with none re-renders nothing. */
const NO_EDGES: ReadonlySet<string> = new Set();

/** The rooms holding one lair signature, as the hunting survey groups them. */
interface HuntGroup {
  rooms: HuntingRoom[];
  sample: WorldRoom;
  via: 'lair' | 'resident';
  spawns: number | null;
}

/** What pricing a group costs to work out and what it depends on: the character, never the room. */
interface HuntPrice {
  mobs: SpotMob[];
  clock: HuntingSpot['clock'];
  respawn: number | null;
}

/** One group priced against the character, before any loop is drawn round it. */
interface HuntPriced extends HuntPrice {
  key: string;
  group: HuntGroup;
  /** Every room of the group, nearest first. */
  rooms: HuntingRoom[];
}

/** The character's own side of the combat arithmetic. See `Errands.realmClass`. */
export interface RealmClass {
  combat: number | null;
  magery: number | null;
  family: RealmFamily | null;
}

/** What `chooseAttackSpell` is handed about the caster, before a target. */
export type CastingInput = Omit<SpellChoiceInput, 'target' | 'excluded'>;

/**
 * The realm's answers these read, and no more: the router's, the catalogue's
 * and the quest planner's, which todos 710–712 give homes of their own.
 */
export type ErrandsWorld = Pick<
  WorldGraph,
  | 'buyingPlaces'
  | 'byId'
  | 'cashPlaces'
  | 'classId'
  | 'classNamed'
  | 'droppingPlaces'
  | 'errand'
  | 'findByName'
  | 'get'
  | 'hazardOf'
  | 'item'
  | 'itemAsks'
  | 'itemsNamed'
  | 'lair'
  | 'lairEntities'
  | 'planStep'
  | 'priceAt'
  | 'quests'
  | 'raceAbilities'
  | 'raceId'
  | 'residentEntities'
  | 'route'
  | 'shop'
  | 'shopPlace'
  | 'size'
  | 'spellById'
  | 'spellNamed'
  | 'stockingPlaces'
  | 'trainersTaking'
  | 'withinSteps'
>;

/** What the answers are read from: the realm, the character, the fight record. */
export interface ErrandsParts {
  readonly world: ErrandsWorld | undefined;
  readonly tracker: Pick<CharacterTracker, 'current'>;
  /** What this character has measured dealing a round, for the survey. */
  readonly fightRecord: Pick<FightSink, 'measured'>;
}

/** What the session that built this answers for it. */
export interface ErrandsSession {
  /** The automation settings as last loaded. */
  config(): AutomationConfig;
  /** Which lineage's arithmetic the server runs, once the wire has said. */
  family(): RealmFamily | null;
  /** The rank each quest has been seen to reach this session. */
  watched(): QuestWatched;
  /** The one `abil` of the session (`Routines.askAbilities`). */
  askAbilities(state: CharacterState): void;
  notice(message: string): void;
}

export class Errands implements SessionModule {
  private readonly world: ErrandsWorld | undefined;
  private readonly tracker: ErrandsParts['tracker'];
  private readonly fightRecord: ErrandsParts['fightRecord'];
  /** The last `fitness` answer and the state it was for; dropped when the family moves. */
  private fitted: { state: CharacterState; key: string } | null = null;
  /** What each room's lair costs this character, remembered per fitness. See `lairDanger`. */
  private readonly lairCosts = new LairCosts((room) => this.weighLair(room));
  /**
   * The hunting survey's pricing pass, remembered until the character's
   * fitness moves (todo 00, 2026-09-13). Weighing 1,260 groups costs main
   * ~140ms and depends on the sheet, the weapon, the class and the spells —
   * not on the room — while the card re-asks on every move it makes. Keyed
   * like `LairCosts`, the casting half added; dropped with the realm.
   */
  private huntPrices: { key: string; world: ErrandsWorld; groups: Map<string, HuntPrice> } | null =
    null;
  /**
   * Edges the live server refused this session (`from|direction`). Handed to
   * every route as `Traveller.refused`, and forgotten on disconnect: a server
   * restart may open what this session saw shut, and the permanent record
   * (`WorldMemory`) deliberately never reaches the pathfinder.
   */
  private readonly refusedEdges = new Set<string>();
  /**
   * The refused edges that are **shut** rather than absent, and have not yet
   * been given back once.
   *
   * The bound on `unrefuseWhatTheRoomPrints`. `refusedEdges` used to be
   * monotonic and that was its bound; taking entries out again needs a new one
   * or a corridor that both prints and refuses cycles — refused, un-refused on
   * the next room block, replanned, refused — at a route search and a move per
   * turn. `There is no exit in that direction!` has four causes
   * (docs/greatermud/movement.md) and two of them are exits the server may
   * still list, so that is not hypothetical.
   *
   * An entry is deleted when it is given back, so each edge is given back at
   * most once per session: the server printing it is a fact worth one retry,
   * and a way that is refused *again* after the room listed it is one the room
   * is not the authority on.
   */
  private readonly shutEdges = new Set<string>();
  /** The corridors of this character's preferred routes; null until asked, and after the loops change. */
  private preferred: ReadonlySet<string> | null = null;
  /** Which ask for a plan is current; an earlier chain stops at its next leg. */
  private planAsked = 0;

  constructor(
    parts: ErrandsParts,
    private readonly session: ErrandsSession
  ) {
    this.world = parts.world;
    this.tracker = parts.tracker;
    this.fightRecord = parts.fightRecord;
  }

  private get automationConfig(): AutomationConfig {
    return this.session.config();
  }

  private get serverFamily(): RealmFamily | null {
    return this.session.family();
  }

  /**
   * On connect and on leaving the realm. An edge the realm refused was refused
   * for *this* character — a door it could not open, an exit its class may not
   * use — so the blacklist goes with it rather than costing the next character
   * corridors it can walk.
   */
  reset(): void {
    this.refusedEdges.clear();
    this.shutEdges.clear();
  }

  /** The server's family moved, so every remembered `fitness` is stale. */
  forgetFitness(): void {
    this.fitted = null;
  }

  /**
   * The loops may have changed, and with them the routes this character
   * prefers; derived again the next time a route is planned.
   */
  forgetPreferred(): void {
    this.preferred = null;
  }

  /**
   * A step the live server refused (`WalkerEvents.refused`): avoided for the
   * session, and said in the words that fit the realm's own record of it.
   */
  noteRefused(...[from, direction, why]: Parameters<NonNullable<WalkerEvents['refused']>>): void {
    const edge = `${from}|${direction}`;
    this.refusedEdges.add(edge);
    // Only a way the realm records as *shut* can be opened by somebody
    // walking over and pulling its levers, so only that one is ever given
    // back. See `unrefuseWhatTheRoomPrints`.
    if (why === 'shut') this.shutEdges.add(edge);
    /*
     * **Two sentences, because they are two facts.** `The realm data
     * promised an exit that the realm refuses` is true of a corridor the
     * data invented, and was being said about a `Hidden/Needs 2 Actions`
     * exit — which is the realm data being exactly right and the way being
     * shut. Reported as todo 04 with the room in it (`1/1056`), whose
     * north exit is in the file with both its levers. Either way the edge
     * is avoided for the session; what changes is what the console claims,
     * and one of the two tells the player there is something to go and do.
     */
    this.session.notice(
      why === 'shut'
        ? t('session.walk.exitShut', { direction })
        : t('session.walk.exitRefused', { direction })
    );
  }

  /**
   * Takes an edge back out of `refusedEdges` the moment the server prints it.
   *
   * `refusedEdges` is a *guess* — the server refused a step, so routes avoid
   * that corridor for the session — and nothing ever took an entry out of it
   * again. That is right for a corridor the realm data invented and wrong for
   * every other reason a step can be refused, of which the reported one is a
   * shut gate: the way opens the moment somebody pulls its levers by hand, and
   * every route went on avoiding it until the character reconnected (todo 04,
   * *"routes will avoid it"*).
   *
   * The room's own `Obvious exits:` line is the authority — the same source
   * `Barriers.mustSearchFirst` reads to decide a hidden exit has been found —
   * and a fact printed by the server outranks a guess this client made. So an
   * exit the room lists is not refused, whatever was written down about it.
   *
   * Cheap: it runs only where the room prints something *and* something is
   * refused, which after a healthy session is never.
   */
  unrefuseWhatTheRoomPrints(state: CharacterState): void {
    if (this.shutEdges.size === 0) return;
    const { map, number } = state.room;
    if (map === null || number === null) return;
    const here = roomId(map, number);
    for (const exit of state.room.exits) {
      const key = `${here}|${exit.direction}`;
      // Spent whether or not the edge was still refused, so the offer is made
      // once per edge per session and cannot become a cycle.
      if (!this.shutEdges.delete(key)) continue;
      if (!this.refusedEdges.delete(key)) continue;
      this.session.notice(t('session.walk.exitBackOpen', { direction: exit.direction }));
    }
  }

  /**
   * A route from where this character is standing to `to`, or the reason
   * there is none.
   *
   * The one statement of what this character costs to move: its level, what
   * it can force or pick, and **the purse**, because a toll gate is priced and
   * a route planned without it walks a penniless character up to one, over and
   * over. `refusedEdges` goes with it, so a corridor the server has already
   * said does not exist is not planned through twice in one session.
   *
   * Shared by the loop's next leg and by a route picking itself back up after
   * a fight, because those two answering the question differently is the
   * "two halves of one gate in two files" failure this codebase keeps
   * relearning — and the purse is exactly the argument it was left out of
   * once already. `shortest` is a lap's leg: see `lapTraveller`.
   */
  planFromHere(
    to: RoomId,
    options: RouteOptions = {},
    shortest = false,
    /**
     * The kept-out words this plan may cross: nothing, unless the caller is
     * planning the player's own journey again (`allowingFor`).
     */
    allowing: readonly string[] = []
  ): Route | string {
    const state = this.tracker.current;
    const here = state.room;
    if (here.map === null || here.number === null) return t('session.loop.unknownRoom');
    const traveller = shortest
      ? this.lapTraveller(state)
      : this.travellerNow(state, true, allowing);
    const plan =
      this.world?.route(roomId(here.map, here.number), to, traveller, options) ??
      t('session.loop.noRealmData');
    if (typeof plan !== 'string') this.askCountersFor(plan);
    return plan;
  }

  /**
   * One `abil`, the first time a plan crosses a gate the counters would answer.
   *
   * The realm writes a room script's landing per branch — `9/1291`'s `go
   * portal` names `9/1424` on `checkability 133 5` and no room at all on the
   * two branches below it — so a character the gate refuses is put somewhere
   * the plan never named. `edgePenalty` refuses such an edge outright once the
   * counters are read, and reads *nobody has said* as the old price; this is
   * what turns the second into the first.
   *
   * **A gate, whichever of the realm's two shapes wrote it.** `Requirement.
   * abilities` holds the exit table's `Ability: 204 w/value 1 to 999` as well
   * as the script's verbs, so this reads both by reading one field. An
   * `AbilityExit` does not misplace the character — the server simply refuses
   * the step — but it stops the walk exactly as dead, nine exits' worth, and
   * the listing is what turns a 286-step plan into a refusal with a reason.
   *
   * **Asked off the plan rather than on the way in**, though it is one command
   * in the cheapest band. A *complete* listing enumerates, so it settles every
   * counter at once and the quest book stops offering its nodes as the
   * player's own marks — right where the realm has spoken, and an answer
   * nobody asked for where it has not. A plan that crosses such a gate is the
   * moment the client genuinely needs the number.
   *
   * One-shot inside `Routines`, so every plan after the first costs nothing,
   * and it is the plan that is read rather than the route walked: a leg, a
   * resume and the panel's own press all come through here.
   */
  askCountersFor(route: Route): void {
    const state = this.tracker.current;
    if (state.abilities !== null) return;
    if (!route.steps.some((step) => (step.requirement?.abilities?.length ?? 0) > 0)) return;
    this.session.askAbilities(state);
  }

  /**
   * What this character costs to move, as the router prices it.
   *
   * One statement, read by every route this session plans — the loop's leg,
   * a route picking itself up after a fight, the way home from a retreat —
   * and by the route panel through main. The stats off the sheet, the purse,
   * the corridors the server refused this session, and the corridors of the
   * routes this character prefers (`preferredEdges`), unless the caller is
   * the builder, whose drafts plan plainly so what is drawn is what the
   * reduction reproduces.
   */
  travellerNow(
    state: CharacterState,
    preferring = true,
    /** Kept-out words this walk may cross anyway. See `planFromHere`. */
    allowing: readonly string[] = []
  ): Traveller {
    const pack = this.packContents(state);
    return {
      level: state.progress.level ?? null,
      strength: state.progress.strength ?? null,
      pickSkill: state.progress.picklocks ?? undefined,
      // And which of the two the walker will spend: a door planned on a skill
      // whose switch is off is a door the walk stops at.
      forcing: {
        pick: this.automationConfig.movement.pickLocks,
        bash: this.automationConfig.movement.bashDoors
      },
      // And the ways and places routes keep out of (todo 806): pruned for a
      // walk nobody watches, offered beside the way round on the panel.
      keepOut: { words: this.automationConfig.movement.keepOutOf, allowed: allowing },
      wealth: state.inventory.wealth,
      /*
       * The join between the sheet's word and the realm's row id, made here
       * for the reason every other figure on this object is: one statement,
       * read by the loop's leg, the pick-up after a fight, the way home and
       * main's route panel alike. `wearerIn` in `main/index.ts` makes the same
       * join for what a character may *wear*; both go through
       * `WorldGraph.classId` so a Paladin cannot be one class to a helm and
       * another to a corridor.
       */
      classId: this.world && state.className ? this.world.classId(state.className) : null,
      // The same join one column across, for a race-gated exit.
      raceId: this.world && state.race ? this.world.raceId(state.race) : null,
      /*
       * The one fact here that is not off the stat sheet: the sheet carries no
       * standing, so the roster's own row for this character is the only place
       * it appears. Null for the first seconds of every session, which the
       * router treats as *nobody has said* and never as neutral.
       */
      alignment: ownAlignment(state),
      /*
       * And the quest counters, for a scripted way through gated on one. Null
       * until `abil` has answered (`Routines.askAbilities`), which the router
       * reads as *nobody has said* and never as the gate passing.
       */
      counters: state.abilities,
      // And the wards the server has stated up with a clock still running,
      // for a room spell one of them stops (todo 105).
      spellsUp: this.spellsUp(state),
      ...pack,
      refused: this.refusedEdges,
      ...(preferring ? { preferred: this.preferredEdges() } : {}),
      // What waits in each room, against this character as they stand now.
      danger: (room) => this.lairDanger(room, state),
      // And the same figure before the division, for the walker's rest
      // before a trap: a reserve in hit points, not a share of a bar that
      // was read at planning time.
      lairDamage: (room) => this.lairCost(room, state),
      /*
       * And what the room itself does to whoever stands in it — with the pack
       * resolved **once**, here, rather than per call: this runs for every room
       * the A* expands that casts anything, and `packContents` walks the whole
       * listing and normalises every name. `danger` is spared it because
       * `LairCosts` remembers per room; this has nothing to remember, so the
       * one thing it depends on is hoisted instead.
       */
      hazard: (room) => this.roomHazard(room, state, pack.keys)
    };
  }

  /**
   * What a lap's leg costs to move: the distance, and whether each way can be
   * passed at all — never what is waiting on it.
   *
   * A loop is walked for the monsters on it, so pricing them re-routes the
   * lap around its own purpose. Kept: the gates (doors, keys, levels, class,
   * counters), the edges the server refused, and a room whose spell moves the
   * character, which is not a way to arrive anywhere. Dropped: the lair, the
   * room's damage, the preferred corridors. See `mudengine-automation` ›
   * *A lap walks the shortest way*.
   */
  lapTraveller(state: CharacterState): Traveller {
    const priced = this.travellerNow(state, false);
    const relocates = (room: WorldRoom): number | null =>
      this.world?.hazardOf(room, state.progress.level)?.relocates === true
        ? (priced.hazard?.(room) ?? null)
        : null;
    return { ...priced, danger: undefined, hazard: relocates };
  }

  /**
   * What a room's own spell is expected to cost this character, as a share of
   * the health it has now (`Traveller.hazard`, todo 01).
   *
   * `lairDanger`'s shape, one column across, and simpler for one reason: the
   * damage is a figure the realm states rather than one this client computes,
   * so there is nothing to remember and no fitness string to invalidate. What
   * varies is the pack — a log raft turns eight hundred and forty-five rooms
   * of the Silver River from a wall into a corridor — and the bar, and both
   * are read at the call.
   */
  private roomHazard(room: WorldRoom, state: CharacterState, carrying?: number[]): number | null {
    if (!this.world) return null;
    // The character's own level: the realm gates some effects on it, and a
    // sandstorm that cannot catch this character is not a price it pays.
    const hazard = this.world.hazardOf(room, state.progress.level);
    if (hazard === null) return null;
    // Carrying what stops it is not *unknown*, it is *free*: the room costs a
    // plain step, which is what it is for that character.
    if (hazardAvoided(hazard, carrying ?? this.packContents(state).keys, this.spellsUp(state)))
      return null;
    /*
     * **A room that moves you is a wall, exactly as an exit that casts one
     * is** (`edgePenalty`'s `spellEffect === 'relocates'`). The walker's next
     * command goes out from wherever the plan says it is standing, and a room
     * that puts it somewhere the exit table does not name breaks every step
     * after it. 1,557 rooms of the shipped realm cast one. `deadlyShare` and
     * not `wallCost` because this is a *share*, and `dangerPenalty` turns a
     * share at the wall into the wall — one place decides that number.
     */
    if (hazard.relocates === true) return tuning().world.deadlyShare;
    const health = state.vitals.hp ?? state.vitals.hpMax;
    if (health === null || !(health > 0)) return null;
    /*
     * A chain the reader could not follow prices as a *discouragement* rather
     * than as nothing: `graveyard summon` and `fire trigger` end in verbs this
     * client cannot evaluate, and walking such a room for free is exactly what
     * put a route down the Silver River. `unreadHazardShare` is what a step
     * through one is worth as a share of the bar — small, and never zero.
     */
    /*
     * The worse of the two, not one or the other: `unread` means the chain
     * carried on past what this reader could follow, so a spell that does a
     * readable ten and then something unreadable is *at least* the ten. Taking
     * the damage alone would let the unread half read as nothing.
     */
    const read = hazard.damage === undefined ? null : hazard.damage / health;
    // A chain that can put a monster in the room is priced on the same
    // discouragement: what it does is what a lair does, and how much is a
    // number this cannot weigh without knowing what turns up.
    const unread =
      hazard.unread === true || hazard.summons === true ? tuning().world.unreadHazardShare : null;
    if (read === null) return unread;
    return unread === null ? read : Math.max(read, unread);
  }

  /**
   * What a room's lair is expected to cost this character, as a share of
   * maximum health, for the router (`Traveller.danger`, `dangerPenalty`).
   *
   * Todo 13: a route was planned through whatever the shortest corridor held,
   * a boss included, because nothing priced the monsters. The arithmetic is
   * the room appraisal's (`appraiseRoom`), run on the lair's monsters instead
   * of the room's occupants, so the Room card and the router cannot disagree
   * about how hard a monster is. Remembered per room until the character's
   * own figures move — a level gained, a helm put on — which `fitness` says
   * (`LairCosts`). Null where nothing can be weighed, and the router prices
   * null as nothing: an unread sheet must not turn every lair into a wall.
   */
  private lairDanger(room: WorldRoom, state: CharacterState): number | null {
    if (!this.world || !room.lair) return null;
    /*
     * The damage is remembered per room; the share is taken against the
     * health the character has *now*, at every call, because that is the
     * number a pass is measured against — a route planned at a third of the
     * bar has to be three times as careful as one planned at the top of it,
     * and the loop plans every leg afresh. Unread health prices nothing.
     */
    /*
     * **And a pass nobody can say will happen is capped below the wall**
     * (`passShare`, `tuning.world.unsureShare`). `attacksOnSight` answers
     * `null` for a conditional monster met by a character whose standing has
     * not been read; counted in at its full share it reaches `deadlyShare`,
     * and a corridor is then closed on a fact nobody has read — the one thing
     * `edgePenalty` was fixed not to do for a gate it cannot evaluate.
     */
    return passShare(
      this.lairPassHere(room, state),
      state.vitals.hp ?? state.vitals.hpMax,
      tuning().world.unsureShare
    );
  }

  /**
   * What one pass through a room's lair is expected to take, in hit points.
   *
   * **Uncapped, deliberately**: this is what the walker reserves health
   * against before a trap, and a reserve shaded by how sure the *router* is
   * would be the router's caution spent as the walker's safety margin.
   */
  private lairCost(room: WorldRoom, state: CharacterState): number | null {
    return this.lairPassHere(room, state)?.damage ?? null;
  }

  /** The weighed pass for a room, remembered until the character's fitness moves. */
  private lairPassHere(room: WorldRoom, state: CharacterState): LairPass | null {
    if (!this.world || !room.lair) return null;
    return this.lairCosts.at(this.fitness(state), roomId(room.map, room.room));
  }

  /**
   * The figures a lair's cost depends on, as one string, so a change to any
   * of them drops every remembered room. The sheet, the weapon in hand, the
   * class row, the standing (which decides who attacks on sight), the
   * server's family and what `stat all` still states; not the pack, the purse
   * nor the health itself, which move every room and change no blow.
   */
  private fitness(state: CharacterState): string {
    // Asked once per lair a search expands; a state is never edited in place.
    if (this.fitted?.state === state) return this.fitted.key;
    const { progress } = state;
    const key = [
      progress.level,
      ownAlignment(state),
      progress.armourClass,
      progress.damageResist,
      progress.magicRes,
      progress.agility,
      progress.intellect,
      progress.charm,
      progress.strength,
      state.className,
      JSON.stringify(wieldedWeapon(state.inventory.items)),
      this.serverFamily,
      JSON.stringify(statedNow(state))
    ].join('|');
    this.fitted = { state, key };
    return key;
  }

  /**
   * One room's lair, weighed: what one pass through it is expected to take,
   * in hit points, **and whether the wire settles that it happens at all**.
   * See `lairDanger` for what is remembered and why.
   *
   * Only what attacks on sight counts (`attacksOnSight`, against the
   * character's own standing): a passive monster is walked past, a hostile
   * one gets its round, and one whose disposition nobody has read is priced
   * as hostile — an unknown is never the reassuring answer. What `lairPass`
   * adds is the second half of that sentence: counted in, and marked as
   * unevidenced, so the router discourages the room rather than walling it.
   */
  private weighLair(id: RoomId): LairPass | null {
    const world = this.world;
    if (!world) return null;
    const room = world.byId(id);
    if (!room) return null;
    const lair = world.lair(room, this.serverFamily);
    if (lair === null || lair.mobs.length === 0) return null;
    const state = this.tracker.current;
    const { combat, magery, family } = this.realmClass();
    /*
     * By the rows the lair names, never by name (todo 01, 2026-09-10): a name
     * folds every row sharing it and takes the worst, and the guard post on
     * the Hillside Path was priced as an 830-HP gnoll scout that swings four
     * times a round when the row it names is the 100-HP one that lands a blow
     * in twenty-five. See `WorldGraph.lairEntities`.
     */
    const entities = world.lairEntities(room);
    if (entities.length === 0) return null;
    const verdicts = weighVerdicts(
      entities,
      this.menacePlayer(state),
      tuning().menace,
      prowessSheetOf(state, { combat, magery }),
      wieldedWeapon(state.inventory.items),
      family
    );
    const standing = ownAlignment(state);
    const rounds = tuning().world.passRounds;
    const opens = (index: number): boolean | null =>
      attacksOnSight(entities[index]?.disposition ?? null, standing);
    return lairPass(verdicts, lair.max, rounds, opens);
  }

  /**
   * The trainers that will take this character, cheapest first (todo 18).
   *
   * Addressed at the character because the answer is about *its* level and
   * class, and asked on demand: the picker is the reader and a list stale the
   * moment the character levels has no business on a push.
   *
   * Empty for a level the client has not read. That is the honest answer and
   * not a shortcut: `trainsLevel` compares against a number, and guessing one
   * would offer a room the server refuses — the walk across two maps this
   * whole query exists to avoid.
   */
  trainers(): TrainerChoice[] {
    const state = this.tracker.current;
    const world = this.world;
    const level = state.progress.level;
    if (world === null || world === undefined || level === null) return [];
    const classId = state.className ? world.classId(state.className) : null;
    return world.trainersTaking(level, classId).map((found) => ({
      shop: found.trainer.id,
      name: found.trainer.name,
      map: found.map,
      room: found.room,
      roomName: found.roomName,
      cost: trainingCost(level, found.trainer.markup),
      minLevel: found.trainer.minLevel ?? null,
      maxLevel: found.trainer.maxLevel ?? null
    }));
  }

  /**
   * The order one quest step's several items are best fetched in (todo 01).
   *
   * The card's own question, addressed and asked on demand: the realm states
   * a step's items in the order its opcodes run, which is nobody's walk, and
   * `WorldGraph.errand` answers with the shortest one from where this
   * character is standing through a place for each of them and back to the
   * asker. Priced by **this** traveller, like every other plan main makes —
   * the lair, the room's own spell and the door that wants a strength this
   * character has not got all decide the order, and a walk chosen for
   * somebody else is a walk this one cannot take.
   *
   * Null for a step the realm does not hold, a character the client cannot
   * place, and a step with fewer than two things to go and get: all three are
   * *there is no walk to order here*, and the card then draws the item list
   * exactly as it did before.
   */
  questErrand(block: number): QuestErrand | null {
    const world = this.world;
    if (world === undefined) return null;
    const step = world
      .quests()
      .flatMap((quest) => quest.steps)
      .find((other) => other.block === block);
    if (step === undefined) return null;
    const here = roomAddress(this.tracker.current.room);
    if (here === null) return null;
    return world.errand(step, here, this.travellerNow(this.tracker.current));
  }

  /**
   * The character's own stock rows that a plan should fill, with the realm's
   * id for each.
   *
   * Short of the **ceiling**, not of the floor: a list saying *keep three,
   * carry six* is asking for six before setting out, and four torches at the
   * door of a fortress is how a run ends up in the dark (2026-09-22). A row
   * naming no counter is `AutoLoot`'s to fill off the floor, and an unlisted
   * pack is not an empty one.
   */
  private stockShort(state: CharacterState): Array<{ id: number; row: SupplyItem }> {
    const world = this.world;
    if (world === undefined) return [];
    // Nothing is planned against a switch that is off: `Supplies.fetch`
    // would answer *Auto-Supplies is off* and the run would wear the refusal
    // for a torch the quest never asked for.
    if (!this.automationConfig.enabled || !this.automationConfig.supplies.enabled) return [];
    if (packRows(state.inventory) === null) return [];
    const wanted = this.automationConfig.supplies.items.filter(
      (row) =>
        row.shop.trim().length > 0 && carriedCount(state, row.name) < Math.max(row.max, row.min)
    );
    if (wanted.length === 0) return [];
    const named = world.itemsNamed(wanted.map((row) => row.name));
    return wanted.flatMap((row) => {
      const found = named[row.name];
      return found === undefined ? [] : [{ id: found.id, row }];
    });
  }

  /**
   * Whether the leg about to be walked is where the stock list should be
   * filled — the run's own answer to *this torch has burnt out*.
   *
   * The question is never *are we short*, which a status line answers, but
   * **is it worth the detour now**: a counter already on the way costs
   * nothing and is taken at once, and one off the way waits for the leg that
   * passes nearest it, which may be this one and may be the sixth. Priced
   * with `buyingPlaces`' own figure — steps out of the way and back onto the
   * road — so the comparison is in the units the plan is drawn in.
   *
   * Asked once per step of a run, and only when something is below its floor,
   * because each answer is a sweep pair per leg still to walk.
   */
  questRestock(to: RoomId | null, later: readonly RoomId[]): PlanItem | null {
    const world = this.world;
    const here = roomAddress(this.tracker.current.room);
    if (world === undefined || here === null) return null;
    const state = this.tracker.current;
    const short = this.stockShort(state).filter(
      ({ row }) => carriedCount(state, row.name) < row.min
    );
    if (short.length === 0) return null;
    const traveller = this.travellerNow(state);
    const mine = new Map<number, BuyingPlace>();
    for (const place of world.stockingPlaces(
      short.map(({ id }) => id),
      here,
      to,
      traveller
    )) {
      const best = mine.get(place.item);
      if (best === undefined || place.detour < best.detour) mine.set(place.item, place);
    }
    /*
     * The legs the plan still has after this one, each priced from the room
     * the leg before it ends in — and the first of them from **here** where
     * this step names no room, or the leg this one would be compared against
     * goes unpriced.
     */
    const legs: Array<{ from: RoomId; to: RoomId | null }> = [];
    let from = to ?? here;
    for (const room of later) {
      legs.push({ from, to: room });
      from = room;
    }
    // Cheapest first, so two rows short do not settle it by the order they
    // were typed into the item list.
    const ranked = short
      .flatMap(({ id, row }) => {
        const place = mine.get(id);
        return place === undefined ? [] : [{ id, row, place }];
      })
      .sort((one, two) => one.place.detour - two.place.detour);
    const nearer =
      ranked.length === 0 || ranked[0]!.place.detour === 0
        ? new Map<number, number>()
        : this.nearestLater(
            ranked.map(({ id }) => id),
            legs,
            traveller
          );
    for (const { id, row, place } of ranked) {
      // A counter already on the road wins outright and is never compared.
      if (place.detour > 0 && (nearer.get(id) ?? Infinity) < place.detour) continue;
      return {
        id,
        name: row.name,
        held: false,
        hand: false,
        count: Math.max(row.max, row.min),
        stock: row.min,
        source: {
          how: 'buy',
          shops: [place.shop],
          at: { room: roomId(place.map, place.room), place: place.roomName },
          detour: place.detour
        }
      };
    }
    return null;
  }

  /**
   * The cheapest detour each of these items would cost on any leg the plan
   * still has to walk.
   *
   * **One sweep pair per leg for the whole list**, never one per item:
   * `buyingPlacesFor` takes several for exactly this reason, and a pair each
   * was the eight Dijkstras a river crossing cost before it did.
   */
  private nearestLater(
    items: readonly number[],
    legs: ReadonlyArray<{ from: RoomId; to: RoomId | null }>,
    traveller: Traveller
  ): Map<number, number> {
    const best = new Map<number, number>();
    for (const leg of legs) {
      for (const place of this.world?.stockingPlaces(items, leg.from, leg.to, traveller) ?? []) {
        const seen = best.get(place.item);
        if (seen === undefined || place.detour < seen) best.set(place.item, place.detour);
      }
    }
    return best;
  }

  /**
   * The plan to reach one step of a quest from where this character stands:
   * the steps still to do up to it, each with what it gathers, where it
   * happens and whether the way there exists (`WorldGraph.planStep`).
   *
   * **Paced across the event loop**, one step per turn, the way `FightLog`
   * folds a long file: each step is an A* per leg and a chain to its ninth
   * rank is nine of them, which held the socket's thread for over a second
   * on Paradigm when it was one call. A refusal answers nothing: no world, or
   * a block no quest holds.
   *
   * Where the counter stands is `questReading`, the card's own ranking with
   * the card's own mark handed in, so the plan and the track cannot start
   * from two different ranks. The traveller carries the counter the
   * character *will* hold at each step, since the way into a chain's later
   * rooms is routinely gated on the rank the step before hands out.
   */
  async questPlan(block: number, marked: number | null): Promise<QuestPlan | null> {
    const world = this.world;
    if (world === undefined) return null;
    const quest = world.quests().find((each) => each.steps.some((step) => step.block === block));
    if (quest === undefined) return null;
    // A later ask supersedes this chain: the answer would be thrown away by
    // the card, and nine A*s for it would still be paid on the socket's thread.
    this.planAsked += 1;
    const asked = this.planAsked;
    const state = this.tracker.current;
    const counters = countersNow(state.abilities ?? null, this.session.watched());
    const standing = questReading(quest.id, counters, this.session.watched(), marked);
    const fromRank = standing.held ? standing.rank : null;
    // A complete listing that does not name the counter has stated it, at zero.
    const stated = standing.held || counters?.complete === true;
    const here = roomAddress(state.room);
    const carrying = packRows(state.inventory);
    const traveller = this.travellerNow(state);
    const steps: PlanStep[] = [];
    // What earlier legs decided to buy against a spell on the way, so a later
    // leg through the same rooms reads the spell as stopped rather than
    // buying a second waterskin.
    const supplies: number[] = [];
    // And the character's own stock list, which nothing about a quest run
    // used to fill: each row short of its ceiling, and the leg whose detour
    // to a counter is cheapest, decided as the legs are priced.
    const stocking = this.stockShort(state);
    const stockAt = new Map<number, { step: number; detour: number; item: PlanItem }>();
    let at: RoomId | null = here;
    let rank = fromRank ?? 0;
    let moves = 0;
    for (const step of planSpan(quest, block, fromRank)) {
      const before = step.from ?? rank;
      const priced = {
        ...traveller,
        counters: {
          sums: { ...(counters?.sums ?? {}), [quest.id]: before },
          complete: counters?.complete ?? false
        }
      };
      // The hunts are the errand's laps, so the plan reads them on the lap's
      // own traveller, carrying the same counter.
      const lap = { ...this.lapTraveller(state), counters: priced.counters };
      const planned = world.planStep(quest, step, at, carrying, priced, supplies, lap);
      // The odds of the step's roll off this character's own sheet, where
      // the sheet prints the stat the script names (todo 106).
      const chance =
        planned.roll === undefined
          ? null
          : rollChance(statFigure(state, planned.roll.stat), planned.roll.value);
      steps.push(
        planned.roll === undefined || chance === null
          ? planned
          : { ...planned, roll: { ...planned.roll, chance } }
      );
      moves += planned.moves ?? 0;
      for (const item of planned.items) {
        if (item.stops !== undefined && !supplies.includes(item.id)) supplies.push(item.id);
      }
      if (stocking.length > 0 && at !== null) {
        const to = planned.at === undefined ? null : planned.at.room;
        for (const place of world.stockingPlaces(
          stocking.map((row) => row.id),
          at,
          to,
          priced
        )) {
          const row = stocking.find((each) => each.id === place.item);
          const best = stockAt.get(place.item);
          if (row === undefined || (best !== undefined && best.detour <= place.detour)) continue;
          stockAt.set(place.item, {
            step: steps.length - 1,
            detour: place.detour,
            item: {
              id: row.id,
              name: row.row.name,
              held: false,
              hand: false,
              count: Math.max(row.row.max, row.row.min),
              stock: row.row.min,
              source: {
                how: 'buy',
                shops: [place.shop],
                at: { room: roomId(place.map, place.room), place: place.roomName },
                detour: place.detour
              }
            }
          });
        }
      }
      // The next leg starts where this act happens, reached or not: a plan
      // that stopped pricing at the first blocked room would say nothing
      // about the eight after it.
      if (planned.at !== undefined && world.byId(planned.at.room) !== undefined)
        at = planned.at.room;
      rank = step.to ?? rank;
      await new Promise<void>((next) => setImmediate(next));
      if (asked !== this.planAsked) return null;
    }
    /*
     * The stock rows go on last, each on the leg it costs least to stop on —
     * which is the whole of *delay it until a step where we would be closer*.
     * Before the step's own items, because the run gathers in the plan's
     * order and a torch is wanted for the walk rather than for the act.
     */
    for (const { step: index, detour, item } of stockAt.values()) {
      const step = steps[index];
      if (step === undefined) continue;
      steps[index] = { ...step, items: [item, ...step.items], moves: (step.moves ?? 0) + detour };
      moves += detour;
    }
    const reachable = steps.some((step) => step.reachable === false)
      ? false
      : steps.every((step) => step.reachable === true)
        ? true
        : null;
    const fromPlace = here === null ? undefined : world.byId(here)?.name.trim();
    const money = this.cashFor(steps, state, here);
    return {
      block,
      ...(here === null ? {} : { from: here }),
      ...(fromPlace === undefined || fromPlace.length === 0 ? {} : { fromPlace }),
      fromRank,
      stated,
      steps: money.steps,
      reachable,
      moves,
      ...(money.cash === undefined ? {} : { cash: money.cash })
    };
  }

  /**
   * The plan's counters priced, and the cash for them found (todo 00): each
   * buy row takes what its counter charges, and the whole is set against the
   * purse and the vaults the record names — the question `Supplies` asks of
   * each purchase as the run makes it, asked once of the whole plan so the
   * card can say before the press that a run would stand at a counter.
   */
  private cashFor(
    steps: PlanStep[],
    state: CharacterState,
    here: RoomId | null
  ): { steps: PlanStep[]; cash?: PlanCash } {
    let owed = 0;
    let unpriced = 0;
    let bought = 0;
    let first: RoomId | null = null;
    const priced = steps.map((step) => ({
      ...step,
      items: step.items.map((item): PlanItem => {
        const source = item.source;
        if (source.how !== 'buy') return item;
        const copper =
          source.at === undefined || item.name === undefined
            ? null
            : this.priceAt(item.name, source.at.room);
        if (item.held !== true) {
          bought += 1;
          first ??= source.at?.room ?? null;
          // A top-up buys what the pack lacks of its ceiling, as `Supplies` does.
          const count =
            item.stock !== undefined && item.name !== undefined
              ? Math.max(0, (item.count ?? 1) - carriedCount(state, item.name))
              : (item.count ?? 1);
          if (copper === null) unpriced += 1;
          else owed += chargedInCopper(copper, state.progress.charm) * count;
        }
        return copper === null ? item : { ...item, source: { ...source, copper } };
      })
    }));
    if (bought === 0) return { steps: priced };
    const purse = state.inventory.wealth;
    const cash: PlanCash = { owed, unpriced, purse, short: false };
    // An unread purse and an unplaced character are unknown, never short.
    if (purse !== null && owed > purse && this.world !== undefined && here !== null) {
      const bank = this.world.cashPlaces(
        state.banks,
        owed - purse,
        here,
        first,
        this.travellerNow(state)
      )[0];
      if (bank === undefined) cash.short = true;
      else {
        cash.bank = {
          name: bank.name,
          room: roomId(bank.map, bank.room),
          place: bank.roomName,
          copper: bank.copper
        };
      }
    }
    return { steps: priced, cash };
  }

  /**
   * Where the realm says an item comes from, from where the character stands
   * and on the way to `to` (todo 07; re-ranked 2026-09-16): the counters that
   * stock it, least out of the way first, and the rooms anywhere in the realm
   * whose lair or resident is a monster that drops it, nearest first.
   *
   * **The counters are `WorldGraph.buyingPlaces`' answer, taken whole.** This
   * used to rank the realm's shop **names** by how near each one's room was,
   * and it had two ways of being wrong at once: a name standing in several
   * rooms was priced at infinity and sank to the bottom of the list whatever
   * was in it, and the winner was then handed on as a name for the shopping
   * errand to resolve — which refused it for the ambiguity this had just
   * created. Nearness was the wrong question besides: what matters is how far
   * off the road the stop is, and the router answers that.
   *
   * **The lairs are `WorldGraph.droppingPlaces`' answer, realm-wide**, never
   * the survey's: the survey ranks by what a lair *pays* and leaves out the
   * trivial, which is exactly the sort of monster that carries a key. And
   * **priced with the lap's own traveller**, since the loop that walks them is
   * planned with it (`mudengine-automation` › *A lap walks the shortest way*):
   * ranked on `travellerNow`, the lair's own danger walled the very rooms the
   * errand was going to fight in. The counters keep the route's prices, as a
   * shopping leg does.
   */
  itemSources(item: { id: number; name: string }, to: RoomId | null): ItemSources {
    const world = this.world;
    const state = this.tracker.current;
    const here = roomAddress(state.room);
    if (world === undefined || here === null)
      return { shops: [], asks: [], droppers: [], lairs: [] };
    const traveller = this.travellerNow(state);
    const shops = world.buyingPlaces(item.id, here, to, traveller);
    // And where saying something gets it, walked as the counter is (todo 806).
    const asks = world.itemAsks(item.id, here, traveller);
    const { maxLoopRooms, clusterRadius } = tuning().hunting;
    const ring = { rooms: maxLoopRooms, radius: clusterRadius };
    return { shops, asks, ...world.droppingPlaces(item, here, this.lapTraveller(state), ring) };
  }

  /**
   * Where this character should hunt (todo 05; revamped 2026-09-13, todo 00).
   *
   * Every lair and placed monster the exits reach — `WorldGraph.withinSteps`,
   * unbounded unless `radius` says otherwise; a sweep, never a route per
   * room — grouped by what spawns and each group priced once with the Room
   * card's arithmetic (`weighVerdicts`) and the realm's own clock through
   * `estimateSpot`. Two exclusions before the ranking, counted and said: a
   * room whose one cycle costs more than `maxDamageShare` of the bar, and
   * one that could not scratch an unarmoured character. The best `maxSpots`
   * are then measured properly (`measuredSpot`) and ranked again, with the
   * one `measure` names; the rest come back unmeasured, since the answer is
   * the realm. Distance is a column, not a bound: the walk there is automated.
   */
  huntingGrounds(radius: number | null, measure: string | null = null): HuntingAdvice {
    const state = this.tracker.current;
    const world = this.world;
    // Every figure the model runs on, named here so each has a reader.
    const {
      roundSeconds,
      restTickSeconds,
      passiveTickSeconds,
      killOverheadMs,
      stepMs,
      greatermudRespawnOffsetSeconds,
      backstabMultiplier,
      maxLoopRooms,
      maxSpots,
      betterSpotRadius,
      maxDamageShare,
      trivialShare,
      trivialLevelMargin,
      clusterRadius,
      fillerRadius,
      sizeTolerance,
      measuredFightsMin
    } = tuning().hunting;
    const c: HuntingConstants = {
      roundSeconds,
      restTickSeconds,
      passiveTickSeconds,
      killOverheadMs,
      stepMs,
      greatermudRespawnOffsetSeconds,
      backstabMultiplier,
      maxLoopRooms,
      maxSpots,
      betterSpotRadius,
      maxDamageShare,
      trivialShare,
      trivialLevelMargin,
      clusterRadius,
      fillerRadius,
      sizeTolerance
    };
    const { combat, magery, family } = this.realmClass();
    const sheet = prowessSheetOf(state, { combat, magery });
    const regen = regeneration(sheet, null, family);
    const backstab = commandOf(this.automationConfig.combat.opener.trim()) === 'BackStab';
    /*
     * One step is the server's own movement delay from the pack's weight
     * (`MoveCommand.cs:40`), where the family states one; the measured round
     * otherwise. A full pack slows the whole loop, and the estimate says so.
     */
    const step = moveDelayMs(
      state.inventory.encumbrance,
      state.inventory.encumbranceMax,
      family,
      c.stepMs
    );
    const heal = this.healingCast(state);
    /*
     * `RestCommand.cs:28` refuses a poisoned character, immunity excepted
     * (`poisonRefusesRest`). A cure — a configured spell, an antidote rule, or
     * one the book would yield under `autoChoose` — lifts it for the estimate.
     */
    const poisonHoldsRest =
      poisonRefusesRest(this.capabilities(), family) && !this.curesPoison(state);
    const character: SpotCharacter = {
      hpMax: state.vitals.hpMax,
      restingHealthPerTick: regen?.restingHealth.value ?? null,
      passiveHealthPerTick: regen?.health.value ?? null,
      backstab,
      /*
       * The caster's half (todo 26). A round costs mana only where a round
       * spell is configured — or derived under `autoChoose` — so a melee
       * character carries null here and the cycle is exactly what it was.
       * **Meditating is not resting tripled**: `TimedEventManager` gives a
       * resting character `HPRegen * 3` and a meditating one
       * `GetBaseMARegen()` flat, so the mana rate is the standing rate.
       */
      ...this.castingCost(state),
      meditatingManaPerTick: regen?.meditatingMana?.value ?? null,
      passiveManaPerTick: regen?.mana?.value ?? null,
      stepMs: step,
      heal,
      poisonHoldsRest
    };
    const assumptions: HuntingAssumptions = {
      family,
      hpMax: state.vitals.hpMax,
      restingHealthPerTick: character.restingHealthPerTick,
      backstab,
      stepMs: step,
      heal,
      poisonHoldsRest,
      measured: null,
      constants: c
    };
    const refused = (refusal: string): HuntingAdvice => ({
      from: null,
      radius,
      swept: 0,
      spots: [],
      unmeasured: [],
      excluded: { dangerous: 0, beneath: 0 },
      assumptions,
      refusal
    });
    if (!world || world.size === 0) return refused(t('session.hunt.noRealmData'));
    const here = state.room;
    if (here.map === null || here.number === null) return refused(t('session.hunt.unknownRoom'));
    const from = roomId(here.map, here.number);
    const start = world.byId(from);
    if (!start) return refused(t('session.hunt.unknownRoom'));

    /*
     * **Priced by this traveller** (todo 09): a lair behind a door this
     * character cannot open is not a lair it can hunt, and the survey was
     * offering them — a loop started on one plans a leg, is refused, and
     * stands still. The sweep is still one pass over the rooms; what changed
     * is that an impassable exit is not an exit.
     */
    const reach = world.withinSteps(
      from,
      radius ?? Number.POSITIVE_INFINITY,
      this.travellerNow(state)
    );
    /*
     * Grouped by what spawns, not by name: two rooms naming the same rows at
     * the same cap are one hunting ground with two rooms in it, which is
     * what a loop is made of. `groupOfRoom` is the join a filler is found by.
     */
    const groups = new Map<string, HuntGroup>();
    const groupOfRoom = new Map<RoomId, string>();
    for (const [id, steps] of reach) {
      const room = world.byId(id);
      if (!room) continue;
      let key: string;
      let via: 'lair' | 'resident';
      let spawns: number | null = null;
      if (room.lair) {
        const lair = parseLair(room.lair);
        // The clock is part of what spawns: two rooms naming the same rows on
        // different delays are two hunting grounds, and a price is cached by key.
        key = `lair:${lair.max ?? 1}:${[...lair.ids].sort((a, b) => a - b).join(',')}:${room.delay ?? ''}`;
        via = 'lair';
        spawns = lair.max;
      } else if (room.npcId !== undefined) {
        key = `resident:${room.npcId}`;
        via = 'resident';
      } else {
        continue;
      }
      const entry = groups.get(key) ?? { rooms: [], sample: room, via, spawns };
      entry.rooms.push({ id, map: room.map, room: room.room, name: room.name, steps });
      groups.set(key, entry);
      groupOfRoom.set(id, key);
    }

    const player = this.menacePlayer(state);
    // The same character with nothing on: every blow lands, at its full figure.
    const naked: MenacePlayer = { armourClass: 0, damageResist: 0, magicRes: player.magicRes };
    const weapon = wieldedWeapon(state.inventory.items);
    const weights = tuning().menace;
    /*
     * The caster's rounds (todo 108). `verdictFor` gets a fight's length from
     * the swing, and a Mage's swing is nothing worth counting; where the swing
     * says nothing, the spell the character would cast at *this* monster, at
     * one cast a round over the full pool, says it.
     */
    const casting = this.castingInput(state, sheet, family);
    /*
     * Where the arithmetic *declines* — `swing` is null only on the family
     * gate or an unread accuracy, neither of which reads the target, and a
     * book with no attack spell casts nothing — a kill is priced from what
     * this character has measured dealing a round. Where either *refuses*
     * (no blow lands, the spell is resisted), the refusal stands.
     */
    const blank = { armourClass: null, damageResist: null, dodge: null, health: null };
    const declines =
      swing(sheet, weapon, blank, family) === null &&
      (casting === null ||
        chooseAttackSpell({ ...casting, target: null, excluded: new Set() }).refusal ===
          'no-attack-spells');
    const level = state.progress.level;
    const measured =
      !declines || level === null
        ? null
        : (this.fightRecord.measured?.(level, {
            least: measuredFightsMin,
            roundMs: roundSeconds * 1000,
            openerRounds: backstab ? backstabMultiplier : 1
          }) ?? null);
    const priceKey = [
      this.fitness(state),
      this.automationConfig.spells.attack,
      this.automationConfig.spells.autoChoose,
      this.automationConfig.combat.opener,
      state.spellbook?.length ?? -1,
      state.vitals.manaMax,
      measured === null ? '-' : Math.round(measured.perRound)
    ].join('|');
    if (this.huntPrices?.key !== priceKey || this.huntPrices.world !== world) {
      this.huntPrices = { key: priceKey, world, groups: new Map() };
    }
    const remembered = this.huntPrices.groups;
    /** One group's monsters priced, and its clock: the half a move does not change. */
    const price = (group: HuntGroup): HuntPrice | null => {
      const entities =
        group.via === 'lair'
          ? world.lairEntities(group.sample)
          : world.residentEntities(group.sample);
      if (entities.length === 0) return null;
      const verdicts = weighVerdicts(entities, player, weights, sheet, weapon, family);
      const bare = weighRoom(entities, naked, weights);
      const recorded = (hp: number | null): number | null =>
        measured === null || hp === null || hp <= 0 ? null : hp / measured.perRound;
      const mobs: SpotMob[] = entities.map((entity, index) => ({
        name: entity.name,
        experience: entity.experience ?? null,
        rounds:
          verdicts[index]?.rounds?.value ??
          (casting === null
            ? null
            : (castsToKill(casting, {
                hp: verdicts[index]?.menace?.hp ?? entity.hp ?? null,
                magicRes: entity.magicResist ?? null,
                abilities: entity.abilities
              })?.rounds ?? null)) ??
          recorded(verdicts[index]?.menace?.hp ?? entity.hp ?? null),
        perRound: verdicts[index]?.menace?.perRound ?? null,
        nakedPerRound: bare[index]?.perRound ?? null,
        afflictions: afflictionsOf(entity),
        /*
         * A row the realm gives a clock of its own (todo 09): the Gravedigger
         * is 1,500 points on an hour's regeneration, and a lair holding it was
         * priced as though it came back with the rest of the room.
         * `estimateSpot` weights its experience by how often it is up.
         */
        regenSeconds: entity.regenHours === undefined ? null : entity.regenHours * 3600
      }));
      const clock: HuntingSpot['clock'] =
        group.via === 'lair'
          ? group.sample.delay === undefined
            ? null
            : 'delay'
          : (entities[0]?.regenHours ?? null) === null
            ? null
            : 'regenTime';
      const respawn =
        group.via === 'lair'
          ? respawnSeconds(group.sample.delay ?? null, family, c)
          : entities[0]?.regenHours === undefined
            ? null
            : entities[0].regenHours * 3600;
      return { mobs, clock, respawn };
    };
    const priced = new Map<string, HuntPriced>();
    const excluded = { dangerous: 0, beneath: 0 };
    const survey: HuntingSpot[] = [];
    for (const [key, group] of groups) {
      let known = remembered.get(key);
      if (known === undefined) {
        const fresh = price(group);
        if (fresh === null) continue;
        remembered.set(key, fresh);
        known = fresh;
      }
      const { mobs, clock, respawn } = known;
      const rooms = [...group.rooms].sort((a, b) => a.steps - b.steps);
      const entry: HuntPriced = { key, group, mobs, clock, respawn, rooms };
      /*
       * A first estimate to rank on and to exclude by: the nearest rooms, the
       * ring's length guessed from the sweep's distances — out to the farthest
       * and back, a step between neighbours. The best are then measured.
       */
      const loop = group.via === 'lair' ? rooms.slice(0, c.maxLoopRooms) : rooms.slice(0, 1);
      const guessed =
        loop.length <= 1
          ? 0
          : 2 * (loop[loop.length - 1]!.steps - loop[0]!.steps) + 2 * (loop.length - 1);
      const estimate = estimateSpot(
        {
          rooms: loop.length,
          spawns: group.spawns,
          mobs,
          respawnSeconds: respawn,
          loopSteps: guessed,
          character,
          filler: []
        },
        c
      );
      if (estimate.deadly || estimate.costly) {
        excluded.dangerous += 1;
        continue;
      }
      if (estimate.trivial) {
        excluded.beneath += 1;
        continue;
      }
      priced.set(key, entry);
      survey.push({
        key,
        mobs,
        clock,
        boss: clock === 'regenTime',
        respawnSeconds: respawn,
        spawns: group.spawns,
        rooms: loop,
        filler: [],
        walk: loop,
        roomCount: rooms.length,
        loopSteps: guessed,
        estimate
      });
    }
    survey.sort(compareSpots);
    /*
     * Only the best are measured: a bounded sweep from each of a ring's rooms
     * is under a millisecond and there are thousands of groups, so the survey
     * ranks on the guess and measures `maxSpots` of them. A spot just below
     * the cut could measure into it; the guess is the same shape for all, so
     * the order it gives is the order the measurement mostly keeps. The rest
     * are handed back unmeasured rather than dropped: measuring all 910 of
     * Paradigm's cost 1.1s, and a list cut at twenty-four is not the realm.
     * The one a reader opened is measured too, so what it walks is a ring.
     */
    const rest = survey.slice(c.maxSpots);
    const opened = rest.findIndex((spot) => spot.key === measure);
    const chosen = survey.slice(0, c.maxSpots);
    if (opened !== -1) chosen.push(rest[opened]!);
    const spots = chosen.map((spot) =>
      this.measuredSpot(
        spot,
        priced.get(spot.key)!,
        priced,
        groupOfRoom,
        reach,
        character,
        c,
        world
      )
    );
    spots.sort(compareSpots);
    return {
      from: { id: from, name: start.name },
      radius,
      swept: reach.size,
      spots,
      unmeasured: opened === -1 ? rest : rest.filter((_, at) => at !== opened),
      excluded,
      assumptions: { ...assumptions, measured },
      refusal: null
    };
  }

  /**
   * One surveyed spot, measured: the ring's legs by a bounded sweep from each
   * of its rooms (`orderRing`), its size by the clock (`sizeLoop`), and the
   * clocked lairs of other admissible groups within `fillerRadius` of a ring
   * room added while each raises the rate (`addFiller`). A filler hangs off
   * the ring room it was found from, and the walk lists it there.
   */
  private measuredSpot(
    spot: HuntingSpot,
    own: HuntPriced,
    byKey: ReadonlyMap<string, HuntPriced>,
    groupOfRoom: ReadonlyMap<RoomId, string>,
    reach: ReadonlyMap<RoomId, number>,
    character: SpotCharacter,
    c: HuntingConstants,
    world: ErrandsWorld
  ): HuntingSpot {
    const candidates =
      own.group.via === 'lair' ? own.rooms.slice(0, c.maxLoopRooms) : own.rooms.slice(0, 1);
    if (candidates.length === 0) return spot;
    const sweeps = new Map<RoomId, Map<RoomId, number>>();
    // Priced by the traveller, as the survey's own sweep is: a ring whose
    // rooms are separated by a door this character cannot open is not a ring
    // it can walk, and the step count would be a fiction either way.
    const priced = this.travellerNow(this.tracker.current);
    for (const room of candidates) {
      sweeps.set(room.id, world.withinSteps(room.id, c.clusterRadius, priced));
    }
    const distance = (a: RoomId, b: RoomId): number | null =>
      sweeps.get(a)?.get(b) ?? sweeps.get(b)?.get(a) ?? null;
    const { order, ringSteps } = orderRing(candidates, distance);
    const base = (rooms: number): SpotInput => ({
      rooms,
      spawns: own.group.spawns,
      mobs: own.mobs,
      respawnSeconds: own.respawn,
      loopSteps: ringSteps(rooms),
      character,
      filler: []
    });
    const sized = sizeLoop(base, candidates.length, c);
    const ring = order.slice(0, sized.rooms);

    const offers: Array<{ room: HuntingRoom; after: number; input: FillerInput }> = [];
    const seen = new Set<RoomId>(candidates.map((room) => room.id));
    for (const [at, room] of ring.entries()) {
      const near = sweeps.get(room.id);
      if (near === undefined) continue;
      for (const [id, steps] of near) {
        if (steps === 0 || steps > c.fillerRadius || seen.has(id)) continue;
        const key = groupOfRoom.get(id);
        if (key === undefined || key === own.key) continue;
        const other = byKey.get(key);
        // A filler is a clocked lair another admissible group holds; a placed
        // boss is its own spot, and a room with no clock is hunted on luck.
        if (other === undefined || other.respawn === null || other.group.via !== 'lair') continue;
        const found = world.byId(id);
        if (!found) continue;
        seen.add(id);
        offers.push({
          room: {
            id,
            map: found.map,
            room: found.room,
            name: found.name,
            steps: reach.get(id) ?? room.steps + steps,
            mobs: other.mobs.map((mob) => mob.name),
            detour: 2 * steps,
            // Its own clock, which the survey already required of a filler —
            // and which the lap needs on the stop to walk the detour only on
            // the laps the room is standing (todo 15, `LoopStop.every`).
            respawnSeconds: other.respawn
          },
          after: at,
          input: {
            spawns: other.group.spawns,
            mobs: other.mobs,
            respawnSeconds: other.respawn,
            detourSteps: 2 * steps
          }
        });
      }
    }
    offers.sort((a, b) => a.input.detourSteps - b.input.detourSteps);
    const filled = addFiller(
      base(sized.rooms),
      offers.map((offer) => offer.input),
      c.maxLoopRooms,
      c
    );
    const taken = filled.taken.map((index) => offers[index]!);
    const walk: HuntingRoom[] = [];
    ring.forEach((room, at) => {
      walk.push(room);
      for (const offer of taken) if (offer.after === at) walk.push(offer.room);
    });
    const estimate: SpotEstimate = filled.estimate;
    return {
      ...spot,
      rooms: ring,
      filler: taken.map((offer) => offer.room),
      walk,
      loopSteps:
        ringSteps(sized.rooms) + taken.reduce((sum, offer) => sum + offer.input.detourSteps, 0),
      estimate
    };
  }

  /**
   * The configured heal, priced from its realm row: what one cast mends and
   * what it costs. Null where nothing is configured, the realm cannot name
   * it, the row carries no heal at all, or the cost is unstated — an unpriced
   * heal costs the estimate nothing, since resting is still the way the cycle
   * recovers.
   *
   * `healPower` is the one reading of what a cast mends, shared with
   * `chooseHealSpell` (todo 01): the survey and the healer must not disagree
   * about what a spell is worth.
   */
  private healingCast(state: CharacterState): HealingCast | null {
    const name = this.automationConfig.spells.heal.trim();
    if (name.length === 0 || this.world === undefined) return null;
    const spell = this.world.spellNamed(name);
    if (spell === null || spell === undefined) return null;
    const level = state.progress.level;
    if (level === null) return null;
    const power = healPower(spell, level);
    const mana = spell.mana ?? null;
    if (power === null || mana === null) return null;
    const hp = (power[0] + power[1]) / 2;
    if (hp <= 0) return null;
    return { hpPerCast: hp, manaPerCast: mana };
  }

  /**
   * Whether anything this character has ends a poison: a configured cure, an
   * antidote rule under `health.potions`, or — under `autoChoose`, where the
   * blank cure box is filled from the book — a spell the read book holds that
   * the realm says serves it. An unread book yields nothing.
   */
  private curesPoison(state: CharacterState): boolean {
    const { spells, health } = this.automationConfig;
    if (spells.cures.poison.trim().length > 0) return true;
    if (health.potions.some((rule) => rule.when === 'poisoned' && rule.name.trim().length > 0)) {
      return true;
    }
    if (!spells.autoChoose || state.spellbook === null || this.world === undefined) return false;
    const world = this.world;
    return state.spellbook.some(
      (known) => spellServes(world.spellNamed(known.name)?.abilities).poisoned
    );
  }

  /**
   * The better lair, in a sentence, for the lap that stopped for earning too
   * little — or null when nothing within `tuning.hunting.betterSpotRadius`
   * has a known rate. The stop was already loud; this makes it useful.
   */
  betterHuntingWords(): string | null {
    const { betterSpotRadius } = tuning().hunting;
    const advice = this.huntingGrounds(betterSpotRadius);
    const best = advice.spots.find((spot) => spot.estimate.expPerHour !== null);
    const first = best?.rooms[0];
    if (!best || !first || best.estimate.expPerHour === null) return null;
    return t('session.hunt.better', {
      mobs: best.mobs.map((mob) => mob.name).join(', '),
      room: `${first.name} ${first.map}/${first.room}`,
      steps: first.steps,
      rate: Math.round(best.estimate.expPerHour).toLocaleString()
    });
  }

  /**
   * The name to type for a key this character is actually carrying.
   *
   * Both halves are refusals rather than defaults, and each is the same
   * refusal something else in this file already makes:
   *
   * - **An unlisted pack is not an empty one, and it is not a full one
   *   either.** `packKnown` is the gate the router and `AutoKeys` both read,
   *   and it is what stops a `use` going out on the strength of a pack nobody
   *   has read — the answer would be `Your command had no effect.`, said for
   *   a key the character may well be holding.
   * - **A row the realm cannot name is not typed.** `use  n` is not a
   *   command, and inventing a name for the row would be a guess with a door
   *   on the end of it.
   *
   * The realm's own spelling is what goes out, not the pack listing's: the
   * two agree for a key, and the realm's is the one the row is keyed by.
   */
  keyToUse(keyId: number): string | null {
    const state = this.tracker.current;
    const pack = this.packContents(state);
    if (!pack.packKnown || !pack.keys.includes(keyId)) return null;
    return this.world?.item(keyId)?.name ?? null;
  }

  /**
   * What the pack holds, as `Items` row ids, for a keyed door and an item
   * gate — one question the server answers one way, so one field.
   *
   * **Both halves of the listing**, because the server prints them as two:
   * `You are carrying …` and `You have the following keys: bone key.` are
   * separate lines and separate fields, and a keyed door asked only about
   * the first would find no key in a pack that has one.
   *
   * Only the names the realm places, and only where a name resolves to a
   * single row: twenty of the shipped realm's item names are shared, four
   * of them keys, and a pack that guessed which `iron key` it was carrying
   * would open a door on a coin toss. The pack itself is the maintained
   * listing (`replayPack`), so this is as current as the last `i` plus
   * every pick-up since.
   *
   * **The join itself moved onto the state** (2026-09-15): `Inventory.rows` is
   * made at the tracker's one commit point, so the quest book can tick what is
   * carried without a second reading of the same question in the window — and
   * the A* stopped re-walking the whole pack for every room it expands that
   * casts something.
   *
   * `packKnown` says whether that list is an answer or a silence. `i` is in
   * the default `onEnterRealm`, so it is true within a second of entering the
   * realm on any ordinary configuration — but the probe list is the player's,
   * and a character told never to ask on the way in must not silently become
   * a character whose every keyed door is a wall.
   *
   * **Its own method because two things ask it** (2026-09-06): the router,
   * through `travellerNow`, and `AutoKeys`, which decides whether to pick a
   * key up off the floor. Those two reading the pack differently is the "two
   * halves of one gate in two files" failure at its worst — the client would
   * bend down for a key it already had, or stand on one it needed.
   */
  packContents(state: CharacterState): { keys: number[]; packKnown: boolean } {
    return { keys: state.inventory.rows, packKnown: state.inventory.listedAt !== null };
  }

  /**
   * What the realm says the exits of the room being stood in demand.
   *
   * The **realm's** exit list rather than the printed one, because that is
   * what the router plans through: it holds hidden exits the server never
   * prints, and a key picked up for a door the client has not found yet is
   * still the key the route will want. An unplaced room has no list, which is
   * the refusal every other realm lookup makes rather than guessing.
   */
  keyedWaysHere(state: CharacterState): KeyedWay[] {
    const { map, number } = state.room;
    if (!this.world || map === null || number === null) return [];
    const room = this.world.get(map, number);
    if (room === undefined) return [];
    const ways: KeyedWay[] = [];
    for (const exit of room.exits) {
      const requirement = exit.requirement;
      if (requirement === null) continue;
      // Both instructions that name an item, because `edgeBlock` reads both
      // the same way: a `Key:` lock and an `Item:` gate ask *is this thing in
      // the pack*, and one of them bending down and the other not would be
      // one gate answered two ways.
      if (requirement.kind !== 'key' && requirement.kind !== 'item') continue;
      if (requirement.keyId === undefined) continue;
      // The realm's own name for the row travels with it, so `AutoKeys` can
      // tell *this floor holds nothing relevant* from *this floor holds
      // something of that name and the realm has three of them* — and say the
      // second one out loud instead of standing there.
      const named = this.world.item(requirement.keyId)?.name;
      ways.push({
        keyId: requirement.keyId,
        direction: exit.direction,
        ...(named === undefined ? {} : { itemName: named })
      });
    }
    return ways;
  }

  /**
   * The corridors of every route this character prefers, derived once from
   * its loops and kept until the loops or the realm change.
   *
   * Derived here rather than in the graph because a stop is resolved the way
   * a loop's stop is (`findStop`), and a route with a stop the realm cannot
   * settle is said out loud once — a preference that silently prefers
   * nothing is a setting somebody edits and then waits to see work. Each leg
   * by `lapTraveller`, so the corridor preferred is the one the lap walks.
   */
  preferredEdges(): ReadonlySet<string> {
    if (this.preferred !== null) return this.preferred;
    if (!this.world) return NO_EDGES;
    const found = preferredEdges(
      this.world,
      this.automationConfig.loops,
      (stop) => this.stopRoom(stop),
      this.lapTraveller(this.tracker.current)
    );
    for (const name of found.unresolved) {
      this.session.notice(t('session.loop.preferUnresolved', { loopName: name }));
    }
    this.preferred = found.edges;
    return found.edges;
  }

  /** Where a loop's stop is, by name and optional coordinates. */
  findStop(stop: {
    name: string;
    at: { map: number; room: number } | null;
  }): { map: number; room: number } | string {
    if (stop.at) return stop.at;
    const found = this.world?.findByName(stop.name) ?? [];
    if (found.length === 0) return t('session.loop.unknownStopName', { name: stop.name });
    // Thirteen rooms are called Town Gates; a loop that guessed which would
    // walk somewhere the player did not mean.
    if (found.length > 1) {
      return t('session.loop.ambiguousStopName', {
        count: found.length,
        name: stop.name,
        map: found[0]!.map,
        room: found[0]!.room
      });
    }
    return { map: found[0]!.map, room: found[0]!.room };
  }

  /** A loop's stop as a room, or null where `findStop` cannot settle it. */
  stopRoom(stop: Parameters<Errands['findStop']>[0]): RoomId | null {
    const found = this.findStop(stop);
    return typeof found === 'string' ? null : roomId(found.map, found.room);
  }

  /**
   * The spells the server has stated up on this character with a countdown
   * still running, as the realm's ids (todo 105). Only a stated clock — the
   * Paramud `st` sheet's timer — because a buff recorded without one may
   * have lapsed, and the router prices on nothing that may have. Every name
   * a buff could be is resolved, as `Blessings.sameSpell` resolves one.
   */
  spellsUp(state: CharacterState): number[] {
    const world = this.world;
    if (world === undefined || state.buffs.length === 0) return [];
    const now = Date.now();
    const up: number[] = [];
    for (const buff of state.buffs) {
      if (buff.expiresAt === undefined || buff.expiresAt <= now) continue;
      for (const name of [buff.spell, ...(buff.candidates ?? [])]) {
        const id = world.spellNamed(name)?.id;
        if (id !== undefined && !up.includes(id)) up.push(id);
      }
    }
    return up;
  }

  /**
   * What the counter in this room charges for one of a thing by this name, in
   * copper before charm — the shelf row the name answers to, priced by the
   * realm (`WorldGraph.priceAt`). Null where the room holds no counter, the
   * shelf no such row, or the realm file no coin.
   */
  priceAt(name: string, shop: RoomId): number | null {
    const world = this.world;
    const row = world?.byId(shop)?.shop;
    const counter = row === undefined ? undefined : world?.shop(row);
    const line = counter?.items.find((each) => nameAnswersTo(bareName(each.name), bareName(name)));
    if (world === undefined) return null;
    return counter === undefined || line === undefined ? null : world.priceAt(line.id, counter.id);
  }

  /**
   * Where a supply's shop is, settled the way a loop's stop is.
   *
   * The room the list states first — six rooms are called General Store and
   * the one the player chose is the one that counts — and the shop's name
   * through `shopPlace` where it states none, refused where the name is in
   * several rooms or none. A resolved room whose realm row holds no shop is
   * refused too: the list may have been written against a different realm.
   */
  shopRoom(item: SupplyItem): { room: RoomId; name: string } | string {
    const world = this.world;
    if (world === undefined) return t('session.loop.noRealmData');
    if (item.at !== null) {
      const placed = world.get(item.at.map, item.at.room);
      if (placed === undefined || placed.shop === undefined) {
        return t('session.supplies.noShopAt', { map: item.at.map, room: item.at.room });
      }
      const shop = world.shop(placed.shop);
      return { room: roomId(item.at.map, item.at.room), name: shop?.name ?? placed.name };
    }
    if (item.shop.trim().length === 0) return t('session.supplies.noShopNamed');
    const place = world.shopPlace(item.shop);
    if (place === undefined) return t('session.supplies.shopUnplaced', { shop: item.shop });
    if (place.at === 'several') {
      return t('session.supplies.shopAmbiguous', { shop: item.shop, count: place.count });
    }
    return { room: roomId(place.map, place.room), name: item.shop };
  }

  /**
   * What a round costs this character in mana, for the hunting model
   * (todo 26, 2026-09-12).
   *
   * **Only from a spell the player has actually configured.** A character with
   * a blank `spells.attack` fights with `combat.attack`, which costs nothing
   * from the pool — so null here, and the estimate is exactly the melee one.
   * A derived spell under `autoChoose` is not read: it is chosen per target
   * from what is in front of the character, and a hunting estimate is about a
   * room the character is not standing in.
   *
   * Null too where the realm cannot price the spell, which is the standing
   * rule: an unknown cost is never zero, and zeroing it would report a
   * caster's cycle as free.
   */
  private castingCost(state: CharacterState): {
    manaPerRound: number | null;
    manaMax: number | null;
  } {
    const name = this.automationConfig.spells.attack.trim();
    if (name.length > 0) {
      const spell = this.world?.spellNamed(name) ?? null;
      return { manaPerRound: spell?.mana ?? null, manaMax: state.vitals.manaMax };
    }
    /*
     * Under `autoChoose` the round spell is derived, so the survey prices the
     * one the book would yield against an unread monster — the hardest hitter
     * the pool can pay for (todo 108). Null where nothing casts.
     */
    const { combat, magery, family } = this.realmClass();
    const casting = this.castingInput(state, prowessSheetOf(state, { combat, magery }), family);
    if (casting === null) return { manaPerRound: null, manaMax: null };
    const choice = chooseAttackSpell({ ...casting, target: null, excluded: new Set() });
    return {
      manaPerRound: choice.chosen?.cost ?? null,
      manaMax: state.vitals.manaMax
    };
  }

  /**
   * The character's own side of the combat arithmetic, for the engine's
   * ranking and the room's appraisal alike: the realm's `CombatLVL` and
   * `MageryLVL` for this class — the stat sheet prints neither — and which
   * lineage's formulas the server runs.
   *
   * Read at the point of use rather than captured, because `this.world`
   * arrives with `useRealm` and the class is not known until a stat sheet
   * has been read. The server's family (`Vocabulary.family`, through
   * `ErrandsSession.family`) and not the realm data's, deliberately: this
   * decides which *formulas* run, and the formulas are the server's. The two
   * can legitimately differ — see `Vocabulary.noteFamily` — and on the
   * shipped configuration they do.
   */
  realmClass(): RealmClass {
    const row = this.world?.classNamed(this.tracker.current.className ?? '') ?? null;
    return {
      combat: row?.combat ?? null,
      magery: row?.magery ?? null,
      family: this.serverFamily
    };
  }

  /**
   * What this character can do, from the realm's class and race rows.
   *
   * One reading for every module that asks, because the server asks one
   * question: `GetAbility(x)` looks across every container, and a Ninja's
   * picklocks and a Gnome's are the same fact to it. Read at the point of use
   * like `realmClass`, since the world arrives with `useRealm` and neither
   * word is known until a stat sheet has been read.
   *
   * `null` where neither row is known, which every reader treats as *unknown*
   * rather than *no* (todo 22).
   */
  capabilities(): Capabilities {
    const world = this.world;
    const state = this.tracker.current;
    return capabilitiesOf(
      state.className ? (world?.classNamed(state.className)?.abilities ?? null) : null,
      state.race ? (world?.raceAbilities(state.race) ?? null) : null
    );
  }

  /**
   * What a monster's blow or cast is measured against: the sheet's three
   * figures, the protection the server adds that the sheet does not print,
   * and the character's dodge. `AutoCombat.weigh` reads the same.
   */
  menacePlayer(state: CharacterState): MenacePlayer {
    const { combat, magery, family } = this.realmClass();
    return {
      armourClass: state.progress.armourClass,
      damageResist: state.progress.damageResist,
      magicRes: state.progress.magicRes,
      ...protectionOf(state, (name) => this.world?.spellNamed(name) ?? null),
      dodge: dodge(prowessSheetOf(state, { combat, magery }), family)?.value ?? null
    };
  }

  /**
   * What `chooseAttackSpell` needs to say which spell this character would
   * cast, or null where the character does not cast by derivation: the switch
   * off, the book unread, or no realm to price it against (todo 108).
   */
  castingInput(
    state: CharacterState,
    sheet: ProwessSheet,
    family: RealmFamily | null
  ): CastingInput | null {
    if (!this.automationConfig.spells.autoChoose) return null;
    if (state.spellbook === null || this.world === undefined) return null;
    const world = this.world;
    return {
      book: state.spellbook,
      realm: (name) => world.spellNamed(name) ?? null,
      level: state.progress.level,
      // The full pool: the survey prices a fight begun rested, not the one in progress.
      mana: state.vitals.manaMax ?? state.vitals.mana,
      sheet,
      family,
      killConfidence: tuning().spells.killConfidence
    };
  }

  /**
   * Which slot an equipment set's item goes in, and how many hands it takes.
   *
   * **The pack first, the catalogue second.** A carried item already carries
   * the realm's own reading joined onto it (`ItemEntity.realmSlot`,
   * `weapon.hands`), resolved against the row this character is actually
   * holding; the catalogue is a name, and a name can hold several rows — the
   * `flail` that is one-handed in one row and two-handed in another is the
   * measured case (`src/shared/items.ts`). Null where neither can say, which
   * `kitFor` and `swapPlan` both read as *unknown* rather than as a refusal.
   */
  gearSlotOf(name: string): string | null {
    const carried = this.tracker.current.inventory.items.find((item) => sameItem(item.name, name));
    return (
      carried?.realmSlot ?? carried?.slot ?? this.world?.itemsNamed([name])[name]?.slot ?? null
    );
  }

  gearHandsOf(name: string): 1 | 2 | null {
    const carried = this.tracker.current.inventory.items.find((item) => sameItem(item.name, name));
    return carried?.weapon?.hands ?? this.world?.itemsNamed([name])[name]?.weapon?.hands ?? null;
  }

  /**
   * What the character has to see by — realm data crossed with the pack.
   *
   * The realm's item table is what says a `glowing pearl` is a light at all
   * (`kind: 'light'`); the `i` listing is what says how many charges are left,
   * and the server treats a spent one as absent — `use glowing pearl` answers
   * `You don't have glowing pearl.` for a pearl reading `(Readied/0)`, measured
   * live 2026-08-27. Neither half answers alone.
   *
   * **A spent light beats a full one** in the answer, because the point of
   * asking is the warning: a character carrying a dead pearl and a live torch
   * is fine, so `carried` wins the moment anything usable is found, and `spent`
   * is only reported when nothing usable was.
   *
   * Nothing is claimed about whether a carried light is *burning*. Nothing on
   * the wire says so.
   */
  lightSource(state: CharacterState): {
    state: 'spent' | 'carried' | 'none';
    name: string | null;
  } {
    if (!this.world) return { state: 'none', name: null };
    const named = this.world.itemsNamed(state.inventory.items.map((item) => item.name));
    let spent: string | null = null;
    for (const item of state.inventory.items) {
      if (named[item.name]?.kind !== 'light') continue;
      // Charges unstated is not zero: the listing simply did not count, and a
      // warning fired on an unknown would cry wolf on every torch.
      if (item.charges !== 0) return { state: 'carried', name: item.name };
      spent ??= item.name;
    }
    return spent === null ? { state: 'none', name: null } : { state: 'spent', name: spent };
  }

  /**
   * What the realm says the spells an onset names do to movement, three ways.
   *
   * `EffectTracker.heldByOnset` reads the same rows and sets the flag where
   * one holds; the walker's own reading of *a step, an onset, then silence*
   * exists for the sentence the realm cannot judge, and this is what tells it
   * which case it is in. `null` — no candidate, a spell the realm lacks, a row
   * with no ability data — is *cannot say*, and only then does the sequence
   * stand as evidence. A `false` is a blessing landing behind a step, which is
   * what `c prev` did on 2026-09-12 and held the next step half a minute.
   */
  spellsHold(spells: readonly string[]): boolean | null {
    if (spells.length === 0 || !this.world) return null;
    const rows = spells.map((name) => this.world?.spellNamed(name) ?? null);
    if (rows.some((row) => row?.abilities === undefined)) return null;
    return rows.some((row) => holdsMovement(row));
  }

  /**
   * The room's own spell and what it does, for the ward kept up off the pack
   * (`WardSources.hazardAt`), or null where it casts nothing the reader could
   * follow.
   */
  hazardAt(room: RoomId): ReturnType<WardSources['hazardAt']> {
    const world = this.world;
    const found = world?.byId(room);
    if (world === undefined || found === undefined || found.spell === undefined) return null;
    const spell = world.spellById(found.spell);
    const hazard = spell?.hazard;
    return spell === null || spell === undefined || hazard === undefined ? null : { spell, hazard };
  }

  /**
   * How soon a room's lair makes its monsters again, for the rest next door
   * (`RestAwayPlanner.lairClock`): the realm's own clock, read the way
   * `huntingGrounds` reads it. Null for a room with no lair.
   */
  lairClock(room: RoomId): number | null {
    const found = this.world?.byId(room);
    if (!found?.lair) return null;
    const { greatermudRespawnOffsetSeconds } = tuning().hunting;
    return respawnSeconds(found.delay ?? null, this.serverFamily, {
      greatermudRespawnOffsetSeconds
    });
  }

  /**
   * The rooms next door the realm holds no lair and no resident in, plain
   * exits first (`RestAwayPlanner.neighbours`).
   */
  neighbours(room: RoomId): ReturnType<RestAwayPlanner['neighbours']> {
    const found = this.world?.byId(room);
    if (!found) return [];
    return found.exits
      .flatMap((exit) => {
        /*
         * **Never through a way that teleports.** The whole premise here
         * is *step next door, rest, step back*, and an exit whose cast
         * moves the character puts them somewhere the step back does not
         * undo — a maze, or the far side of the realm. The peek would
         * also be judging the wrong room: `l <direction>` describes the
         * room the exit table names, which is not where walking it ends
         * up. Both kinds are out, the draw for the stronger reason that
         * there is no one room to peek at.
         */
        const moves = exit.requirement?.spellEffect;
        if (moves === 'teleports' || moves === 'scatters') return [];
        const to = roomId(exit.map, exit.room);
        const next = this.world?.byId(to);
        if (!next || next.lair !== undefined || next.npcId !== undefined) return [];
        const direction = asDirection(exit.direction);
        if (direction === null) return [];
        return [{ direction, to, name: next.name, plain: exit.requirement === null }];
      })
      .sort((a, b) => Number(b.plain) - Number(a.plain))
      .map(({ direction, to, name }) => ({ direction, to, name }));
  }

  /**
   * A route between two rooms the character is standing in neither of
   * (`WalkerEvents.routeBetween`), priced by the traveller the walk it is
   * asked for is priced by.
   */
  routeBetween(from: RoomId, to: RoomId, shortest: boolean): Route | string {
    return (
      this.world?.route(
        from,
        to,
        shortest ? this.lapTraveller(this.tracker.current) : this.travellerNow(this.tracker.current)
      ) ?? t('session.loop.noRealmData')
    );
  }
}

/**
 * The sheet's figure for a stat a `testskill` names, or null where the sheet
 * has not said or prints no such figure (todo 106). The script's words are
 * `TextBlockPart.cs`'s own switch: `wisdom` reads the sheet's Willpower,
 * `stealth` its Stealth figure, `magicresistance` its MR. Anything else —
 * `current_hp`, a word a derivative invents — is unknown, never zero.
 */
function statFigure(state: CharacterState, stat: string): number | null {
  const sheet = state.progress;
  switch (stat.toLowerCase()) {
    case 'intellect':
      return sheet.intellect;
    case 'strength':
      return sheet.strength;
    case 'health':
      return sheet.health;
    case 'charm':
      return sheet.charm;
    case 'agility':
      return sheet.agility;
    case 'wisdom':
      return sheet.willpower;
    case 'perception':
      return sheet.perception;
    case 'stealth':
      return sheet.stealthSkill;
    case 'picklocks':
      return sheet.picklocks;
    case 'traps':
      return sheet.traps;
    case 'thievery':
      return sheet.thievery;
    case 'spellcasting':
      return sheet.spellcasting;
    case 'tracking':
      return sheet.tracking;
    case 'magicresistance':
      return sheet.magicRes;
    default:
      return null;
  }
}
