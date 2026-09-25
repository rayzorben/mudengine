/**
 * The session's walking, looping and running away: the one door through which
 * a route, a lap, a step back and an escape are started, resumed and stopped,
 * and what a lost connection carries. It holds what a journey still owes (the
 * route owed back, the choice to cross, the walk home) and plans through
 * `Errands`, so the walker and the loop runner never learn the world. See
 * `mudengine-session` › *Travel and errands are adapters beside the session*,
 * and `mudengine-automation`'s safety, walking and loops parts.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { AutoCombat } from '../automation/AutoCombat';
import type { AutoHunt } from '../automation/AutoHunt';
import type { CombatLease } from '../automation/CombatLease';
import type { CommandQueue } from '../automation/CommandQueue';
import type { ItemErrand } from '../automation/ItemErrand';
import type { LoopRunner } from '../automation/LoopRunner';
import type { SessionModule } from '../automation/Module';
import type { QuestRunner } from '../automation/QuestRunner';
import type { Supplies } from '../automation/Supplies';
import type { TrainErrand } from '../automation/TrainErrand';
import { fightIsRunning, type Walker } from '../automation/Walker';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { WorldGraph } from '../world/WorldGraph';
import type { Errands } from './Errands';
import { anotherLoop, refusesToPlay, type PlayReading } from './Play';
import { healthFraction, percentText, type SafetyDecision } from '../../shared/automation';
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import { stanceHere } from '../../shared/mobRules';
import { splitStop, type Loop, type LoopProgress } from '../../shared/loops';
import type { Movement, MovementStart, WalkStart } from '../../shared/movement';
import { landed, stillFled, type FledRoom } from '../../shared/walk';
import {
  asDirection,
  crossedWords,
  DIRECTION_NAME,
  newDemands,
  OPPOSITE,
  roomAddress,
  roomId,
  type Direction,
  type RoomId,
  type Route,
  type TrailStep
} from '../../shared/world';

/** `escapeRefusalSaid` for a character nothing is taking anywhere, which no room key can equal. */
const STAYING = '\0staying';

/**
 * How well the client knows the exit it is running through. See
 * `wayOut`, which is where the ladder is written out.
 *
 * Reported rather than kept: it goes into the notice, so a player watching the
 * console can tell *retracing north* from *taking the only exit the server
 * printed*, and into `AutomationSnapshot.safety` so it survives the scrollback.
 */
type EscapeRung = 'retrace' | 'doubles-back' | 'known' | 'printed';

/**
 * One sentence per rung, so the console says which one answered.
 *
 * A switch of literal `t()` calls rather than a rung → key map, because
 * `i18n-coverage.test.ts` reads literal calls out of the source and a lookup
 * would be a dynamic one — which the same test fails the build for, and rightly:
 * a key nothing literally asks for is a key nobody can tell is dead. The four
 * are exhaustive over `EscapeRung`, which the compiler checks.
 */
function escapeNotice(how: EscapeRung, direction: Direction, why: string): string {
  switch (how) {
    case 'retrace':
      return t('session.safety.escapeRetrace', { direction, why });
    case 'doubles-back':
      return t('session.safety.escapeDoublesBack', { direction, why });
    case 'known':
      return t('session.safety.escapeKnown', { direction, why });
    case 'printed':
      return t('session.safety.escapePrinted', { direction, why });
  }
}

/**
 * Whether an exit wants something before it will let anybody through.
 *
 * A sort key, never a filter: a shut door is one refusal away from being an
 * exit, and every rung below the trail is a room the character has never seen
 * anyway. Preferring the plain one costs nothing and taking the noted one
 * beats standing in the room.
 */
function encumbered(exit: { note: string | null; requirement?: unknown }): boolean {
  return exit.note !== null || (exit.requirement ?? null) !== null;
}

/**
 * The leg an errand walks the character on: said, never the player's asking,
 * held while hurt, picked up after a fight and never started in one, and owed
 * to nobody across a lost connection. The kit's, the trainer's, a quest's and
 * the item errand's (`walkLegTo`).
 */
export const ERRAND_LEG = {
  quiet: false,
  asked: false,
  holdWhenHurt: true,
  resumeAfterFight: true,
  whileFighting: false,
  resumeAfterLoss: false
} as const;

/** What the journeys are walked, planned and fought with. */
export interface TravelParts {
  readonly tracker: Pick<
    CharacterTracker,
    'current' | 'pendingMoves' | 'trail' | 'wayBackFrom' | 'retraced'
  >;
  readonly world: Pick<WorldGraph, 'byId' | 'route'> | undefined;
  readonly errands: Pick<
    Errands,
    'planFromHere' | 'travellerNow' | 'lapTraveller' | 'askCountersFor' | 'findStop'
  >;
  readonly queue: Pick<CommandQueue, 'enqueue'>;
  readonly walker: Pick<
    Walker,
    'start' | 'stop' | 'walking' | 'holding' | 'progress' | 'journey' | 'unfinished' | 'noteEscaped'
  >;
  readonly loops: Pick<
    LoopRunner,
    | 'progress'
    | 'start'
    | 'stop'
    | 'resume'
    | 'restate'
    | 'noteEscaped'
    | 'noteOnline'
    | 'carried'
    | 'heading'
    | 'strayedFrom'
  >;
  readonly combat: Pick<AutoCombat, 'willFight' | 'declineWhileTravelling'>;
  readonly combatLease: Pick<CombatLease, 'lending' | 'run' | 'onWalkEnded'>;
  readonly supplies: Pick<Supplies, 'current' | 'considerBeforeRoute' | 'abandon'>;
  readonly trainLevel: Pick<TrainErrand, 'busy' | 'abandon'>;
  readonly hunt: Pick<AutoHunt, 'noteStopped' | 'noteLapStopped'>;
  readonly itemErrand: Pick<ItemErrand, 'running' | 'collect' | 'abandon'>;
  readonly questRunner: Pick<QuestRunner, 'running' | 'abandon'>;
}

/** What the session that built this answers for it. */
export interface TravelSession {
  /** The automation settings as last loaded. */
  config(): AutomationConfig;
  /**
   * What the character is doing about going anywhere, read through the
   * session's own getter: one door onto the fact, the one every reader and
   * `SessionManager.test.ts`'s `underWay` go through.
   */
  movement(): Movement;
  /** A loop this character's options define. See `SessionManager.loopNamed`. */
  loopNamed(name: string): Loop | undefined;
  /** What is still waiting of the talk box's lines. See `SessionManager.dropTyped`. */
  dropTyped(died: boolean): void;
  notice(message: string): void;
  /** A safety decision, for the trace. */
  decided(decision: SafetyDecision): void;
}

