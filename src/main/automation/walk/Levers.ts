/**
 * The lever errand: a hidden exit's levers pulled where the walk stands, or
 * fetched from the room the realm keeps them in — one room, a set across
 * several in the realm's order, or a lever behind a lever (todo 740, out of
 * `Walker`). It also decides whether a refusal is news about the edge, which
 * turns on whether the client had a lever left to pull (`blameable`).
 *
 * The errand replaces the route rather than starting a walk, so an arrival at
 * a lever's room is never the journey's; `Walker` asks `finishErrand` ahead of
 * every arrival. The why is `mudengine-automation` › `parts/walking.md`.
 */
import {
  roomId,
  openableHere,
  type RemoteLever,
  type RoomId,
  type Route,
  type RouteStep
} from '../../../shared/world';
import type { CharacterState } from '../../../shared/character';
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import type { CommandQueue } from '../CommandQueue';
import type { WalkerEvents, WalkInFlight } from './ports';

/** What the lever errand asks of the walk it interrupts, answered by `Walker`. */
export interface LeversWalk extends Pick<WalkInFlight, 'quiet' | 'stop' | 'stepAgain'> {
  /** Whether this walk replans by distance alone (a lap's leg). */
  shortest(): boolean;
  /** The journey's last step: where an errand comes back to. */
  destination(): RouteStep | undefined;
  /** `route` in place of the plan, at a fresh step, and carried on from there. */
  detour(route: Route, state: CharacterState): void;
}

export type LeversEvents = Pick<
  WalkerEvents,
  'notice' | 'leversFor' | 'replan' | 'routeBetween' | 'stateNow'
>;

export class Levers {
  /**
   * Rounds of levers pulled at the step in flight — format 23's other kind of
   * hidden exit. Counted separately from `Barriers.searched`: an exit is one or the
   * other, and one budget for two remedies would let a search spend the pulls.
   */
  private levered = 0;
  /**
   * The levers this walk has gone to fetch, and the journey each interrupted.
   *
   * A route that reaches a gate it cannot open asks the realm what does open
   * it (`leversFor`); where the answer is a lever in another room, the walk
   * **goes and pulls it** and then plans on to where it was going. That is one
   * errand, and it is the reason the arrival at the lever's room is not an
   * arrival: `ended` must not fire, or a loop reading it would book the leg as
   * arrived and advance to the next stop while the gate is still shut.
   *
   * **A stack, because a lever can be behind a lever** (todo 807): a gate met
   * on an errand's way pushes an errand of its own, whose `back` is the room
   * the errand beneath was walking to — so its arrival there is that errand's,
   * handed down by `finishErrand`, and never the journey's. The top is the one
   * in hand; `tuning.walk.leverErrandDepth` bounds it and `detoured` spends
   * each gate once. Empty for nearly every walk.
   */
  private errands: Array<{
    /** The lever rooms still to visit, in the order they are to be visited. */
    rooms: Array<{ at: RoomId; say: string[] }>;
    back: RoomId;
    backName: string;
  }> = [];

  /** The errand in hand: the top of the stack, or null. */
  private get errand(): (typeof this.errands)[number] | null {
    return this.errands.at(-1) ?? null;
  }
  /**
   * The exits this walk has already made that errand for, `from|direction`.
   *
   * Bounded per walk rather than per step, because the errand *replaces the
   * route* — the step counters are reset by the walk to the lever, so a
   * counter could never bound this. Once is the whole budget that makes sense:
   * a lever pulled that did not open the gate is not a lever that opens it,
   * and walking back for it again is a lap of a corridor spent on the same
   * refusal. Cleared by `begin`, so the next leg of a loop may try again — the
   * gate may have shut behind the character.
   */
  private detoured = new Set<string>();
  /** Whether this step's unreachable levers have been reported. Said once. */
  private leverSaid = false;

  constructor(
    private readonly queue: Pick<CommandQueue, 'enqueue'>,
    private readonly events: LeversEvents,
    private readonly walk: LeversWalk
  ) {}