export class Travel implements SessionModule {
  private readonly tracker: TravelParts['tracker'];
  private readonly world: TravelParts['world'];
  private readonly errands: TravelParts['errands'];
  private readonly queue: TravelParts['queue'];
  private readonly walker: TravelParts['walker'];
  private readonly loops: TravelParts['loops'];
  private readonly combat: TravelParts['combat'];
  private readonly combatLease: TravelParts['combatLease'];
  private readonly supplies: TravelParts['supplies'];
  private readonly trainLevel: TravelParts['trainLevel'];
  private readonly hunt: TravelParts['hunt'];
  private readonly itemErrand: TravelParts['itemErrand'];
  private readonly questRunner: TravelParts['questRunner'];
  /**
   * When an escape was last *asked for*, so a failed one is retried rather than
   * spammed. Armed whether or not a way out was found.
   */
  private lastAskedToEscape = 0;
  /**
   * When a move was last actually sent to get out of a fight. Zero for never.
   *
   * **Two clocks, because they answer two questions**, and they used to be one
   * number: the cooldown on *asking* and the window in which a move is *in
   * flight*. That was harmless while the escape always enqueued something — and
   * became a defect the moment it could decide to send nothing, because
   * `isRetreating()` reads this one and everything that could keep a character
   * alive is gated on it: auto-combat and retaliation stand down, and so do the
   * heal, the potion, the cures, the blessings and `mayRest`. A room with no
   * exit the client can name would have printed *Standing and fighting* every
   * three seconds while having just switched fighting, healing and resting off
   * — the notice saying the opposite of what the code did.
   */
  private lastEscapeSent = 0;
  /**
   * The escape's last refusal, as room, reason and what happens instead, so
   * it is said once rather than on every prompt of the fight it refused out
   * of (todo 00: a dog's twenty-five seconds printed it five times). Cleared
   * by an escape that goes, and by the fight ending.
   */
  private escapeRefusalSaid: string | null = null;
  /**
   * The monster an `escape` row names that the retreat switch left standing
   * in the room, by key, so the refusal is said once while it stays (818).
   */
  private dreadSaid: string | null = null;
  /**
   * The escape whose answer has not come: the direction sent, by when, how
   * many times its door has been opened, and every direction tried from this
   * room. A declared postcondition, as `Walker` arms `expecting` — the escape
   * used to be complete the moment the byte left, and `The door is closed!`
   * was recorded as an escape (todo 06, 2026-09-12). See `settleEscape`.
   */
  private escapeAwaiting: {
    direction: Direction;
    how: EscapeRung;
    why: string;
    deadline: number;
    opened: number;
    tried: Set<Direction>;
  } | null = null;
  /**
   * Rooms this character has run out of, newest last, while the fight it ran
   * from is still going.
   *
   * **The escape must not retrace its own escape.** `CharacterTracker.trail`
   * records every confirmed move whoever sent it, which is the whole point of
   * it — and the escape's own move is one of those. So one second after running
   * `s` out of a lair, `wayBackFrom` names that very step and the reverse of it
   * is `n`, back through the door: the client runs out, walks in, runs out,
   * walks in, at cooldown speed. That is the cave-worm oscillation measured on
   * a loop (`logs/2026-09-02_09-58-25_festus.mudcap.jsonl`) reproduced inside
   * the escape, with no `escapeSettleMs` hold to stop it and a 100%-follower
   * monster — 374 rows of the shipped realm — to make it certain.
   *
   * **Each entry carries the moment it was run out of, and is forgotten on a
   * clock rather than on an instant** (todo 12, 2026-09-12). The clear used to
   * read *not in combat and no recorded attackers*, which a fight against two
   * monsters manufactures for free: `*Combat Off*` names the death of the
   * current **target**, not the end of the fight, and the dead leave
   * `attackers` with the kill — so between one champion dying and the second
   * swinging again, a two-monster fight is indistinguishable from no fight at
   * all. The list emptied there, and the next escape picked the room it had
   * fled three seconds earlier. Four reproductions, three areas, four deaths.
   * The protection was strongest against one monster and absent against
   * several, which is exactly backwards.
   *
   * So two things must hold before a room is safe to walk back into: nothing
   * is fighting by `fightIsHere`'s standard — the one `Recovery` already
   * applies for the same reason, a hazard that is real while momentarily
   * unrecorded — **and** the escape is old enough that the fight it ran from
   * cannot still be the fight in progress (`tuning.walk.ranFromForgetMs`).
   *
   * Bounded in length too, because a chain of escapes must avoid every room in
   * it: running A→B→C and then back into A is the same mistake one link
   * longer.
   */
  private ranFrom: FledRoom[] = [];
  /** A `safe-haven` walk home waiting for the fight to end; see `walkHomeIfDue`. */
  private retreat: { room: string; armedAt: number; from: string | null } | null = null;
  /**
   * The safe room a walk home is under way to. A fight on the way ends that
   * walk (`resumeAfterFight: false`), and re-arming `retreat` there keeps the
   * journey going after it and keeps the character going somewhere (todo 03).
   */
  private homeward: string | null = null;
  /**
   * Where a route the player was walking still owes them, across a lost
   * connection. See `pickUpAfterLoss`.
   *
   * Taken from `Walker.journey` at the moment the socket goes and only for a
   * loss — a deliberate disconnect is the player ending the session — and
   * spent the first time the character is back in the realm and placed, or
   * dropped when anything supersedes it: a new walk, leaving the realm, a dial
   * to a different realm. The loop keeps its own place (`LoopRunner.carried`);
   * this is the one journey with nobody else holding its destination.
   */
  private journey: { to: RoomId; name: string; run: boolean } | null = null;
  /**
   * The kept-out words the player chose to cross to reach one room (todo 806):
   * a route asked for through a way `movement.keepOutOf` names, picked on the
   * panel over the way round. Tied to the destination rather than the walk,
   * so a stop, a resume, an errand or a lost connection plans the way again
   * as the player chose it; replaced by the next route asked for, cleared on
   * arrival, and never lent to a lap's leg. See `planFromHere`.
   */
  private crossing: { to: RoomId; words: readonly string[] } | null = null;
  /**
   * A route the player asked for that a supply errand went shopping instead of.
   *
   * The errand's own reason for existing is that the character is about to go
   * somewhere, so it takes the character first and hands it back — the same
   * bargain `LoopRunner.noteErrand` strikes with a lap. Kept as the destination
   * rather than the route, because the character is somewhere else by the time
   * it is owed and the way back is planned from where it stands.
   *
   * Dropped by anything that supersedes it: another route asked for, a death
   * (`stopGoingAnywhere`), leaving the realm. Deliberately **not** dropped by
   * `WalkerEvents.destination` as `journey` is — the errand's own legs each
   * fire it, and clearing there would forget the route the moment it was owed.
   */
  private errandOwes: {
    to: RoomId;
    name: string;
    run: boolean;
    /** The kept-out words the owed route crossed, which the player chose. */
    crossing: readonly string[];
  } | null = null;
  /**
   * A back press that is being walked: the room it is going back to, and the
   * trail entry it is walking back over.
   *
   * The **entry** is the mark, because the way back may be several steps and
   * each of them records itself on the trail — so what has to be given up on
   * arrival is that entry and everything after it. A length would name a
   * different move once the trail is at `trailSteps` and every push shifts the
   * oldest off. See `stepBack` and `CharacterTracker.retraced`.
   */
  private steppingBack: { to: RoomId; step: TrailStep } | null = null;
  /**
   * Whether `pickUpAfterLoss` has said, this connection, that it is waiting
   * for the room. Once, because the entry probe is what asks, and this is only
   * ever waiting for the answer; reset at `connect` and on leaving the realm.
   */
  private saidWaitingToBePlaced = false;
  /** Whether the walk in progress is one the player asked for. See `CombatLease`. */
  private walkAsked = false;
  /** And whether it was asked for with *Run it*: auto-combat off, and left off (todo 06). */
  private walkRun = false;
  /**
   * Followers who said `@wait` and have not yet said `@ok`, lower-cased.
   *
   * A set, not a flag: two followers may fall behind independently, and the
   * loop walks on only when the *last* of them has stood back up. Forgotten on
   * connect — a reconnect is a new session, and a `@wait` from the old one
   * must not hold a loop nobody asked it to.
   */
  private readonly waitingFollowers = new Set<string>();
  /**
   * Whether the loop's current pause is this session's own answer to `@wait`.
   *
   * `@ok` may only resume what `@wait` stopped: a stop the player chose from
   * the Loop card is theirs to end, and a follower's `@ok` walking a
   * hand-stopped loop away would be somebody else's typing moving this
   * character. Cleared the moment the loop is seen in any state but `stopped`,
   * because however the hold ended — resumed here, resumed by hand, started
   * afresh, reset — the claim is spent.
   */
  private pausedForFollowers = false;

  constructor(
    parts: TravelParts,
    private readonly session: TravelSession
  ) {
    this.tracker = parts.tracker;
    this.world = parts.world;
    this.errands = parts.errands;
    this.queue = parts.queue;
    this.walker = parts.walker;
    this.loops = parts.loops;
    this.combat = parts.combat;
    this.combatLease = parts.combatLease;
    this.supplies = parts.supplies;
    this.trainLevel = parts.trainLevel;
    this.hunt = parts.hunt;
    this.itemErrand = parts.itemErrand;
    this.questRunner = parts.questRunner;
  }

  private get automationConfig(): AutomationConfig {
    return this.session.config();
  }

  /**
   * On connect and on leaving the realm: the escape's two clocks, its
   * unanswered move, a walk home still armed, and the promise to say once
   * that a carried journey waits to be placed.
   */
  reset(): void {
    this.lastAskedToEscape = 0;
    this.lastEscapeSent = 0;
    this.dreadSaid = null;
    this.escapeAwaiting = null;
    this.retreat = null;
    this.saidWaitingToBePlaced = false;
  }

  /**
   * A dial to a different realm: the journey owed across a loss ends in one
   * of that realm's rooms, and so did the choice to cross on the way. Said
   * out loud, like every way a journey ends. The loop is the session's to
   * put down, before this.
   */
  realmChanged(): void {
    if (this.journey !== null) {
      this.session.notice(
        t('session.walk.notResumed', {
          destination: this.journey.name,
          reason: t('session.loop.stoppedRealmChanged')
        })
      );
      this.journey = null;
    }
    // And the choice to cross, which was about that realm's rooms.
    this.crossing = null;
  }

  /**
   * The character walked out to the menu. Before the loop and the walk are
   * stopped: a stopping walk reports `ended`, and an errand let go then would
   * walk on to a route nobody is standing in the realm to be owed.
   */
  leftTheRealm(): void {
    // A journey owed across a loss is owed to a character standing in the
    // realm; one who walked out to the menu has ended it. So is a route a
    // supply errand is shopping on behalf of, and the choice to cross it.
    this.journey = null;
    this.errandOwes = null;
    this.crossing = null;
    /*
     * The rooms run out of belong to the fight they were run out of, and that
     * fight is over: the character has left the realm. Kept per session now
     * that the list survives a quiet tick — an entry that outlived its session
     * would forbid a corridor to the next character for its whole clock.
     */
    this.ranFrom = [];
  }

  /**
   * The socket went. A loss keeps the route the player was walking, a close
   * this client asked for keeps nothing; read before the walk is stopped,
   * because a stopped walk owes nothing. See `pickUpAfterLoss`.
   */
  carryJourney(lost: boolean): void {
    const journey = lost ? this.walker.journey : null;
    // With how it was asked for: a run picked up again is still a run.
    this.journey = journey === null ? null : { ...journey, run: this.walkRun };
  }

  /** A walk started, whoever started it, so nothing owed from a lost connection outlives it. */
  supersedeJourney(): void {
    this.journey = null;
  }

  /**
   * The walker's own redraw of the walk under way, from wherever a fight left
   * the character: lent the choice to cross only for a walk the player asked
   * for, and never for a lap's leg, which plans by distance.
   */
  replan(to: RoomId, shortest: boolean): Route | string {
    return this.errands.planFromHere(
      to,
      {},
      shortest,
      this.walkAsked && !shortest ? this.allowingFor(to) : []
    );
  }

  /**
   * A walk ended, arrived or not. A walk home a fight cut short is armed again
   * so the character is still going somewhere (todo 03); combat lent for the
   * journey is handed back; an arrival spends the choice to cross; a back
   * press gives its trail entry up. Before the modules hear it, as it was.
   */
  walkEnded(arrived: boolean): void {
    const home = this.homeward;
    this.homeward = null;
    const standing = this.tracker.current;
    if (home !== null && !arrived && fightIsRunning(standing)) {
      const { map, number } = standing.room;
      this.retreat = {
        room: home,
        armedAt: Date.now(),
        from: map !== null && number !== null ? roomId(map, number) : null
      };
    }
    // Whether the player asked for this walk, before anything replans.
    this.combatLease.onWalkEnded(arrived, this.walkAsked, this.walkRun);
    // Arrived, the choice to cross is spent: see `crossing`.
    if (arrived && this.walkAsked) this.crossing = null;
    this.walkAsked = false;
    this.walkRun = false;
    this.settleStepBack(arrived);
  }

  /** Whether the walk in progress is one the player asked for. */
  get walkIsAsked(): boolean {
    return this.walkAsked;
  }

  /** And whether it was asked for with *Run it*. */
  get walkIsRun(): boolean {
    return this.walkRun;
  }

  /** An escape sent whose answer has not come. See `settleEscape`. */
  get escapeUnanswered(): boolean {
    return this.escapeAwaiting !== null;
  }

  /** A `safe-haven` walk home waiting for the fight to end. See `walkHomeIfDue`. */
  get retreatArmed(): boolean {
    return this.retreat !== null;
  }

  /**
   * A player opened on this character and `safety.pvp.action` says run: the
   * pvp block's own trigger, whatever `retreat.enabled` says, under the same
   * cooldown so a blow a round is one move. See `Safety.onPvpBlow`.
   */
  runFromPlayer(state: CharacterState, attacker: string): void {
    const now = Date.now();
    if (now - this.lastAskedToEscape < this.automationConfig.safety.retreat.cooldownMs) return;
    this.lastAskedToEscape = now;
    // The shared escape, so the exit ladder and the configured strategy are
    // honoured here exactly as at the health floor.
    this.escape(state, t('session.safety.whyPvp', { attacker }), now);
  }

  /**
   * The route the player asked for, once the item errand holds what its door
   * wanted (`ItemErrand` › walk), through the one door that keeps *one
   * movement at a time*: a lap running is stopped out loud and its leg with
   * it, rather than being superseded silently by a walk it will then wait for
   * ever on. `walkRoute` is not used because being about to travel is what
   * makes the pack matter and this errand is the pack — it has just been
   * filling it.
   */
  walkAfterCollecting(route: Route, run: boolean): string | null {
    if (this.loops.progress.status === 'running') {
      this.loops.stop(t('session.loop.stoppedForRoute'));
      this.walker.stop(t('session.loop.stoppedForRoute'));
    }
    this.journey = null;
    this.errandOwes = null;
    /*
     * **Planned again from where the errand ended, never replayed.** The
     * route was drawn from the room the press was made in, and collecting
     * is itself a journey — to a counter, or round a lair — so `start`
     * would refuse the owed steps as stale and the player would watch the
     * key get bought and the way never walked. `walkPlan` is the door
     * that redraws, and this cannot use it: it would put the shopping
     * errand back in front of a route that has just been shopping.
     *
     * The way is a different question now in any case, which is the
     * better half of this: the pack holds what the door wanted, so the
     * router no longer walls it and the plan it draws may be the short
     * one the player was refused before.
     */
    const owed = route.steps.at(-1);
    if (owed === undefined) return null;
    const drawn = this.errands.planFromHere(
      owed.to,
      { alternatives: true },
      false,
      crossedWords(route)
    );
    if (typeof drawn === 'string') return drawn;
    /*
     * A way through something the player kept out of and did not choose
     * to cross is not walked unwatched: the way round is, where there
     * is one (todo 806).
     */
    const plan = drawn.keptOut === undefined ? drawn : drawn.keptOut.round;
    if (plan.blocked) return plan.reason ?? t('automation.walk.refusalNoRoute');
    // Said rather than passed over in silence: a lap that ended on the
    // owed room itself is a journey nobody has to walk, and *nothing
    // happened* is the one answer that leaves the player guessing.
    if (plan.steps.length === 0) return t('automation.walk.alreadyThere');
    return this.startAsked(plan, run);
  }

  /**
   * To the room where the item is asked for (todo 806), as a leg: the
   * lap stopped out loud first, one movement at a time, and standing
   * there already is nothing to walk rather than a refusal.
   */
  walkLegTo(room: RoomId): string | null {
    if (roomAddress(this.tracker.current.room) === room) return null;
    if (this.loops.progress.status === 'running') {
      this.loops.stop(t('session.loop.stoppedForRoute'));
      this.walker.stop(t('session.loop.stoppedForRoute'));
    }
    const plan = this.errands.planFromHere(room);
    if (typeof plan === 'string') return plan;
    if (plan.blocked) return plan.reason ?? t('automation.walk.refusalNoRoute');
    if (plan.steps.length === 0) return null;
    return this.walker.start(plan, this.tracker.current, ERRAND_LEG);
  }

  /**
   * `@comeback-room`: walk to the address the sender stated.
   *
   * Through `walkRoute` and not `Walker.start`, so it is one movement at a
   * time like every other door onto a route — a running lap is stopped for
   * it, and the supply errand gets its say. Returns whether a walk really
   * started, which is what decides the `{ok}`.
   */
  comeBack(from: string, map: number, room: number): boolean {
    const plan = this.errands.planFromHere(roomId(map, room));
    if (typeof plan === 'string') {
      this.session.notice(t('session.remotes.comebackRefused', { who: from, reason: plan }));
      return false;
    }
    const refused = this.walkRoute(plan);
    if (refused !== null) {
      this.session.notice(t('session.remotes.comebackRefused', { who: from, reason: refused }));
      return false;
    }
    this.session.notice(
      t('session.remotes.comebackWalking', {
        who: from,
        stepCount: plan.steps.length,
        address: `${map}/${room}`
      })
    );
    return true;
  }

  /**
   * A follower saying it cannot keep up. The loop is what would walk away
   * from them, so the loop is what stops — and `@ok` is the same follower
   * saying it can again, which resumes it. Stopping keeps the loop and its
   * place, so the resume plans afresh from wherever the character now
   * stands; the leg being walked is ended here too, because the runner
   * never touches the walker.
   */
  pace(who: string, ready: boolean): void {
    const follower = who.toLowerCase();
    if (!ready) {
      this.waitingFollowers.add(follower);
      if (this.loops.progress.status !== 'running') return;
      /*
       * The lap before the leg, not after: `walker.stop` reports `ended`
       * synchronously, and on a loop still *running* that is a counted
       * failure — "skipping the stop" and a fresh leg planned, for a walk
       * nothing went wrong with. Stopped first, the runner reads the
       * ending as what it is: a leg the stop ended.
       */
      this.loops.stop(t('session.loop.pausedForRemote', { who }));
      this.pausedForFollowers = true;
      this.walker.stop(t('session.loop.pausedForRemote', { who }));
      return;
    }
    this.waitingFollowers.delete(follower);
    if (this.waitingFollowers.size > 0) return;
    if (!this.pausedForFollowers || this.loops.progress.status !== 'stopped') return;
    this.pausedForFollowers = false;
    /*
     * Through `startMoving`, not straight at the runner: this is a second
     * door onto the resume, and the wander check exists precisely because
     * a stop keeps its place while the character does not. A follower's
     * `@ok` is not somebody who can answer a question, so a lap that is
     * now a journey away is **reported and left stopped** — the player
     * presses play, having read how far.
     */
    const answer = this.startMoving(null, null);
    // Said out loud: a loop that quietly failed to walk on is the same
    // stalled evening the resume exists to prevent.
    if ('refused' in answer) this.session.notice(answer.refused);
    if ('confirm' in answer) {
      this.session.notice(
        t('session.move.tooFarForRemote', {
          who,
          name: answer.confirm.name,
          stepCount: answer.confirm.steps
        })
      );
    }
  }

  /**
   * The lap published. However a follower-pause ended — resumed here, resumed
   * by hand, started again — the claim is spent: `@ok` may only resume what
   * `@wait` stopped. `stop()` publishes `stopped`, so setting the flag after
   * the call survives this line.
   */
  noteLap(progress: LoopProgress): void {
    if (progress.status !== 'stopped') this.pausedForFollowers = false;
  }

  /**
   * On connect, beside the loop's own reset: a `@wait` from a session that
   * ended must not hold a loop nobody asked it to.
   */
  forgetFollowers(): void {
    this.waitingFollowers.clear();
    this.pausedForFollowers = false;
  }

  /**
   * Picks up what a lost connection left owed, once the character is back.
   *
   * Two things are carried across a loss and nothing else: a running or
   * stopped loop (`LoopRunner.carried`) and the route the player was walking
   * (`journey`). Everything else automated re-derives its decision from the
   * state on every line and needs nothing carried — resting, healing,
   * auto-combat, the errand from the next pack listing.
   *
   * **Back in the realm *and placed*, not merely back.** The realm prints the
   * room on the way in and the entry probe's `rm` states its coordinates a
   * round trip later, and both loop and route are planned *from* that room:
   * a route replanned before it is known is refused for want of a start, and
   * a loop would spend its bounded locate budget asking a question the entry
   * probe has already asked. So this waits for the room, which in the
   * ordinary case is one status line after `in-game`, and says once at the
   * transition what it is waiting for — the loop's chip reads `offline` the
   * while, and a card that says so is the difference between a hold and a
   * broken client.
   *
   * The route first, then the loop, because that is the order the two would
   * have had before the loss: a loop's leg supersedes a route the walker was
   * walking, silently, and picking them up the other way round would drop the
   * leg for the route instead.
   */
  pickUpAfterLoss(state: CharacterState): void {
    const journey = this.journey;
    if (journey === null && !this.loops.carried) return;
    if (state.phase !== 'in-game') return;
    if (state.room.map === null || state.room.number === null) {
      // Said once and not on every line: the entry probe is what asks where
      // the character is, and this is only ever waiting for the answer. And
      // only when something will in fact walk on — a stopped lap is carried
      // stopped, and a promise that it walks on is one the client cannot keep.
      const walksOn = journey !== null || this.loops.progress.status === 'running';
      if (walksOn && !this.saidWaitingToBePlaced) {
        this.saidWaitingToBePlaced = true;
        this.session.notice(t('session.reconnect.waitingToBePlaced'));
      }
      return;
    }
    if (journey !== null) {
      this.journey = null;
      const route = this.errands.planFromHere(journey.to, {}, false, this.allowingFor(journey.to));
      const refused = typeof route === 'string' ? route : this.startAsked(route, journey.run);
      if (refused !== null) {
        this.session.notice(
          t('session.walk.notResumed', { destination: journey.name, reason: refused })
        );
      } else {
        this.session.notice(t('session.walk.resumed', { destination: journey.name }));
      }
    }
    // Lets the hold go; `loops.onCharacter`, later on this same line, plans
    // the leg from the room that just placed the character.
    this.loops.noteOnline();
  }

  /**
   * What the player chose to cross to reach `to` (`crossing`), for the plans
   * that are their journey again — a stop resumed, a connection picked back
   * up, the walker's own redraws of an asked walk. Nothing else is lent it:
   * a quest leg or an errand bound for the same room is still unwatched.
   */
  private allowingFor(to: RoomId): readonly string[] {
    return this.crossing?.to === to ? this.crossing.words : [];
  }

  /**
   * Drop the rooms run out of long enough ago that the fight they were fled
   * from cannot still be the fight in progress.
   *
   * The caller has already established that nothing is fighting. That is the
   * first of the two tests and, on its own, the bug: it is momentarily true in
   * the gap a two-monster fight opens between a kill and the next swing. This
   * is the second — a room fled within `ranFromForgetMs` stays forbidden
   * through that gap, and the escape ladder picks a different exit instead of
   * the one it came out of.
   *
   * A clock rather than *the room is clear of everything that was hitting you*
   * because the client cannot see what is in the room it left: the occupant
   * list is the room the character is standing in now. The follower it is
   * guarding against is by definition in that list, not the old one.
   */
  private forgetRanFrom(now: number): void {
    this.ranFrom = stillFled(this.ranFrom, now, tuning().walk.ranFromForgetMs);
  }