  /**
   * A new walk. A lever errand belongs to the journey that was interrupted,
   * which this replaces, and a gate may have shut behind the character since
   * the last leg tried it.
   */
  begin(): void {
    this.errands = [];
    this.detoured.clear();
    this.leverSaid = false;
  }

  /**
   * The walk stopped. The errand dies with the journey it was for: left
   * standing, the next walk's arrival would pull a lever for a gate nobody is
   * going through.
   */
  drop(): void {
    this.errands = [];
  }

  /**
   * The step landed. Said once per step, not once per round: the pulls are
   * forgotten by every retry behind the same door, and a line repeated twelve
   * times is the chrome talking over the game.
   */
  landed(): void {
    this.leverSaid = false;
  }

  /** The pulls spent at the step in flight, forgotten with the rest of its barrier. */
  forgetPulls(): void {
    this.levered = 0;
  }

  /** A new connection: forget everything. */
  reset(): void {
    this.levered = 0;
    this.errands = [];
    this.detoured.clear();
    this.leverSaid = false;
  }

  /**
   * Pulls the levers that open this hidden exit before sending the step, when
   * the room's obvious exits show that the way is not yet open.
   *
   * *"If exit doesn't exist and there is a command, don't try first"* (todo 03,
   * 2026-09-16). A hidden exit that needs an action (like `use fork south` in the
   * Catacombs) does not appear in `Obvious exits:` until it has been opened.
   * Sending the bare direction first spends a command just to be told `There is
   * no exit in that direction!`.
   *
   * Once the exit has been opened and joins `Obvious exits:`, this leaves it
   * alone and lets the step go out directly without wasting another action.
   *
   * A room whose exits were never read (`exits.length === 0`) proves nothing —
   * exactly as in `Barriers.mustSearchFirst` and `Barriers.shutAhead`.
   */
  pullLeversFirst(step: RouteStep, state: CharacterState): boolean {
    if (step.direction === 'portal') return false;
    if (!openableHere(step.requirement)) return false;
    if (state.room.exits.length === 0) return false;
    if (state.room.exits.some((exit) => exit.direction === step.direction)) return false;
    return this.pullLevers(step);
  }

  /**
   * Pulls the levers the realm says open this exit. Returns whether anything
   * was sent.
   *
   * The other kind of hidden exit, and the same rung as `Barriers.searchFor` in every
   * respect that matters: the refusal is not news — it is the step the realm
   * data already described — the answer is reactive rather than pre-emptive so
   * a lap pays for it once, and `edgePenalty` charged the commands into the
   * route when it chose this leg.
   *
   * **Only where every lever is in this room** (`openableHere`, the one
   * reading the price also uses). A passage whose lever is two rooms away is a
   * detour the router does not plan, and pulling the levers that *are* here
   * would spend commands on a passage that stays shut. The realm's own order
   * is what `Requirement.actions` is sorted in, which is what `specific order`
   * wants; `any order` does not care, so one order serves both.
   *
   * The first phrase of each, because the realm lists its own spelling first
   * and the rest are synonyms for the same lever — `Requirement.commands` on a
   * text exit is read exactly this way.
   *
   * Reported as todo 01: the realm said a concealed passage led south out of
   * Small Chamber 10/4 and that `pull lever` opened it, in the room's own `W`
   * column; the converter dropped that column, the walk was refused, and a
   * real corridor was struck out of every route for the session.
   */
  pullLevers(step: RouteStep): boolean {
    const need = step.requirement;
    if (!openableHere(need)) return false;
    if (this.levered >= tuning().walk.leverTries) return false;
    this.levered += 1;
    for (const act of need!.actions!) {
      const phrase = act.say[0];
      if (phrase === undefined) continue;
      this.queue.enqueue({
        command: phrase,
        priority: 'movement',
        reason: t('automation.walk.reasonLever', { stepName: step.name, phrase })
      });
    }
    // And the step again behind them, as `search` and `open` both do.
    // `Walker.sendCurrent` re-arms the deadline so the walk does not time out on the
    // levers' own round trip.
    this.walk.stepAgain();
    return true;
  }

  /**
   * Goes and pulls the lever that opens this step, wherever the realm keeps
   * it. Returns whether anything was sent.
   *
   * **The rung above every other one at a shut way**, and the only one that is
   * not a command sent at the door. It is reached once the ladder is spent —
   * `open` refused, nothing to force with — and once the two rungs that act on
   * a hidden exit in place have declined it.
   *
   * Reported as todo 01, from the wire: `Inner Gate`, `Obvious exits: closed
   * gate north`, a gate reading `Door [301 picklocks/strength]` against a
   * character with 0 picklocks and 86 strength, and the Guardroom **one room
   * west** holding the lever that raises it. The client sent `n` and `open n`
   * alternately until its budget ran out, wrote nothing down about the lever,
   * and the player walked west and typed `pull lever` themselves.
   *
   * ## Three shapes, and only two are acted on
   *
   * Measured over the shipped realm — 225 exits have a lever at all:
   *
   * | Where the levers are | Exits | What happens |
   * |---|---|---|
   * | all in the exit's own room | 171 | pulled in place, and the step again behind them |
   * | all in one other room | 35 | this errand: walk there, pull, plan on |
   * | spread over several rooms | 14 | refused, out loud |
   * | naming an exit the room does not have | 5 | nothing to route through |
   *
   * The first shape overlaps `pullLevers`, which serves the 150 of it whose
   * exit *states* `Needs N Actions`. The other 21 say `Door` and nothing else,
   * so nothing reading the requirement could ever have found them — which is
   * exactly the Inner Gate's shape one room closer.
   *
   * **Several rooms is refused rather than attempted.** A `specific order`
   * across two rooms is a journey with an ordering constraint, and pulling the
   * ones that are reachable spends commands on a passage that stays shut —
   * `buildRealm` already refuses to write `actions` for the same reason.
   *
   * ## Why it replaces the route rather than starting a new walk
   *
   * `Walker.start` raises `destination` and `ended`, and a loop reads both: an
   * arrival at the Guardroom would be booked as the leg arriving and the lap
   * would advance to the next stop with the gate still shut. So the route is
   * swapped in place and `Walker.carryOn` takes it from there — the same mechanism
   * `Holds.resumeFromFight` uses, and for the same reason.
   */
  fetchLever(step: RouteStep): boolean {
    const destination = this.walk.destination();
    if (destination === undefined) return false;
    if (step.direction === 'portal') return false;
    /*
     * **An errand met on an errand's way is pushed, never swapped in** (todo
     * 807). `back` is taken from the route in flight, which during an errand
     * is the way to the outer errand's lever room rather than to where the
     * player asked to go — and that is the right place to come back to,
     * because the outer errand is still on the stack beneath and takes the
     * arrival there as its own. Swapping it in (the old single slot) made the
     * lever room the journey's destination and fired `ended(true)` on reaching
     * it, a loop booking a leg it never walked, so a second gate was left to
     * the barrier ladder and a chain of five levers lapped its rooms until the
     * rounds ran out. Bounded by depth; `detoured` spends each gate once.
     */
    if (this.errands.length >= tuning().walk.leverErrandDepth) return false;
    const key = `${step.from}|${step.direction}`;
    if (this.detoured.has(key)) return false;
    const levers = this.events.leversFor?.(step.from, step.direction) ?? [];
    if (levers.length === 0) return false;

    /*
     * Grouped by the room each is pulled in, in the order the realm listed
     * them — which is what `specific order` wants and what `any order` does
     * not care about, so one order serves both.
     */
    const rooms = new Map<RoomId, RemoteLever[]>();
    for (const lever of levers) {
      const held = rooms.get(lever.at);
      if (held) held.push(lever);
      else rooms.set(lever.at, [lever]);
    }

    /*
     * **A set spread over rooms is a round of them**, and the realm's own count
     * is what says it is a set: `buildRealm` writes `Requirement.actions` only
     * when the stated count matches the levers found, and this is that same
     * test asked of a journey rather than of a room. Eleven exits of the
     * shipped realm are `Needs N Actions` with N levers over several rooms —
     * six across two, two across three, two across four and one across seven.
     * `runLeverSet` walks them; it was a refusal until todo 04 reported one of
     * the six (`1/1056` north, two levers, `any order`).
     */
    const needed = step.requirement?.actionsNeeded;
    if (rooms.size > 1 && needed !== undefined && needed === levers.length) {
      return this.runLeverSet(step, key, rooms.size);
    }

    /*
     * Everything else names **alternatives**, and the realm says so two ways:
     * a count smaller than the levers found (`Needs 1 Actions` with a lever on
     * each side of the door — 2 exits), or no count at all, which is the
     * reported gate. `1/1331` north out of Inner Gate reads `Door [301
     * picklocks/strength]`, and the two Guardrooms flanking it — 1/1339 east
     * and 1/1345 west — each hold a lever. The wire settles which reading is
     * right: the player walked into **one** of them, typed `pull lever`, and
     * the gate came up.
     *
     * So one room is chosen and every lever in it is pulled: the room the
     * character is already standing in first, and otherwise the cheapest the
     * router will actually take us to.
     */
    const here = rooms.get(step.from);
    if (here !== undefined) {
      this.detoured.add(key);
      this.pull(here, step.name);
      this.walk.stepAgain();
      return true;
    }

    const state = this.events.stateNow?.();
    if (state === undefined) return false;

    let best: { at: RoomId; route: Route } | null = null;
    let why: string | null = null;
    for (const at of rooms.keys()) {
      const there = this.events.replan?.(at, this.walk.shortest());
      if (there === undefined) return false;
      if (typeof there === 'string') {
        why ??= there;
        continue;
      }
      if (there.blocked || there.steps.length === 0) {
        why ??= there.reason ?? null;
        continue;
      }
      if (best === null || there.cost < best.route.cost) best = { at, route: there };
    }
    if (best === null) {
      /*
       * The realm names the lever and this client cannot get to it. Said out
       * loud, because a walk that then stands at the gate until its rounds run
       * out is otherwise indistinguishable from one that never knew — and
       * spent, so the barrier's remaining rounds do not each cost a route
       * search over the whole realm for the same answer.
       */
      this.detoured.add(key);
      this.sayLeverUnreachable(levers[0]!, why);
      return false;
    }

    const pulling = rooms.get(best.at)!;
    this.detoured.add(key);
    this.errands.push({
      rooms: [{ at: best.at, say: pulling.map((lever) => lever.say) }],
      back: destination.to,
      backName: destination.name
    });
    if (!this.walk.quiet()) {
      this.events.notice?.(
        t('automation.walk.leverFetching', {
          phrase: pulling[0]!.say,
          roomName: pulling[0]!.roomName,
          stepName: step.name
        })
      );
    }
    this.walk.detour(best.route, state);
    return true;
  }