  considerEscape(state: CharacterState): void {
    const safety = this.automationConfig.safety.retreat;
    if (!this.automationConfig.enabled) return;
    if (state.phase !== 'in-game') return;
    /*
     * A monster whose row says to escape it (todo 818, MegaMUD's *Flee*) is a
     * reason of its own, in a fight or out of one — the point is to be gone
     * before it starts — under the same switch and the same `goingSomewhere()`
     * rule as the others. The switch off is said, once while it stands here:
     * the fork ran whatever the switch said.
     */
    const dreaded = stanceHere(
      state.room.occupants,
      this.automationConfig.combat.mobRules,
      'escape'
    );
    if (!safety.enabled) {
      this.sayDreadRefused(dreaded);
      return;
    }
    /*
     * Out of a fight, a walk still stepping leaves that room by its own next
     * step, and an escape beside it would be a second move out of one room;
     * the row is for a character standing there — a held walk, a lap's stop.
     */
    const fighting = state.inCombat || state.combat.attackers.length > 0;
    const stepping = this.walker.walking && this.walker.holding === null;
    const dread = fighting || !stepping ? dreaded : null;
    /*
     * Nothing to run from. An escape out of combat is a wasted move that puts
     * the character in a room it did not choose.
     *
     * **The same instant is not the moment the rooms run out of stop being
     * forbidden**, which is what it used to be taken for. A fight against two
     * monsters manufactures it between a kill and the next monster's swing, so
     * the list emptied there and the next escape ran back in. `forgetRanFrom`
     * applies the second test — the clock — and keeps the entries still too
     * fresh for the fight they were fled from to be over. See `ranFrom`.
     */
    if (dread === null && !fighting) {
      this.forgetRanFrom(Date.now());
      this.escapeRefusalSaid = null;
      return;
    }

    const now = Date.now();
    if (now - this.lastAskedToEscape < safety.cooldownMs) return;
    /*
     * And not while the escape already chosen is waiting for its answer.
     *
     * `escapeAwaiting` is armed at the **enqueue**, so this covers the gap
     * between proposing a way out and the byte leaving — which is as long as
     * the queue is busy, and the queue is busiest in exactly the seconds a
     * character is in trouble. Without it, a cooldown that elapses inside that
     * gap asks the same question again: the command coalesces to one, but
     * *Running s: health at 10%* is printed twice for one escape, and a count
     * of escapes read off the console is wrong. `settleEscape` clears this on
     * the room, on a refusal and on the deadline, so nothing here can deadlock.
     */
    if (this.escapeAwaiting !== null) return;
    /*
     * And not across an outstanding move, which the escape only started having
     * to care about when it became one.
     *
     * `Walker.start` refuses on this fact, `LoopRunner.advance` waits on it and
     * `walkHomeIfDue` waits on it: a route planned while a move is unanswered
     * has that move as its first step and sends it twice. The escape has the
     * same problem in one command — `wayOut` reads `state.room`, and with a
     * step in flight that is the room the character is *leaving*, so the exit
     * it picks is an exit of somewhere else. `cooldownMs` floors at 1,000ms and
     * this realm's movement round measured 1,239ms, so the second attempt lands
     * inside the first's answer by default rather than in a corner.
     *
     * Waited on, not counted: `lastAskedToEscape` is not armed here, so the
     * next status line — which is what the answer arrives with — asks again.
     */
    if (this.tracker.pendingMoves > 0) return;

    const fraction = healthFraction(state);
    const hurt = fraction !== null && fraction <= safety.belowHealth;
    const outnumbered =
      safety.whenOutnumbered > 0 && state.combat.attackers.length >= safety.whenOutnumbered;
    /*
     * MegaMUD's `ManaRun%`: a caster with an empty pool is losing whatever the
     * health bar says. A null maximum — a class with no pool, or a sheet not
     * yet read — is never a low one, the rule every threshold here follows.
     */
    const { mana, manaMax } = state.vitals;
    const manaFraction = mana !== null && manaMax !== null && manaMax > 0 ? mana / manaMax : null;
    const drained =
      safety.belowMana > 0 && manaFraction !== null && manaFraction <= safety.belowMana;
    if (!hurt && !outnumbered && !drained && dread === null) return;

    const why = hurt
      ? t('session.safety.whyHealth', { percent: percentText(fraction) })
      : drained
        ? t('session.safety.whyMana', { percent: percentText(manaFraction) })
        : outnumbered || dread === null
          ? t('session.safety.whyAttackers', { count: state.combat.attackers.length })
          : t('session.safety.whyDreaded', { mob: dread });
    /*
     * **Only a character the client is taking somewhere runs** (todo 03): a
     * route that has arrived is where the player wanted to be. Said once a
     * fight and traced; the PvP retreat is its own switch and does not come
     * through here. `mudengine-automation` › *Running away is a direction*.
     */
    if (!this.goingSomewhere()) {
      if (this.escapeRefusalSaid === STAYING) return;
      this.escapeRefusalSaid = STAYING;
      /*
       * What happens instead, which out of a fight is not *standing and
       * fighting*: only an `escape` row's monster brings this here out of one,
       * and nothing is opened beside it (todo 818, on review).
       */
      const standing = this.combat.willFight || this.combatLease.lending;
      this.session.notice(
        t('session.safety.escapeStaying', {
          why,
          then: !fighting
            ? t('session.safety.escapeNotOpening')
            : standing
              ? t('session.safety.escapeStanding')
              : t('session.safety.escapeNotFighting')
        })
      );
      this.session.decided({
        at: now,
        action: 'retreat',
        because: why,
        acted: false,
        refused: t('session.safety.escapeStayingReason')
      });
      return;
    }

    this.lastAskedToEscape = now;
    this.escape(state, why, now);
  }

  /**
   * An `escape` row's monster standing here with the retreat switched off:
   * said and traced once while it stays, and forgotten when it goes.
   */
  private sayDreadRefused(dreaded: string | null): void {
    const key = dreaded === null ? null : dreaded.toLowerCase();
    if (key === this.dreadSaid) return;
    this.dreadSaid = key;
    if (dreaded === null) return;
    const why = t('session.safety.whyDreaded', { mob: dreaded });
    const reason = t('session.safety.retreatOffReason');
    this.session.notice(t('session.safety.escapeSwitchedOff', { why, reason }));
    this.session.decided({
      at: Date.now(),
      action: 'retreat',
      because: why,
      acted: false,
      refused: reason
    });
  }

  /**
   * Whether the client is taking this character anywhere: a walk under way or
   * held, a running lap or one a follower's `@wait` paused, a walk to the safe
   * room armed, or an errand or quest run whose leg a fight has ended — each
   * walks on once the fight is over.
   */
  private goingSomewhere(): boolean {
    return (
      this.session.movement().moving ||
      this.pausedForFollowers ||
      this.retreat !== null ||
      this.supplies.current !== null ||
      this.trainLevel.busy ||
      this.itemErrand.running ||
      this.questRunner.running
    );
  }

  /**
   * Which way out, and how well the client knows it.
   *
   * Four rungs, tried in order, every one of them a **direction** — there is no
   * command for running away on this server family, and the eleven refusals
   * that settled that are written up in `NOT_COMMANDS` (`shared/commands.ts`).
   * The ladder is not configurable because each rung is strictly better than
   * the one under it and nobody would knowingly choose a worse one; what *is*
   * configurable is how far to go afterwards (`RetreatConfig.strategy`).
   *
   * 1. **`retrace`** — the opposite of the last confirmed move, when the
   *    character still stands where it landed. The only rung that names a room
   *    this character was *alive* in moments ago, which is why it is first.
   * 2. **`doubles-back`** — an exit of this room that the realm data says leads
   *    to a room further back along the trail. The same claim one link looser,
   *    and it is what answers a retreat that has already run once: after one
   *    escape the newest step no longer ends here, so rung 1 goes quiet exactly
   *    when a second escape is needed.
   * 3. **`known`** — an exit the realm can place. Somewhere, rather than
   *    somewhere the character has been.
   * 4. **`printed`** — an exit the server listed in the room block and the
   *    realm cannot place. The weakest, and still an exit that certainly
   *    exists, because the server printed it thirty seconds ago.
   *
   * Null is a real refusal and is reported as one: a room that named no compass
   * exit at all, with nothing behind it on the trail. Sending a guess there is
   * how the word `flee` survived four phases — an escape that fails silently is
   * indistinguishable from one that was never configured.
   *
   * **Doors and requirements sort, they do not disqualify.** A `closed gate` is
   * one refusal away from being an exit and every rung below is somewhere the
   * character has never been, so a plain exit is preferred within each rung and
   * a noted one is still taken over nothing. Rung 1 ignores the sort entirely:
   * the character came through that passage, whatever the realm says it wants.
   */
  private wayOut(
    state: CharacterState,
    tried: ReadonlySet<Direction> = new Set()
  ): { direction: Direction; how: EscapeRung } | null {
    const here =
      state.room.map !== null && state.room.number !== null
        ? roomId(state.room.map, state.room.number)
        : null;

    /*
     * Every compass exit this room has, plainest first. A text exit
     * (`go manhole`) is deliberately absent: it is not one word, the server
     * answers an unrunnable one by saying it **out loud in the room**, and an
     * escape is the worst moment to announce anything. A direction the server
     * has already refused from this room (`tried`) is not an exit either.
     */
    const exits = state.room.exits
      .flatMap((exit) => {
        const direction = asDirection(exit.direction);
        return direction === null || tried.has(direction) ? [] : [{ ...exit, direction }];
      })
      .sort((a, b) => Number(encumbered(a)) - Number(encumbered(b)));

    /** A room this character has just run out of is not a way out of anywhere. */
    const forbidden = new Set(this.ranFrom.map((entry) => entry.room));

    if (here !== null) {
      const back = this.tracker.wayBackFrom(here);
      if (back !== null && !forbidden.has(back.from) && !tried.has(OPPOSITE[back.direction])) {
        const way = OPPOSITE[back.direction];
        /*
         * Answered by *any* source that knows this room has that exit — the
         * printed list, or the realm's own row, which is what carries a
         * `Hidden/Searchable` passage the server never prints. Both silent is
         * only a refusal when there is something to be silent about: a dark
         * room prints no exits and places nothing, and there the way the
         * character came in is the single thing it does know.
         */
        const printed = exits.some((exit) => exit.direction === way);
        /*
         * The realm's row answers only for a compass exit. A `Text:` edge in
         * that direction is walked by its own words (`go manhole`), not by the
         * direction — Dark Alley 1/383 is `d>1/598 [Text: go manhole]`, and
         * `d` from it is *There is no exit in that direction!* — so the rung
         * would spend an emergency command to be refused and fall through a
         * third of a second later (todo 105). The escape never types a text
         * exit (see `exits` above); the rungs below pick a printed one.
         */
        const known =
          this.world
            ?.byId(here)
            ?.exits.some((exit) => exit.direction === way && exit.requirement?.kind !== 'text') ??
          false;
        const saidNothing = exits.length === 0 && this.world?.byId(here) === undefined;
        if (printed || known || saidNothing) return { direction: way, how: 'retrace' };
      }
    }

    /*
     * Everywhere the trail has been, minus where the character is standing. A
     * step contributes both ends: the room it left *and* the room it reached,
     * because a trail two steps old ends somewhere worth going back to just as
     * much as it starts there.
     */
    const behind = new Set<RoomId>();
    /*
     * The tail of it, not the whole thing: the trail is the back button's
     * history and runs to `walk.trailSteps` rooms, and a rung that prefers
     * *somewhere this character has already stood* means nothing when that is
     * everywhere it has been all evening. `recentSteps` is the escape's own
     * figure and always was; only the list under it grew.
     */
    for (const step of this.tracker.trail.slice(-tuning().walk.recentSteps)) {
      behind.add(step.from);
      behind.add(step.to);
    }
    if (here !== null) behind.delete(here);
    // Every room run out of is on the trail by construction — the escape's own
    // move put it there — so it has to come back out of the set the same way.
    for (const room of forbidden) behind.delete(room);

    const placed = (exit: (typeof exits)[number]): RoomId | null =>
      exit.targetMap !== null && exit.targetRoom !== null
        ? roomId(exit.targetMap, exit.targetRoom)
        : null;

    /*
     * The bottom three rungs, over the exits that do not lead back into
     * something this character has already run out of. A `printed` exit whose
     * destination is unknown cannot be excluded — nothing says where it goes —
     * which is the honest limit of the weakest rung.
     */
    const away = exits.filter((exit) => {
      const to = placed(exit);
      return to === null || !forbidden.has(to);
    });

    const doublesBack = away.find((exit) => {
      const to = placed(exit);
      return to !== null && behind.has(to);
    });
    if (doublesBack !== undefined) return { direction: doublesBack.direction, how: 'doubles-back' };

    const known = away.find((exit) => placed(exit) !== null);
    if (known !== undefined) return { direction: known.direction, how: 'known' };

    const printed = away[0];
    return printed === undefined ? null : { direction: printed.direction, how: 'printed' };
  }

  /**
   * The escape itself, shared by everything that triggers one — the health and
   * outnumbered thresholds above, and a player opening on this character
   * (`Safety.onPvpBlow`). One path, so the configured strategy cannot be
   * honoured by one trigger and silently skipped by another.
   *
   * **It sends a direction or it sends nothing.** `wayOut` above picks which
   * and says how confident it is; `safe-haven` then arms the walk home, which
   * `walkHomeIfDue` takes up once the fight is over and the character is
   * placed — the walker refuses to walk into a fight, so a route can never be
   * the escape itself.
   */
  private escape(
    state: CharacterState,
    why: string,
    now: number,
    tried: ReadonlySet<Direction> = new Set()
  ): void {
    const safety = this.automationConfig.safety.retreat;
    const here =
      state.room.map !== null && state.room.number !== null
        ? roomId(state.room.map, state.room.number)
        : null;

    const out = this.wayOut(state, tried);
    if (out === null) {
      this.escapeAwaiting = null;
      /*
       * Nothing to send, so nothing is sent, and it says so. This is the whole
       * lesson of the word this replaced: for seventy seconds the client
       * reported *Fleeing: health at 50%* eleven times while sending a command
       * that did nothing, and the notice read exactly as it would have if the
       * escape were working. A refusal is a decision and a decision nobody can
       * read did not happen.
       *
       * **And it says what is true** (todo 00). A room that printed exits
       * every one of which leads back into a room just run from did name an
       * exit — the client refused it — and *standing and fighting* is only
       * true where auto-combat will swing, lent or not.
       */
      const blocked = state.room.exits.flatMap((exit) => {
        const direction = asDirection(exit.direction);
        return direction === null || tried.has(direction) ? [] : [DIRECTION_NAME[direction]];
      });
      const fighting = this.combat.willFight || this.combatLease.lending;
      const then = fighting
        ? t('session.safety.escapeStanding')
        : t('session.safety.escapeNotFighting');
      const said = `${here ?? state.room.name}|${blocked.join(',')}|${fighting}`;
      if (said === this.escapeRefusalSaid) return;
      this.escapeRefusalSaid = said;
      const directions = blocked.join(', ');
      this.session.notice(
        blocked.length === 0
          ? t('session.safety.escapeNoExit', { why, then })
          : blocked.length === 1
            ? t('session.safety.escapeOnlyBack.one', { why, directions, then })
            : t('session.safety.escapeOnlyBack.many', { why, directions, then })
      );
      this.session.decided({
        at: now,
        action: 'retreat',
        because: why,
        acted: false,
        refused:
          blocked.length === 0
            ? t('session.safety.escapeNoExitReason')
            : t('session.safety.escapeOnlyBackReason')
      });
      return;
    }
    this.escapeRefusalSaid = null;
    this.leaving(here, now);
    if (safety.strategy === 'safe-haven' && safety.safeHavenRoom.length > 0) {
      this.retreat = { room: safety.safeHavenRoom, armedAt: now, from: here };
    }

    this.session.notice(escapeNotice(out.how, out.direction, why));
    /*
     * **Recorded on the outcome, not the send.** `acted: true` used to be
     * written here, at the moment the byte left — so `The door is closed!`
     * answering it was an escape the trace called successful, the character
     * rested in the lair it believed it had left, and three wererats found
     * it at 2% (todo 06). `settleEscape` writes the decision when the room
     * changes, or when the server refuses, or when nothing answers in time.
     */
    this.escapeAwaiting = {
      direction: out.direction,
      how: out.how,
      why,
      deadline: now + tuning().session.retreatPatienceMs,
      opened: 0,
      tried: new Set([...tried, out.direction])
    };
    this.queue.enqueue({
      command: out.direction,
      priority: 'emergency',
      coalesceKey: 'escape',
      reason: t('session.safety.escapeReason', { why })
    });
  }

  /**
   * The realm's teleport is on its way (`FleeGoto`): the fight is broken off
   * as for a walked escape, on the sent clock alone, until the realm answers.
   */
  teleportSent(now: number): void {
    this.lastEscapeSent = now;
  }

  /**
   * The realm refused it (a player's `sys`, in ~90ms): the sent clock this
   * teleport started is released at once, so the heal, the potion and the
   * swing back are not stood down for a move that is not happening. A clock a
   * walked escape has restarted since is that escape's, and is kept.
   */
  teleportRefused(sentAt: number): void {
    if (this.lastEscapeSent === sentAt) this.lastEscapeSent = 0;
  }

  /**
   * It landed: the room left is fled and the loop and route are held, by the
   * walked escape's own bookkeeping. No safe-haven walk: the landing is one.
   */
  teleportLanded(from: CharacterState['room'], now: number): void {
    this.leaving(roomAddress(from), now);
  }

  /**
   * What every way out of a fight does, walked or teleported: remembers the
   * room left, starts the sent clock everything that keeps a character alive
   * stands down on, and holds the loop and the route.
   */
  private leaving(here: RoomId | null, now: number): void {
    /*
     * The room being run out of, so nothing walks back into it while the fight
     * that emptied it is still going. See `ranFrom`.
     */
    if (here !== null) {
      const already = this.ranFrom.find((entry) => entry.room === here);
      // Running out of the same room twice re-arms its clock rather than
      // adding a second entry: what matters is how long ago it was last fled.
      if (already !== undefined) already.at = now;
      else {
        this.ranFrom.push({ room: here, at: now });
        if (this.ranFrom.length > tuning().walk.recentSteps) this.ranFrom.shift();
      }
    }
    /*
     * And *now* a move is in flight, which is a different fact from having
     * asked. Everything that keeps a character alive stands down on this one.
     */
    this.lastEscapeSent = now;

    /*
     * **And the loop is held, whichever way out was taken — held, not ended.**
     *
     * The lap must not walk on immediately: it plans its next leg from wherever
     * the character landed, and the room it ran out of is one room away.
     * Measured (`logs/2026-09-02_09-58-25_festus.mudcap.jsonl`): an escape sent
     * `e`, and two seconds after `*Combat Off*` the loop sent `w` — back into
     * the room with the cave worm in it. Three times, 51 HP down to 15, and
     * what ended it was the player typing a direction by hand. Nothing rests
     * while a loop is marching (`mayRest`), so those two seconds were also the
     * whole window in which the character could have sat down, and it never
     * did.
     *
     * That was first answered by **stopping** the loop, and stopping it was
     * wrong: a lap runs until the player stops it, the character dies, or its
     * stops fail wholesale, and running away is none of those. Observed on
     * festus, 2026-09-02 — the escape was right, the rest that followed was
     * right, and then the lap simply never came back, so an unattended
     * character stood in a corridor at full health. `LoopRunner.noteEscaped`
     * holds it instead: out of combat, back above `restTo`, and
     * `tuning.loop.escapeSettleMs` past the escape, and then it walks on. The
     * hold is also what lets `Recovery` sit the character down where it landed
     * — `mayRest` allows a held loop and refuses a marching one.
     *
     * `walkHomeIfDue` no longer stops it either: the same hold covers the haven
     * walk, and the runner waits for that walk to finish (`walking()`) before
     * it plans anything of its own.
     */
    this.loops.noteEscaped();
    /*
     * And the same for a route the player asked for, which now survives the
     * fight it ran from (`Holds.holdForFight`) and would otherwise plan its
     * way onward from where the escape landed — whose shortest path very often
     * begins with the reverse of the move that just got away. The lap's own
     * measurement, applied to the other walk that can outlive a fight.
     */
    this.walker.noteEscaped();
  }

  /**
   * What the server said back to the escape, read against the block that
   * just applied — the postcondition `escape` arms.
   *
   * Five answers. A room that is not the one the move was sent from is the
   * escape landing, and the decision is recorded `acted: true` only now. A
   * death is a teleport and not an escape. `direction-failed` naming a
   * barrier is a shut door, and `movement.openDoors` opens it — `open
   * <direction>` then the direction again, both in the `emergency` band,
   * bounded by `openTries`; the walker's own rung, without its bash, which
   * spends rounds the character does not have. Any other refusal drops to the
   * next rung of the ladder **now**, not after `cooldownMs`: a refusal is new
   * information and the ladder is already ranked. `command-refused` (mortally
   * wounded) refuses everything, and the deadline covers an answer that never
   * came. Every branch writes the decision it took.
   */
  settleEscape(block: Block, before: CharacterState['room']): void {
    const waiting = this.escapeAwaiting;
    if (waiting === null) return;
    const now = Date.now();
    const state = this.tracker.current;
    const decision = `${waiting.why} — ${waiting.direction} (${waiting.how})`;
    const settle = (acted: boolean, refused?: string): void => {
      this.escapeAwaiting = null;
      this.session.decided({
        at: now,
        action: 'retreat',
        because: decision,
        acted,
        ...(refused === undefined ? {} : { refused })
      });
    };

    if (block.type === 'user-dies') {
      settle(false, t('session.safety.escapeKilled'));
      return;
    }
    if (landed(state.room, before)) {
      settle(true);
      return;
    }
    if (block.type === 'direction-failed') {
      const barrier = block.groups['barrier'];
      const doors = this.automationConfig.movement;
      if (barrier !== undefined && doors.openDoors && waiting.opened < doors.openTries) {
        waiting.opened += 1;
        waiting.deadline = now + tuning().session.retreatPatienceMs;
        this.lastEscapeSent = now;
        this.session.notice(
          t('session.safety.escapeOpening', { barrier, direction: waiting.direction })
        );
        this.queue.enqueue({
          command: `open ${waiting.direction}`,
          priority: 'emergency',
          coalesceKey: 'escape:open',
          reason: t('session.safety.escapeReason', { why: waiting.why })
        });
        this.queue.enqueue({
          command: waiting.direction,
          priority: 'emergency',
          coalesceKey: 'escape',
          reason: t('session.safety.escapeReason', { why: waiting.why })
        });
        return;
      }
      const tried = waiting.tried;
      settle(false, block.text);
      // The next rung, now: the refusal is the new information the ladder was
      // waiting for, and `cooldownMs` exists to stop a spam of moves, not this.
      this.escape(state, waiting.why, now, tried);
      return;
    }
    if (block.type === 'command-refused') {
      settle(false, block.text);
      return;
    }
    if (now > waiting.deadline) settle(false, t('session.safety.escapeUnanswered'));
  }