  /** Queues each lever in the room the character is standing in. */
  private pull(levers: readonly RemoteLever[], stepName: string): void {
    for (const lever of levers) {
      this.queue.enqueue({
        command: lever.say,
        priority: 'movement',
        reason: t('automation.walk.reasonLever', { stepName, phrase: lever.say })
      });
    }
  }

  /**
   * The errand is over: pull what was come for and plan on to where the walk
   * was going. Returns whether it took the arrival.
   *
   * The lever goes out ahead of the first step of the way back because the two
   * share the `movement` band and the arbiter keeps a band in order -- the same
   * property that puts a torch on the wire before the step it lights.
   *
   * **The way back is planned from here, before the lever has been answered**,
   * and that is deliberate: the router priced this gate as passable-but-dear
   * when it chose to come this way, and it will price it the same again. A
   * plan that waited for the gate to be seen open would need a room block
   * nobody has asked for.
   */
  finishErrand(state: CharacterState): boolean {
    const errand = this.errand;
    if (errand === null) return false;
    const done = errand.rooms.shift();
    if (done === undefined) {
      // An errand with nothing left to pull: its arrival, like the branch
      // below, is the errand beneath's where there is one (todo 807).
      this.errands.pop();
      return this.errand === null ? false : this.finishErrand(state);
    }
    /*
     * The levers go out before the fight is consulted, deliberately. They are
     * `movement` band, so they displace no attack, and pulling the lever is the
     * whole reason the character walked here — holding it would leave the
     * errand standing in the lever room with the gate still shut, which is
     * strictly worse than one command spent mid-round. The **step** that
     * follows is held the ordinary way, by `Walker.carryOn`.
     */
    for (const phrase of done.say) {
      this.queue.enqueue({
        command: phrase,
        priority: 'movement',
        reason: t('automation.walk.reasonLever', { stepName: errand.backName, phrase })
      });
    }

    /*
     * The next lever room, or the journey the errand interrupted. Both are
     * planned from **here** through `replan`, because that is where the
     * character is standing now — `routeBetween` was only for checking the run
     * before any of it was walked.
     */
    const next = errand.rooms[0];
    const to = next?.at ?? errand.back;
    if (!this.walk.quiet()) {
      this.events.notice?.(
        next === undefined
          ? t('automation.walk.leverPulled', { destination: errand.backName })
          : t('automation.walk.leverNext', { roomCount: errand.rooms.length })
      );
    }
    const on = this.events.replan?.(to, this.walk.shortest());
    if (on === undefined || typeof on === 'string') {
      this.errands = [];
      this.walk.stop(on ?? t('automation.walk.refusalNoRoute'));
      return true;
    }
    if (on.blocked) {
      this.errands = [];
      this.walk.stop(on.reason ?? t('automation.walk.refusalNoRoute'));
      return true;
    }
    if (on.steps.length === 0) {
      /*
       * Nowhere to walk.
       *
       * On the **last** leg that is the errand's own room being where the walk
       * was going, so this really is the arrival and falling through reports
       * one. On a **middle** leg it would mean two lever rooms resolving to the
       * same place, which `runLeverSet` cannot build — it groups by room — so
       * the branch is unreachable by construction rather than by argument. It
       * is answered anyway, by pulling what is there and asking again, because
       * the cost of being wrong about "cannot happen" here is an `ended(true)`
       * for a journey that has not finished.
       */
      if (next !== undefined) return this.finishErrand(state);
      /*
       * The last lever of a nested errand pulled where its way back begins:
       * that room is the one the errand beneath was walking to, so this is
       * its arrival, handed down — never the journey's (todo 807).
       */
      this.errands.pop();
      return this.errand === null ? false : this.finishErrand(state);
    }
    // Walking back: the way to `back` is the errand beneath's own walk, and
    // arriving is its arrival, or the journey's where there is none.
    if (next === undefined) this.errands.pop();
    // The way on starts at a fresh step, and the gate the errand was for is
    // several steps ahead rather than one command away.
    this.walk.detour(on, state);
    return true;
  }