  /**
   * The second half of `safe-haven`: once out of combat and placed, walk home.
   *
   * Armed by the escape and spent once. The walker plans from wherever the
   * character actually landed rather than from where the escape aimed it — one
   * move can be refused, and a route planned from a room the character is not
   * in is a route into a wall. The loop is already held by the escape itself
   * (`escape`), which is what keeps it from re-planning its leg out of the
   * haven and back into the lair, and the runner will not plan while this walk
   * is running. Every outcome is said: a route, a refusal, or a room that never
   * resolved within `tuning.session.retreatPatienceMs`, which is how long a
   * move and one look take.
   */
  walkHomeIfDue(state: CharacterState): void {
    const retreat = this.retreat;
    if (retreat === null) return;
    if (state.phase !== 'in-game') {
      this.retreat = null;
      return;
    }
    const now = Date.now();
    if (state.inCombat) {
      if (now - retreat.armedAt > tuning().session.retreatPatienceMs) {
        this.retreat = null;
        this.session.notice(t('session.safety.retreatGaveUp', { room: retreat.room }));
      }
      return;
    }
    if (state.room.map === null || state.room.number === null) {
      if (now - retreat.armedAt > tuning().session.retreatPatienceMs) {
        this.retreat = null;
        this.session.notice(t('session.safety.retreatUnplaced', { room: retreat.room }));
      }
      return;
    }
    /*
     * `*Combat Off*` lands before the room the escape moved into does, so at
     * the first out-of-combat state the room on record is still the one the
     * escape was sent from — and a route planned from there is a route from a
     * room the character has left. Wait for the room to change. A move the
     * server refused — a shut door on the only rung that had one — leaves the
     * character where it was with the fight over some other way, so after
     * `tuning.session.retreatSettleMs` the room on record is taken as the
     * truth.
     */
    const here = roomId(state.room.map, state.room.number);
    if (here === retreat.from && now - retreat.armedAt < tuning().session.retreatSettleMs) return;
    /*
     * And not while a move is still unanswered, which since the escape became a
     * **move** is the ordinary case rather than a corner: the `Location:` line
     * the server prints ahead of a room block is a state change, and the room
     * that answers the step out arrives after it. `Walker.start` refuses on
     * exactly this fact — a route planned across an outstanding move has the
     * move already in flight as its first step — so asking it here only to be
     * refused would be the same question asked a beat too early.
     *
     * **Waited on rather than counted.** The refusal below spends `this.retreat`
     * before it reports, so a transient answer of *no* would drop the walk home
     * for good; the room that is already arriving is what makes the answer yes.
     * `LoopRunner.advance` waits on this fact for the same reason. Bounded by
     * the same patience as the two waits above, so a move the server swallowed
     * cannot hold the haven open all evening.
     */
    if (this.tracker.pendingMoves > 0) {
      if (now - retreat.armedAt > tuning().session.retreatPatienceMs) {
        this.retreat = null;
        this.session.notice(t('session.safety.retreatUnplaced', { room: retreat.room }));
      }
      return;
    }
    this.retreat = null;
    const found = this.errands.findStop(splitStop({ room: retreat.room }));
    if (typeof found === 'string') {
      this.session.notice(
        t('session.safety.retreatRefused', { room: retreat.room, reason: found })
      );
      return;
    }
    // Priced as every other route is — retreating through a gate this
    // character cannot pay is not a retreat.
    const route = this.world?.route(
      roomId(state.room.map, state.room.number),
      roomId(found.map, found.room),
      this.errands.travellerNow(state)
    );
    if (route === undefined) {
      this.session.notice(
        t('session.safety.retreatRefused', {
          room: retreat.room,
          reason: t('session.loop.noRealmData')
        })
      );
      return;
    }
    /*
     * Never held for health: this walk exists *because* the character is hurt,
     * and waiting to be better leaves it bleeding beside the lair it just
     * fled. Nor for a fight, which is the same sentence about the other
     * threshold — a retreat that stood still until the fight was over is a
     * retreat that never happened.
     */
    const refused = this.walker.start(route, state, {
      // Announced — running away is exactly the thing that has to be said out
      // loud — and still nothing the player asked for.
      asked: false,
      holdWhenHurt: false,
      resumeAfterFight: false,
      /*
       * Nor picked back up after a lost connection. It exists for a fight,
       * and a socket dropping ends whatever fight there was the way a death
       * does; a walk home resumed through the player's own defaults would
       * hold for health on the way, which is the "bleeding beside the lair"
       * the two options above refuse. The health and the retreat thresholds
       * decide afresh from wherever the character is standing when it is
       * back, which is what they do on every line anyway.
       */
      resumeAfterLoss: false
    });
    if (refused !== null) {
      this.session.notice(
        t('session.safety.retreatRefused', { room: retreat.room, reason: refused })
      );
      return;
    }
    this.homeward = retreat.room;
    this.session.notice(
      t('session.safety.retreatPlanned', { room: retreat.room, stepCount: route.steps.length })
    );
    this.session.decided({
      at: now,
      action: 'retreat',
      because: t('session.safety.retreatBecause', { room: retreat.room }),
      acted: true
    });
  }

  /**
   * Collect what the way needs, then walk it (todo 07).
   *
   * The one door for *collect it first* — the route panel's tick beside its
   * *Walk it*, offered on whichever way is on screen where that way names
   * items (`itemsWanted`) — every one of them, fetched in turn. The errand
   * reports its own refusal back to the window that pressed, because a person
   * is looking at the answer.
   */
  collectThenWalk(
    items: Array<{ id: number; name: string }>,
    route: Route,
    run = false
  ): string | null {
    return this.unchosen(route) ?? this.itemErrand.collect(items, route, this.tracker.current, run);
  }

  /**
   * Why a way through what the player keeps out of cannot be walked yet, or
   * null (todo 806). The panel drops `keptOut` once the player picks between
   * the way through and the way round, so a route still carrying it is one
   * nobody chose — the palette's *Go to*, or anything else that walks a plan
   * it did not read — and walking it would make the choice for them.
   */
  private unchosen(route: Route): string | null {
    if (route.keptOut === undefined) return null;
    return t('session.walk.keptOutChoose', { wordList: route.keptOut.words.join(', ') });
  }

  /**
   * The press on the plan the panel is showing — the one door a person's own
   * route comes through (`Invoke.walkRoute`).
   *
   * **A plan is drawn from where the character stood when it was drawn**, and
   * between the drawing and the press a lap, a party leader or a retreat moves
   * it. `Walker.start` then refuses: the plan's first step leaves a room the
   * character is not in, so walking it would send the wrong command from the
   * wrong place. That refusal is correct and was the whole answer, which left
   * the reader looking at a panel whose only button had just failed and whose
   * only remedy was to draw the same plan again by hand.
   *
   * So the plan is redrawn from here, and the only question left is whether
   * the reader is still being sent on the journey they read. Two things make
   * it a different one, and they are asked about rather than walked:
   *
   * - **Distance.** Past `tuning.walk.replanDriftSteps` moves from the room
   *   the old plan began in — the router's own steps, not map squares — the
   *   character is somewhere else and the way from it is another journey. An
   *   unmeasurable drift is asked about too: unknown is never the reassuring
   *   answer, and a way the router cannot price is not evidence of nearness.
   * - **What it asks for.** A key, a level, a toll, a door nobody here can
   *   force, an item a river wants — anything the new way needs that the old
   *   one did not (`newDemands`). A shorter way that asks for *less* is the
   *   same journey made easier and is simply walked.
   *
   * Either way the reader gets the **new plan** rather than a sentence about
   * the old one, because what they do next is read it and press Walk again —
   * and that press is measured afresh, exactly as `startMoving`'s `confirmed`
   * figure is: agreeing to a journey is agreeing to *that* journey.
   *
   * `run` is *Run it* (todo 06): the same press with auto-combat turned off
   * first and left off. A redrawn plan carries nothing; the next press says it
   * again.
   */
  walkPlan(route: Route, run = false): WalkStart {
    const unchosen = this.unchosen(route);
    if (unchosen !== null) return { refused: unchosen };
    const here = roomAddress(this.tracker.current.room);
    const start = route.steps[0]?.from ?? null;
    /*
     * Standing where it was drawn from, or nothing to measure against — an
     * unplaced character, or an empty plan. The walker's own refusal is the
     * honest answer to all three, and it is the answer the panel already draws.
     */
    if (here === null || start === null || here === start) return this.started(route, run);

    const destination = route.steps[route.steps.length - 1]!.to;
    // Drawn for a reader, like the plan it replaces: the panel shows this one,
    // and a plan without its walls and hazards would compare as asking less.
    const plan = this.errands.planFromHere(
      destination,
      { alternatives: true },
      false,
      crossedWords(route)
    );
    if (typeof plan === 'string') return { refused: plan };
    if (plan.blocked) return { refused: plan.reason ?? t('automation.walk.refusalNoRoute') };
    if (plan.steps.length === 0) return { refused: t('automation.walk.alreadyThere') };

    const wandered = this.stepsBetween(start, here);
    /*
     * And a way from here through something kept out of that the pressed way
     * did not cross is a choice the player has not made (todo 806): the panel
     * shows both again.
     */
    const demands = [
      ...newDemands(route, plan),
      ...(plan.keptOut?.words ?? []).map((word) => t('session.walk.keptOutDemand', { word }))
    ];
    if (demands.length > 0 || wandered === null || wandered > tuning().walk.replanDriftSteps) {
      return { replanned: { route: plan, wandered, demands } };
    }
    // Said out loud, like every other fallback: the steps about to be walked
    // are not the steps that were read, however small the difference.
    this.session.notice(
      t('session.walk.replanned', {
        destination: plan.steps[plan.steps.length - 1]!.name,
        steps: plan.steps.length
      })
    );
    return this.started(plan, run);
  }

  /** `walkRoute`'s answer as the press's union. */
  private started(route: Route, run: boolean): WalkStart {
    const refused = this.walkRoute(route, run);
    return refused === null ? { started: true } : { refused };
  }

  /**
   * How many moves apart two rooms are, or null where the realm cannot say.
   *
   * `stepsFromStop`'s question asked of two rooms the character is standing in
   * neither of — priced by the same traveller, so *how far have I wandered*
   * and *what will it cost to walk* cannot disagree.
   */
  private stepsBetween(from: RoomId, to: RoomId): number | null {
    if (this.world === undefined) return null;
    const route = this.world.route(from, to, this.errands.travellerNow(this.tracker.current));
    return route.blocked ? null : route.steps.length;
  }