  /**
   * Walks a **set** of levers spread over several rooms, in the realm's own
   * order. Returns whether anything was sent.
   *
   * Reported as todo 04 and correctly guessed to be todo 01's: `Crypt, Stone
   * Hallway` 1/1056 leaves north through `Hidden/Needs 2 Actions, any order`
   * with a lever in 1/1038 and another in 1/1044. Todo 01 taught the client to
   * fetch **one** lever and refused this shape outright; the report is the
   * refusal, one room further on — the walk stopped, and the console said the
   * realm data had promised an exit that did not exist about an exit that does.
   *
   * Eleven exits of the shipped realm are this shape: six across two rooms,
   * two across three, two across four and one across seven; five say `any
   * order` and six `specific order`.
   *
   * - **The order is the realm's**, and it is `Requirement.actions` that has
   *   it: `buildRealm` sorts those by the realm's own lever index, where the
   *   room-command index this rung otherwise reads is in whatever order the
   *   rooms were loaded. So a set is refused outright when `actions` is absent
   *   or does not place every lever — with no stated order there is nothing to
   *   honour, and `specific order` is six of the eleven. That costs nothing:
   *   `actions` is written exactly when the realm's count matches the levers
   *   found, which is the same test that makes this a set at all.
   * - **The whole run is checked before the first lever.** All or nothing is
   *   what a set means, and pulling some of them spends commands on a passage
   *   that stays shut — `buildRealm`'s own reason for refusing a half-matched
   *   list. `replan` answers the first leg and `routeBetween` the rest, since
   *   those start somewhere the character is not yet.
   */
  private runLeverSet(step: RouteStep, key: string, rooms: number): boolean {
    const destination = this.walk.destination();
    if (destination === undefined) return false;
    const acts = step.requirement?.actions;
    if (acts === undefined || acts.some((act) => act.at === undefined)) {
      this.detoured.add(key);
      this.sayLeversScattered(step, rooms);
      return false;
    }

    /*
     * The rooms in the realm's order, each with every lever pulled in it — two
     * levers in one room are one visit, and the realm's order between them is
     * the order they are queued in.
     */
    const chain: Array<{ at: RoomId; say: string[] }> = [];
    for (const act of acts) {
      const at = roomId(act.at!.map, act.at!.room);
      const phrase = act.say[0];
      if (phrase === undefined) continue;
      const last = chain.at(-1);
      if (last?.at === at) last.say.push(phrase);
      else chain.push({ at, say: [phrase] });
    }
    if (chain.length === 0) {
      this.detoured.add(key);
      this.sayLeversScattered(step, rooms);
      return false;
    }

    const state = this.events.stateNow?.();
    if (state === undefined) return false;

    // Leg one from here; the rest between rooms the character is not in yet.
    const first = this.events.replan?.(chain[0]!.at, this.walk.shortest());
    if (first === undefined) return false;
    let why: string | null = typeof first === 'string' ? first : null;
    let walkable = typeof first !== 'string' && !first.blocked;
    for (let leg = 1; walkable && leg < chain.length; leg += 1) {
      const between = this.events.routeBetween?.(
        chain[leg - 1]!.at,
        chain[leg]!.at,
        this.walk.shortest()
      );
      if (between === undefined || typeof between === 'string') {
        why ??= typeof between === 'string' ? between : null;
        walkable = false;
        break;
      }
      if (between.blocked) {
        why ??= between.reason ?? null;
        walkable = false;
      }
    }
    // And back to the gate, or the levers buy a room nothing can leave.
    if (walkable) {
      const home = this.events.routeBetween?.(chain.at(-1)!.at, step.from, this.walk.shortest());
      if (home === undefined || typeof home === 'string' || home.blocked) {
        why ??= typeof home === 'string' ? home : (home?.reason ?? null);
        walkable = false;
      }
    }
    if (!walkable) {
      this.detoured.add(key);
      this.sayLeverRunRefused(step, rooms, why);
      return false;
    }

    const opening = first as Route;
    this.detoured.add(key);
    this.errands.push({ rooms: chain, back: destination.to, backName: destination.name });
    if (!this.walk.quiet()) {
      this.events.notice?.(
        t('automation.walk.leverRun', { roomCount: chain.length, stepName: step.name })
      );
    }
    /*
     * The first room being the one the character is standing in is possible in
     * principle and does not happen in the shipped realm — a set is only a set
     * because its levers span rooms, and if one of them were here the run
     * would start with nothing to walk. `finishErrand` handles it either way:
     * an empty leg pulls what is here and plans the next.
     */
    if (opening.steps.length === 0) return this.finishErrand(state);
    this.walk.detour(opening, state);
    return true;
  }

  /**
   * Said once per step: the levers are a set the realm places in several rooms
   * and the run through them cannot be walked.
   *
   * Distinct from `sayLeversScattered`, which is the realm not stating an
   * order to walk them in. Both leave the way shut; a player reading the
   * console needs to know which, because only one of them is something they
   * can go and do by hand.
   */
  private sayLeverRunRefused(step: RouteStep, rooms: number, why: string | null): void {
    if (this.leverSaid || this.walk.quiet()) return;
    this.leverSaid = true;
    this.events.notice?.(
      t('automation.walk.leverRunRefused', {
        stepName: step.name,
        roomCount: rooms,
        reason: why ?? t('automation.walk.refusalNoRoute')
      })
    );
  }

  /** Said once per step: the realm keeps this exit's levers in several rooms. */
  private sayLeversScattered(step: RouteStep, rooms: number): void {
    if (this.leverSaid || this.walk.quiet()) return;
    this.leverSaid = true;
    this.events.notice?.(
      t('automation.walk.leversScattered', { stepName: step.name, roomCount: rooms })
    );
  }

  /** Said once per step: the lever is named and there is no way to it. */
  private sayLeverUnreachable(lever: RemoteLever, why: string | null): void {
    if (this.leverSaid || this.walk.quiet()) return;
    this.leverSaid = true;
    this.events.notice?.(
      t('automation.walk.leverUnreachable', {
        phrase: lever.say,
        roomName: lever.roomName,
        reason: why ?? t('automation.walk.refusalNoRoute')
      })
    );
  }