  /**
   * Start a route the player asked for — walked, or run (todo 06).
   *
   * The one place `walkAsked` is set: the panel's route, the one owed back
   * after a supply or item errand, and the one picked up after a lost
   * connection are all the player's, and `CombatLease` hands combat back on
   * the arrival of each. A loop's leg goes another way. A refused start
   * leaves whatever was walking exactly as it was asked for.
   *
   * **Run it is turn off, go.** The switch is written off through the lease,
   * the journey's own override is declined in the same statement — the
   * walker publishes inside `start`, so the journey is armed by the time it
   * returns — and the arrival hands nothing back. A file that will not take
   * the write refuses the run out loud rather than walking a route that
   * would fight.
   */
  private startAsked(route: Route, run: boolean): string | null {
    const was = { asked: this.walkAsked, run: this.walkRun };
    this.walkAsked = true;
    this.walkRun = run;
    const refused = this.walker.start(route, this.tracker.current);
    if (refused !== null) {
      this.walkAsked = was.asked;
      this.walkRun = was.run;
      return refused;
    }
    /*
     * `start` answers null for a walk that stopped inside it as well — a first
     * step the held arbiter refused to queue ends the walk before `start`
     * returns — so the walker is asked whether it is walking rather than the
     * return value read as *started*. Otherwise a run pressed with the stat
     * screen up wrote the switch off for a walk that never began, declined
     * nothing (the stop had already disarmed the journey) and reported
     * success (on review). Nothing is walking now, whatever was before.
     */
    if (!this.walker.walking) {
      this.walkAsked = false;
      this.walkRun = false;
      return this.walker.progress.reason ?? t('automation.walk.stoppedAtStart');
    }
    // What this route crosses that `keepOutOf` names, the player having chosen
    // it on the panel over the way round: planned again the same way later.
    const last = route.steps.at(-1);
    this.crossing = last === undefined ? null : { to: last.to, words: crossedWords(route) };
    if (!run) return null;
    if (!this.combatLease.run()) {
      const reason = t('automation.combat.runRefused');
      this.walker.stop(reason);
      return reason;
    }
    this.combat.declineWhileTravelling();
    this.session.notice(t('automation.combat.runningCombatOff'));
    return null;
  }

  /**
   * A route the player asked for, with the supply list consulted first.
   *
   * The one path a person's own route takes (`Invoke.walkRoute`), and the
   * second of the two moments a supply errand may start — the first being a
   * running lap. Being about to travel is the whole reason the pack matters,
   * so the check happens here rather than on every status line: a character
   * standing still, freshly killed and stripped in the temple, is not about to
   * travel and has no business being walked to a shop.
   *
   * The errand takes precedence and the route is owed back, so the order is
   * shop, then go. Nothing is queued twice: the errand's walk is already out
   * by the time this returns, and the route is planned afresh from the shop
   * when the errand lets go (`walkOnAfterErrand`).
   */
  walkRoute(route: Route, run = false): string | null {
    // The counters, if this way turns on one nobody has read yet.
    this.errands.askCountersFor(route);
    /*
     * **One movement at a time.** A character is routing, looping or stopped
     * (`src/shared/movement.ts`), and a route asked for while a lap runs used
     * to start both: `Walker.start` supersedes the leg silently — it
     * deliberately raises no `ended` — so the lap sat waiting for a leg that
     * was never coming, then read the *route's* arrival as its own leg
     * landing and planned its next stop from wherever the player had gone.
     *
     * A **stopped** lap is left exactly where it is. It is the longer-lived of
     * the two memories and nothing about walking somewhere means giving it up:
     * stopping a lap to walk to a shop and pressing play on arrival is the
     * whole point of a stop being a pause.
     */
    if (this.loops.progress.status === 'running') {
      this.loops.stop(t('session.loop.stoppedForRoute'));
    }
    this.errandOwes = null;
    const errand = this.supplies.considerBeforeRoute(this.tracker.current);
    if (errand === null) return this.startAsked(route, run);
    const last = route.steps.at(-1);
    if (last !== undefined) {
      this.errandOwes = { to: last.to, name: last.name, run, crossing: crossedWords(route) };
    }
    this.session.notice(
      t('session.supplies.beforeRoute', {
        item: errand.item.name,
        shop: errand.shopName,
        destination: last?.name ?? t('session.supplies.beforeRouteNowhere')
      })
    );
    return null;
  }

  /**
   * One room back the way the character came, per press.
   *
   * The trail is a list of rooms and the move that joined each pair
   * (`CharacterTracker.trail`, `tuning.walk.trailSteps`), so going back is a
   * **route to the previous room**, never the opposite of the last direction:
   * a one-way exit has no opposite, a `Text:` exit (`go manhole`) is not a
   * direction at all, and a door may have shut behind the character. The
   * planner answers all three the way it answers every other journey.
   *
   * **Where the realm cannot do it in one step, the player is asked.** Going
   * back is a small gesture — a press, then another press — and a press that
   * silently becomes a fourteen-step journey round a one-way corridor is the
   * gesture meaning something the person did not intend. `confirmed` is the
   * figure they were shown, re-measured here on the way through, exactly as
   * `startMoving`'s is.
   *
   * The entry is given up when the character arrives (`settleStepBack`), so
   * the next press goes one further back rather than returning to where this
   * press started: a history that grows as it is walked is the naive reverse
   * with extra steps.
   */
  stepBack(confirmed: number | null): MovementStart {
    const state = this.tracker.current;
    if (state.phase !== 'in-game') return { refused: t('session.back.notInRealm') };
    if (this.tracker.pendingMoves > 0) return { refused: t('session.back.moveInFlight') };
    const trail = this.tracker.trail;
    const last = trail.at(-1);
    if (last === undefined) return { refused: t('session.back.nothingBehind') };
    const plan = this.errands.planFromHere(last.from);
    if (typeof plan === 'string') return { refused: plan };
    if (plan.blocked) {
      return {
        refused: t('session.back.noWay', { reason: plan.reason ?? t('session.back.noRoute') })
      };
    }
    const steps = plan.steps.length;
    // Standing in it already — the trail is behind the character rather than
    // in front of it. Give the entry up and let the next press do the walking.
    if (steps === 0) {
      this.tracker.retraced(last);
      return { refused: t('session.back.alreadyThere') };
    }
    const name = plan.steps.at(-1)?.name ?? last.from;
    if (steps > 1 && (confirmed === null || steps > confirmed)) {
      return { confirm: { kind: 'back', name, steps } };
    }
    // One movement at a time, as a route the player asked for is: a running
    // lap is stopped out loud and keeps its place. No supply errand — being
    // about to travel is what makes the pack matter, and a step back is not
    // travelling.
    if (this.loops.progress.status === 'running') {
      this.loops.stop(t('session.loop.stoppedForRoute'));
    }
    this.errandOwes = null;
    const refused = this.walker.start(plan, state);
    if (refused !== null) return { refused };
    this.steppingBack = { to: last.from, step: last };
    return { started: true };
  }

  /**
   * The walk a back press asked for has ended: give the trail up, or not.
   *
   * Only an arrival pops the history, and only into the room that was asked
   * for — a walk stopped by a fight half way back leaves the trail true, so
   * pressing back again finishes the journey instead of skipping the room it
   * never reached.
   */
  private settleStepBack(arrived: boolean): void {
    const back = this.steppingBack;
    if (back === null) return;
    this.steppingBack = null;
    if (arrived && roomAddress(this.tracker.current.room) === back.to) {
      this.tracker.retraced(back.step);
    }
  }

  /**
   * Stop moving — the one stop, whichever of the two is running.
   *
   * There were three (`walk:stop`, `loop:stop`, `loop:pause`) and the player
   * had to know which of them applied before pressing one. They do not: a
   * character is routing, looping or stopped, and *stop* means the same thing
   * in all three sentences. See `src/shared/movement.ts`.
   *
   * **The lap first, then its leg.** `Walker.stop` reports `ended`
   * synchronously, and on a lap still running that is read as a stop the
   * client could not reach — a counted failure, and a fresh leg planned for a
   * walk nothing went wrong with. Stopped first, the runner reads the ending
   * as what it is.
   *
   * Nothing is forgotten either way: the lap keeps its place and the walker
   * keeps its route, which is what `startMoving` picks back up.
   */
  stopMoving(): void {
    // A walk home the player stops is not carried past the fight it stops in.
    this.homeward = null;
    const reason = t('session.walk.stoppedByPlayer');
    if (this.loops.progress.status === 'running') this.loops.stop(reason);
    this.walker.stop(reason);
    // The one door a person's stop comes through, so it is the one place that
    // can tell a hunt it was stopped *by somebody* rather than by the realm.
    this.hunt.noteStopped();
  }

  /**
   * Start moving: begin the named loop, or pick back up whatever was stopped.
   *
   * `loopName` is what the card's picker says, and it is only ever a *start*:
   * naming the lap that is already stopped means resume it where it is, which
   * is why the name is compared rather than obeyed. **Null is the picker's
   * resume entry** — *whatever is stopped*, named by main rather than by the
   * window, so the two can never disagree about which of the pair it was.
   *
   * **The wander check is the reason this returns a union rather than a
   * refusal string.** A stop is a pause, so the character may have been walked
   * — or killed and reborn in a temple on another map — a long way from
   * whatever it was walking, and picking it back up would send it on a journey
   * across the realm that nobody asked for. Past
   * `tuning.walk.resumeAskSteps` the window asks first and presses play again
   * with `confirmed`.
   *
   * **Both kinds measure the same thing**: how much further away the character
   * is now than when the movement stopped. A route knows what it had left
   * (`Walker.unfinished`); a lap is measured from the room it stopped in
   * (`LoopRunner.strayedFrom`). Walking on down something you were already
   * walking asks nothing, however far it still has to go — see `resumeLoop`,
   * and `mudengine-automation` for why the lap's own leg is not the figure.
   */
  startMoving(loopName: string | null, confirmed: number | null): MovementStart {
    const reading: PlayReading = {
      movement: this.session.movement(),
      loops: this.loops,
      loopNamed: (name) => this.session.loopNamed(name)
    };
    // The refusals no room changes, the press's own reading (`Play`, todo 762).
    const refused = refusesToPlay(reading, loopName);
    if (refused !== null) return { refused };

    // A name that is not the lap already stopped is a different lap, and
    // starting one is not resuming anything: it chooses its own nearest stop.
    const chosen = anotherLoop(reading, loopName);
    if (chosen !== undefined) return this.startLoop(chosen);

    /*
     * Which of the two is picked back up is `movementOf`'s to say and not this
     * method's, so the card cannot draw one and play the other: the face on
     * screen and the thing play moves are the same reading of the same two
     * progresses. Anything else was refused above.
     */
    return reading.movement.kind === 'loop'
      ? this.resumeLoop(this.tracker.current, confirmed)
      : this.resumeRoute(confirmed);
  }