  /**
   * Whether this refusal is safe to write down against the edge.
   *
   * `There is no exit in that direction!` is not proof there is no exit, and a
   * hidden one says it until it has been found. Only once the searches have
   * been spent does the refusal say anything about the edge; before that it
   * says the client has not done its part yet.
   */
  blameable(step: RouteStep): boolean {
    const need = step.requirement;
    if (need?.kind !== 'hidden') return true;
    /*
     * **Never**, for an exit the realm says a search reveals. The searching
     * has no ceiling now (todo 04), so there is no point at which the refusal
     * becomes news about the edge — and writing one down is what took a real
     * corridor out of every route for the session in the report.
     */
    if (need.searchable === true) return false;
    /*
     * A lever exit is blamed only once its levers have been spent, and one
     * whose levers are **elsewhere is never blamed**: the client has not done
     * its part and has no way to, so the refusal says nothing about the edge.
     * Writing it into `refusedEdges` is what took a real corridor out of every
     * route for the session (todo 01).
     */
    if (openableHere(need)) return this.levered >= tuning().walk.leverTries;
    /*
     * And an exit the realm names a lever for **anywhere** is not blamed until
     * that errand has been run: the client had something left to do and had
     * not done it, so the refusal says nothing about the edge. That is the
     * whole of the rule this list keeps — a refusal is news only while there
     * is nothing left to try. Once the lever has been pulled and the way is
     * still shut, the errand is spent and the edge is blamed like any other.
     */
    if (this.leverAhead(step)) return false;
    /*
     * **Everything else hidden is blamed as it always was**, and the rule is
     * one sentence: a refusal is not news only while the client still has
     * something to try. Those are the two above — a search that never stops,
     * and levers within reach — and nothing else.
     *
     * That is 1,000 `Hidden/Passable` exits of the shipped realm's 1,469, plus
     * the 23 that state `Needs N Actions` and have no lever indexed against
     * them at all — a subset of the 28 whose stated count and lever count
     * disagree, which is why the two figures are not the same one told twice. In every one the client has nothing left to
     * do, so a route through it is a leg that fails again — which is what
     * `refusedEdges` exists to stop being replanned. An earlier cut of this
     * returned false for the lot, applying the lever argument to a set five
     * times its size without measuring it; a lap would have replanned the
     * identical refused leg until `LoopRunner` gave up, where before it
     * rerouted. Counted against the shipped file, reviewer's find 2026-09-06.
     */
    return true;
  }

  /**
   * Whether the realm names a lever for this step that this walk has not yet
   * been to fetch.
   *
   * Only the *existence* of one, deliberately: whether it can be reached is
   * `fetchLever`'s question and it answers it by trying. What this decides is
   * whether the refusal is news about the edge, and a client that has not been
   * to the lever has no business writing the corridor off either way.
   */
  private leverAhead(step: RouteStep): boolean {
    if (step.direction === 'portal') return false;
    if (this.detoured.has(`${step.from}|${step.direction}`)) return false;
    return (this.events.leversFor?.(step.from, step.direction) ?? []).length > 0;
  }
}