  /**
   * A lap the player asked for, from the palette, the shelf or the card.
   *
   * **One movement at a time**: a lap starting takes the character off
   * whatever route it was walking, said out loud rather than superseded
   * silently by its own first leg — which is what `Walker.start` would do, and
   * the mirror of the failure `walkRoute` stops a running lap to avoid.
   */
  startLoop(loop: Loop): MovementStart {
    if (this.walker.walking) this.walker.stop(t('session.loop.stoppedForLoop'));
    // Both destinations the walk was owed die with it: the shop it was going
    // to and the route it was shopping on behalf of are about a journey the
    // lap has just replaced.
    this.journey = null;
    this.errandOwes = null;
    const refused = this.loops.start(loop, this.tracker.current);
    return refused === null ? { started: true } : { refused };
  }

  /**
   * The stopped lap, from wherever the character now stands.
   *
   * What is asked about is the **difference**, exactly as a route's is: how
   * much further from the stop it was heading for the character is now than it
   * was when the lap stopped. A lap stopped for a breath and started again
   * from the same room has wandered nowhere and asks nothing, however far the
   * leg it was walking still had to go.
   *
   * *The distance to the stop is how far off the lap the character has got*
   * was this method's rule until todo 03 (2026-09-13), on the argument that a
   * leg is short by construction. It is not: the first leg of a lap across the
   * realm is a journey, and so is a leg between two stops the builder put a
   * map apart — so stopping such a lap mid-leg and pressing play said *this
   * character has wandered a long way* about a character that had not moved.
   *
   * The baseline is where it stood at the stop (`LoopRunner.strayedFrom`).
   * Where the client could not place that room, or cannot price the way from
   * it, the absolute distance is asked about instead: the question this
   * protects against is a journey nobody asked for, and an unmeasurable wander
   * is not evidence that there was none.
   *
   * An unplannable leg is not a long one: `resume` reports the real refusal in
   * the runner's own words rather than this guessing at it.
   */
  private resumeLoop(state: CharacterState, confirmed: number | null): MovementStart {
    const loop = this.loops.progress;
    const heading = this.loops.heading;
    if (heading !== null) {
      // Measured the way the lap will walk it, or the prompt quotes a detour
      // the leg will never take.
      const plan = this.errands.planFromHere(heading, {}, true);
      if (typeof plan !== 'string') {
        const owed = this.stepsFromStop(heading);
        const wandered = plan.steps.length - (owed ?? 0);
        if (this.tooFar(wandered, confirmed)) {
          return {
            confirm: {
              kind: 'loop',
              name: loop.name ?? t('session.move.theLoop'),
              steps: wandered
            }
          };
        }
      }
    }
    const refused = this.loops.resume(state);
    return refused === null ? { started: true } : { refused };
  }

  /**
   * The stopped route, planned afresh from here.
   *
   * What is asked about is the **difference** — how much further away the
   * character is now than when it stopped — so walking on down a route you
   * were already walking asks nothing however long the route is.
   */
  private resumeRoute(confirmed: number | null): MovementStart {
    const owed = this.walker.unfinished;
    if (owed === null) return { refused: t('session.move.nothingToResume') };
    const plan = this.errands.planFromHere(owed.to, {}, false, this.allowingFor(owed.to));
    if (typeof plan === 'string') return { refused: plan };
    const wandered = plan.steps.length - owed.left;
    if (this.tooFar(wandered, confirmed)) {
      return { confirm: { kind: 'route', name: owed.name, steps: wandered } };
    }
    // Through `walkRoute`, so a resumed route is consulted against the supply
    // list exactly as the one the player drew was: being about to travel is
    // what makes the pack matter, and resuming is being about to travel.
    const refused = this.walkRoute(plan);
    return refused === null ? { started: true } : { refused };
  }

  /**
   * Whether this distance has to be asked about, given what was already
   * agreed to.
   *
   * **`confirmed` is the figure the player was shown**, not a flag, and the
   * distance is measured again on the way back through. A boolean was an
   * unconditional bypass: the prompt says *34 steps*, the dialog sits there
   * while the character is killed and reborn two maps away, and *walk it back*
   * then walks a hundred and twenty with nothing asked — the exact sequence
   * the prompt's own words describe. Agreeing to a journey is agreeing to
   * *that* journey, so anything longer is asked again.
   */
  private tooFar(steps: number, confirmed: number | null): boolean {
    if (steps <= tuning().walk.resumeAskSteps) return false;
    return confirmed === null || steps > confirmed;
  }

  /**
   * How far the stop the lap is heading for was from the character when the
   * lap stopped, or null where that cannot be measured.
   *
   * Null has one meaning and one reading: *not measurable*, never *zero*. The
   * room the lap stopped in may be unplaced (a dark room, a connection lost
   * before the client placed the character) or the way from it may be blocked
   * for this traveller, and either way `resumeLoop` falls back to the absolute
   * distance rather than treating an unknown baseline as *it was standing on
   * the stop*, which would be the one reading that never asks.
   */
  private stepsFromStop(heading: RoomId): number | null {
    const from = this.loops.strayedFrom;
    if (from === null || this.world === undefined) return null;
    const route = this.world.route(from, heading, this.errands.lapTraveller(this.tracker.current));
    return route.blocked ? null : route.steps.length;
  }

  /**
   * The errand let go: walk on to where the player was going.
   *
   * Planned from where the character is standing rather than replayed, for
   * `pickUpAfterLoss`' reason — the shop is not on the route that was drawn,
   * and the way from it is a different set of steps. A refusal is said out
   * loud with the destination in it; the route is not owed twice either way.
   */
  walkOnAfterErrand(): void {
    const owed = this.errandOwes;
    if (owed === null) return;
    this.errandOwes = null;
    const route = this.errands.planFromHere(owed.to, {}, false, owed.crossing);
    const refused = typeof route === 'string' ? route : this.startAsked(route, owed.run);
    this.session.notice(
      refused === null || refused === undefined
        ? t('session.walk.resumed', { destination: owed.name })
        : t('session.walk.notResumed', { destination: owed.name, reason: refused })
    );
  }

  /**
   * A death moves the character, and nothing may go on moving it afterwards.
   *
   * The realm puts a dead character in its area's temple. That is a room
   * nobody chose, several maps from wherever the route, the loop or the
   * retreat was planned — so every one of those is now a plan about a place
   * the character is not, and carrying on with it walks a one-life-lighter
   * character back towards what killed it. **Nothing here is a setting.** The
   * loop is stopped, not unconfigured; auto-combat, resting and the rest are
   * untouched, because standing in a temple deciding to heal is exactly right.
   *
   * Two things go, and they are the two that hold a *destination*:
   *
   * - **A running loop.** Stopped rather than forgotten, like every other
   *   stop: it keeps its place, and pressing play plans afresh from wherever
   *   the character is — which after this is the temple, and far enough from
   *   the lap that `startMoving` asks before walking it back.
   * - **An armed safe-haven retreat.** It is spent when the fight ends, and a
   *   death *is* the fight ending: without this the next status line plans a
   *   route from the temple to a haven chosen for a fight that is already
   *   over. Said out loud, like every other retreat outcome.
   *
   * The walk is the walker's own to end, on the same block — see its
   * `user-dies` case, which stops on the sentence rather than two lines later
   * on the temple's room block, and cancels every queued movement intent with
   * it. What has already reached the wire cannot be recalled; the queue is
   * where the decision is still revisable.
   */
  stopGoingAnywhere(): void {
    this.homeward = null;
    const retreat = this.retreat;
    if (retreat !== null) {
      this.retreat = null;
      this.session.notice(t('session.safety.retreatDropped', { room: retreat.room }));
    }
    /*
     * A running lap is stopped; one already stopped **restates** why.
     *
     * The second half is not tidiness. `stop` is idempotent, so an
     * already-stopped lap took nothing from a death — and `pausedForFollowers`
     * is only spent when a publish shows the lap in some state other than
     * `stopped`, which a skipped `stop()` never produces. A `@wait`, a death,
     * and then `@ok` therefore walked the character out of the temple on a
     * follower's say-so, past both guards. The claim is spent here explicitly,
     * where the fact that spends it is.
     */
    if (this.loops.progress.status === 'running') this.loops.stop(t('session.loop.stoppedDied'));
    else this.loops.restate(t('session.loop.stoppedDied'));
    this.pausedForFollowers = false;
    // And an errand: the shop it was walking to is several maps away now.
    // With it goes the route it was shopping on behalf of — a death is the
    // player's cue to decide what happens next, not the client's.
    this.errandOwes = null;
    // And the choice to cross on the way there: the next journey asks again.
    this.crossing = null;
    this.supplies.abandon(t('session.supplies.abandonedDied'));
    // And the walk to a trainer, on exactly the same terms (todo 21).
    this.trainLevel.abandon();
    // And the hunt: the lair it was walking to is several maps from the
    // temple. Not *stood down* — a death is not the player pressing stop — so
    // the next status line surveys again from wherever the character stands.
    this.hunt.noteLapStopped();
    // And the errand that was collecting a key: the route it was collecting
    // for starts somewhere this character no longer is.
    this.itemErrand.abandon(t('session.supplies.abandonedDied'));
    // And the quest run, on the same terms: the temple is not on its plan.
    this.questRunner.abandon(t('session.supplies.abandonedDied'));
    // And what is left of a talk-box line: its moves were typed from there.
    this.session.dropTyped(true);
    /*
     * And a route still owed from a lost connection — the third holder of a
     * destination, and the one with the narrowest window: dialled back into
     * the lair it was standing in and killed before the entry probe placed
     * it, the character would otherwise be walked out of the temple towards
     * the destination it was heading for before the link went.
     */
    const journey = this.journey;
    if (journey !== null) {
      this.journey = null;
      this.session.notice(
        t('session.walk.notResumed', {
          destination: journey.name,
          reason: t('session.loop.stoppedDied')
        })
      );
    }
  }

  /**
   * Whether an escape is still in flight.
   *
   * The retreat cooldown is the window an attempt has to work in — it is a
   * floor on retrying, not a rate limit — so it is also the window in which
   * starting a fight would undo it. Read from the same two numbers the escape
   * itself uses rather than kept as a second flag, because a flag and a
   * timestamp are two things that can disagree about whether a character is
   * running away.
   */
  isRetreating(): boolean {
    if (this.lastEscapeSent === 0) return false;
    /*
     * Not gated on `retreat.enabled`, and that is the point of reading the
     * *sent* clock rather than the asked one. `Safety.onPvpBlow` runs the escape
     * whatever the switch says — a player opening on this character is not a
     * health threshold — so a character with the retreat switched off and
     * `pvp.action: retreat` on had a real move going out in the `emergency`
     * band while this reported *nothing is running away*, which let auto-combat
     * queue an attack on the same status line and both go out inside the 350ms
     * gap. That is the client running from a room and swinging on the way out,
     * in the one situation where the five-minute window makes it most
     * expensive.
     */
    return Date.now() - this.lastEscapeSent < this.automationConfig.safety.retreat.cooldownMs;
  }
}
