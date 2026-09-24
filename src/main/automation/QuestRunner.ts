/**
 * Carrying a quest's plan through the arbiter (todos 102 and 103, 2026-09-21).
 *
 * `QuestPlan` says what each step gathers, where it happens and what is done
 * there, and nothing carried one. This does — one step at a time and one
 * thing at a time. The pack is read; each `Get` row is fetched the way its
 * source says (bought through `Supplies`, hunted through `ItemErrand`, asked
 * for or said at a script); the way to the act is walked as a leg; the act is
 * sent; and the outcome is **read**, never assumed — the counter `abil`
 * prints on GreaterMUD, the pack on a realm that prints none.
 *
 * An errand in `Supplies`' shape: it yields to a fight, a move and an escape,
 * holds the lap rather than ending it, and says every refusal out loud
 * (`SafetyDecision`, action `quest`). Off under `automation.quests.enabled`.
 * See `mudengine-automation` § *A quest's plan is carried step by step, and
 * the counter is the confirmation*.
 */
import type { CommandQueue } from './CommandQueue';
import {
  AFTER_WORD,
  noteListing as answers,
  packAfter,
  packCheck,
  type PackCheck
} from './PackAfter';
import { fightIsRunning } from './Walker';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import { packRows, type CharacterState } from '../../shared/character';
import type { QuestsConfig, SupplyItem } from '../../shared/config';
import {
  IDLE_QUEST_RUN,
  stepRoll,
  type PlanItem,
  type PlanStep,
  type Quest,
  type QuestPlan,
  type QuestRunPhase,
  type QuestRunProgress,
  type QuestStep,
  type QuestWatched
} from '../../shared/quests';
import { carriedCount } from '../../shared/supplies';
import {
  asRoomReference,
  mobKey,
  nameAnswersTo,
  type RoomId,
  type Route
} from '../../shared/world';

export interface QuestRunPlanner {
  /** Where the character stands, or null while unplaced. */
  here(): RoomId | null;
  /**
   * Whether this realm prints its quest counters — GreaterMUD's `abil`, the
   * one command anywhere that states one. Where it does not, the pack is the
   * only outcome the client can read.
   */
  printsCounters(): boolean;
  /** A route to a room, or the reason there is none. */
  routeTo(room: RoomId): Route | string;
  /** Hands the route to the walker as a leg. Its refusal, or null. */
  walk(route: Route): string | null;
  /** Stops the leg this run is walking, if one is. */
  stopWalking(reason: string): void;
  moveInFlight(): boolean;
  walking(): boolean;
  /** An escape in flight, a haven armed: not now. */
  busy(): boolean;
  looping(): boolean;
  /** Holds the lap for the run, and gives it back. */
  hold(): void;
  release(): void;
  /** A session supply row through the shopping errand. Its refusal, or null once walking. */
  buy(row: SupplyItem): string | null;
  buying(): boolean;
  /**
   * A stock row below its floor that **this** leg should fill, given the
   * rooms the plan still has to visit — null where nothing is short, or
   * where a later leg passes nearer the counter and it can wait. The row
   * comes back as a plan item so the run gathers it the way it gathers
   * everything else.
   */
  restock(to: RoomId | null, later: readonly RoomId[]): PlanItem | null;
  /** Hunt an item off the monsters that drop it, through the item errand. */
  hunt(item: { id: number; name: string }): string | null;
  hunting(): boolean;
  /** Both errands, given up: a run that stops takes what it started with it. */
  abandonErrands(reason: string): void;
  /** Fight this monster by name whatever the combat policy says, and stop. */
  fightFor(mob: string): void;
  stopFighting(mob: string): void;
  /** Auto-combat on for the run, as it is for a route. */
  questing(on: boolean): void;
  /** Wards on for the run: the plan's supplies are bought to be used. */
  warding(on: boolean): void;
  /** A line this run sent at an asker or a room, so the book watches it. */
  said(command: string): void;
  /** What this character has been watched doing about each quest. */
  watched(): QuestWatched;
}

export interface QuestRunEvents {
  notice?(message: string): void;
  decided?(decision: SafetyDecision): void;
  progress?(progress: QuestRunProgress): void;
}

/**
 * What the run is waiting on. Every phase that waits on the wire carries the
 * moment it began, and every wait is bounded — a run that stopped in silence
 * is a character standing in a corridor until somebody looks.
 */
type Phase =
  /**
   * Nothing outstanding: the next state decides what to do. Carries a moment
   * because `decide` waits here for a move and a fight, and a wait with no
   * clock is the whole failure this phase used to sit in.
   */
  | { kind: 'deciding'; since: number }
  /** Stood still by a setback, waiting to try the same thing again. */
  | { kind: 'held'; since: number; why: string }
  /** `i` asked for a pack nobody has listed. */
  | { kind: 'listing'; since: number }
  | {
      kind: 'fetching';
      item: PlanItem;
      how: 'buy' | 'hunt';
      since: number;
      before: number;
    }
  | {
      kind: 'fetching';
      item: PlanItem;
      how: 'handover';
      since: number;
      /** How many the pack held when the fetch began. */
      before: number;
      /** Its answer, read off a listing asked for after it. */
      pack: PackCheck;
    }
  | { kind: 'walking'; to: RoomId; legs: number; since: number; at: RoomId | null }
  /** A fight ended the leg; the next leg waits for it to be over. */
  | { kind: 'waiting'; to: RoomId; legs: number; since: number }
  /** At the act's room: waiting for the asker or the monster, or fighting it. */
  | { kind: 'acting'; since: number }
  | {
      kind: 'confirming';
      sentAt: number;
      /** When `abil` was last asked, and how many times. */
      asked: number | null;
      askedTimes: number;
      /** The pack before the act, by item id, for a realm that prints no counter. */
      before: ReadonlyMap<number, number>;
      /** And the pack after it, where no counter says. */
      pack: PackCheck;
    };

/** The key the act goes out under, so a run that stops can take it back. */
const ACT_KEY = 'quests:act';
/** And the listing asked after it, under its own key and in `AFTER_WORD`. */
const AFTER_KEY = 'quests:after';

interface Run {
  plan: QuestPlan;
  quest: Quest;
  /** The plan's step being carried. */
  at: number;
  /** The next of that step's items to gather. */
  item: number;
  /** Tries spent on the step's roll. */
  tries: number;
  /** The step the stock list was last asked about, so it is asked once each. */
  stocked: number;
  /**
   * The stock row being filled, gathered ahead of the step's own items and
   * kept **here** rather than spliced into the plan: the plan is what the
   * card drew and is nobody's scratch space.
   */
  stock: PlanItem | null;
  /** Setbacks since the run last got anywhere. Spent, the run gives up. */
  setbacks: number;
  phase: Phase;
}

const ACTION = 'quest';

export class QuestRunner {
  private run: Run | null = null;
  /** Whether a lap was held for this run, and so is owed back. */
  private heldLap = false;
  /** What was last published, so an unchanged phase is not pushed per status line. */
  private lastPublished: string | null = null;
  /** What the last run ended as, so the card can say it after the fact. */
  private idle: QuestRunProgress = IDLE_QUEST_RUN;

  constructor(
    private config: QuestsConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly planner: QuestRunPlanner,
    private readonly events: QuestRunEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(config: QuestsConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  /** New connection: nothing is being run. */
  reset(): void {
    if (this.run !== null) this.end('stopped', t('automation.quests.whyReset'));
  }

  get running(): boolean {
    return this.run !== null;
  }

  get progress(): QuestRunProgress {
    const run = this.run;
    if (run === null) return this.idle;
    return this.progressOf(run);
  }

  /**
   * Begin carrying `plan`. Returns the refusal for the press, or null once it
   * is under way.
   *
   * The switch first, then whatever else has the character: a route the
   * player is walking is theirs and is not superseded, and a lap is held
   * rather than ended, which is `Supplies`' rule.
   */
  start(plan: QuestPlan, quest: Quest, state: CharacterState): string | null {
    if (!this.enabled || !this.config.enabled) {
      return this.refuseStart(t('automation.quests.refusalSwitchedOff'));
    }
    if (this.run !== null) return this.refuseStart(t('automation.quests.refusalBusy'));
    if (state.phase !== 'in-game')
      return this.refuseStart(t('automation.quests.refusalNotInRealm'));
    if (plan.steps.length === 0) return this.refuseStart(t('automation.quests.refusalNothing'));
    if (this.planner.here() === null)
      return this.refuseStart(t('automation.quests.refusalUnplaced'));
    if (this.planner.walking() && !this.planner.looping()) {
      return this.refuseStart(t('automation.quests.refusalWalking'));
    }
    if (this.planner.busy()) return this.refuseStart(t('automation.quests.refusalEscaping'));

    this.run = {
      plan,
      quest,
      at: 0,
      item: 0,
      tries: 0,
      stocked: -1,
      stock: null,
      setbacks: 0,
      phase: { kind: 'deciding', since: this.now() }
    };
    this.heldLap = this.planner.looping();
    if (this.heldLap) this.planner.hold();
    this.planner.questing(true);
    // Only a plan that bought a ward has one to use; the release below is
    // unconditional, so a run never leaves the lend standing.
    if (plan.steps.some((step) => step.items.some((item) => item.stops !== undefined))) {
      this.planner.warding(true);
    }
    const to = this.rankOf(this.run);
    this.events.notice?.(
      t('automation.quests.started', {
        quest: quest.name,
        to: to ?? '?',
        count: plan.steps.length
      })
    );
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: this.because(),
      acted: true
    });
    this.publish();
    this.decide(state);
    return null;
  }

  /**
   * The player asked for it to stop. Everything it started stops with it.
   *
   * The run is put down **before** the walker is stopped: the walker reports
   * its ending synchronously, and a run still standing would read that report
   * as a leg to plan again.
   */
  stop(reason: string): void {
    const run = this.run;
    if (run === null) return;
    this.run = null;
    this.planner.stopWalking(reason);
    this.settle(run, 'stopped', t('automation.quests.abandoned', { why: reason }));
  }

  /**
   * A death, the realm left, the player steering: the run is off, said out
   * loud, because a run that stopped silently is a chain the player thinks
   * is still being walked.
   */
  abandon(reason: string): void {
    if (this.run === null) return;
    this.end('stopped', t('automation.quests.abandoned', { why: reason }));
  }

  /** The player typed a direction: the one thing an errand never argues with. */
  notePlayerMoved(): void {
    this.abandon(t('automation.quests.whyPlayerMoved'));
  }

  /** Every state change, and the session's own tick between them. */
  onCharacter(state: CharacterState): void {
    const run = this.run;
    if (run === null) return;
    if (state.phase !== 'in-game') {
      this.abandon(t('automation.quests.whyLeftRealm'));
      return;
    }
    if (!this.enabled || !this.config.enabled) {
      this.abandon(t('automation.quests.whySwitchedOff'));
      return;
    }
    const phase = run.phase;
    switch (phase.kind) {
      case 'deciding':
        /*
         * `decide` waits here for a move on the wire and for a fight, both of
         * which pass by themselves — but only one of them is guaranteed to.
         * An `attackers` list a flight left standing, or a move nothing ever
         * answers, is a run parked in a corridor until somebody looks, which
         * is what happened on 2026-09-22. Bounded like every other wait.
         */
        if (this.now() - phase.since > tuning().quests.waitForMs) {
          this.setback(t('automation.quests.whyNothingMoved'));
          return;
        }
        this.decide(state);
        return;
      case 'held':
        if (this.now() - phase.since < tuning().quests.retryMs) return;
        run.phase = { kind: 'deciding', since: this.now() };
        this.decide(state);
        return;
      case 'listing':
        if (packRows(state.inventory) !== null) {
          run.phase = { kind: 'deciding', since: this.now() };
          this.decide(state);
          return;
        }
        if (this.now() - phase.since > tuning().quests.replyMs) {
          this.setback(t('automation.quests.refusalPackUnread'));
        }
        return;
      case 'fetching':
        this.fetching(run, phase, state);
        return;
      case 'walking':
        /*
         * `Walker.start` raises no `ended` when it *replaces* a running walk,
         * so a leg superseded by the player's own route would otherwise leave
         * the run at `walking` for ever. The walker is asked instead: a leg
         * that is no longer walking has ended one way or another.
         */
        if (!this.planner.walking()) {
          this.onWalkEnded(false, null, state);
          return;
        }
        /*
         * A leg standing still this long is not under way — a walker held for
         * a light it will never have keeps `walking` true. Measured from the
         * last room reached rather than from the leg's start, so a long
         * crossing is not cut, and reset while the character is sitting down,
         * since a walk held for health is the walker working.
         */
        if (this.planner.here() !== phase.at || state.vitals.resting || state.vitals.meditating) {
          phase.at = this.planner.here();
          phase.since = this.now();
          return;
        }
        if (this.now() - phase.since > tuning().quests.waitForMs) {
          /*
           * The phase is moved **first**: the walker reports its ending
           * synchronously, and a run still at `walking` reads that report as
           * a leg to plan again — `stop`'s own rule, one method up.
           */
          this.setback(t('automation.quests.whyLegStalled'));
          this.planner.stopWalking(t('automation.quests.whyLegStalled'));
        }
        return;
      case 'waiting':
        if (fightIsRunning(state) || this.planner.moveInFlight()) {
          if (this.now() - phase.since > tuning().quests.waitForMs) {
            this.setback(t('automation.quests.whyNothingMoved'));
          }
          return;
        }
        /*
         * **A fight does not spend the leg budget.** `maxLegs` is there for a
         * way that will not work; a corridor of saracens is a way that is
         * busy, and six interruptions in one used to end a quest that was
         * getting there fine. The clock above is what bounds this instead.
         */
        this.leg(phase.to, phase.legs, false);
        return;
      case 'acting':
        this.act(run, phase, state);
        return;
      case 'confirming':
        this.confirm(run, phase, state);
        return;
    }
  }

  /** The walker's report: the run's own leg ended, or somebody else's walk did. */
  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    const run = this.run;
    if (run === null) return;
    /*
     * The player pressed Stop: compared against the copy itself, which is the
     * loop's and the supply errand's own rule — and read **whatever the run
     * is doing**, since an errand's leg is walking too and a run that took
     * that for a setback would start the same errand again in twenty seconds.
     */
    if (reason === t('session.walk.stoppedByPlayer')) {
      this.abandon(t('automation.quests.whyStopped'));
      return;
    }
    if (run.phase.kind !== 'walking') return;
    const { to, legs } = run.phase;
    if (arrived && this.planner.here() === to) {
      run.setbacks = 0;
      run.phase = { kind: 'deciding', since: this.now() };
      this.decide(state);
      return;
    }
    // A fight is the one ending that is not one: the leg is planned again
    // from wherever the fight leaves the character.
    if (fightIsRunning(state)) {
      run.phase = { kind: 'waiting', to, legs, since: this.now() };
      this.publish();
      return;
    }
    if (legs >= tuning().quests.maxLegs) {
      this.setback(
        t('automation.quests.refusalNotReached', {
          room: this.placeName(to),
          why: reason ?? t('automation.quests.whyWalkStopped')
        })
      );
      return;
    }
    this.leg(to, legs);
  }

  // ---------------------------------------------------------------- deciding

  /**
   * What to do next, from where the run stands: the next item to gather, the
   * walk to the act, or the act itself. Every branch either sends something
   * and sets the phase that waits for its answer, or refuses out loud.
   */
  private decide(state: CharacterState): void {
    const run = this.run;
    if (run === null) return;
    const step = run.plan.steps[run.at];
    if (step === undefined) {
      this.finish();
      return;
    }
    const realm = this.realmStep(run, step);
    if (realm === undefined) {
      this.refuse(t('automation.quests.refusalUnknownStep', { block: step.block }));
      return;
    }
    /*
     * A rank already behind the character: the plan was drawn against an
     * older listing, or a step was done by hand between two of this run's
     * own. What the realm counts is what decides, never the plan's row.
     */
    if (realm.to !== undefined && this.rankNow(run, state) >= realm.to) {
      this.advance(run, state);
      return;
    }
    /*
     * A fetch and a leg are journeys, and they pass every guard a journey
     * does: a move still on the wire and a fight running are waited out
     * here, on the next state, rather than handed to an errand that would
     * refuse them and end the run for a moment that passes by itself.
     */
    if (this.planner.moveInFlight() || fightIsRunning(state)) return;
    // An unlisted pack is not an empty one: nothing is fetched or refused on
    // its account until the listing has been read.
    if (packRows(state.inventory) === null) {
      run.phase = { kind: 'listing', since: this.now() };
      this.queue.enqueue({
        command: 'i',
        priority: 'probe',
        coalesceKey: 'quests:pack',
        expiresAt: this.now() + tuning().quests.expiresMs,
        reason: t('automation.quests.reasonPack')
      });
      this.publish();
      return;
    }
    /*
     * The character's own stock list, asked once per step. A torch that burnt
     * out three rooms ago is not in a plan drawn before the run started, and
     * the run is the only thing holding the character — `Supplies` considers
     * nothing at all while one is going. Whether it is worth the detour *now*
     * is the planner's answer, priced against every leg the plan has left.
     */
    if (run.stocked !== run.at) {
      run.stocked = run.at;
      const row = this.planner.restock(step.at?.room ?? null, this.roomsLeft(run));
      if (row !== null) {
        run.stock = row;
        this.events.notice?.(
          t('automation.quests.stockingUp', { item: row.name ?? `#${row.id}`, nth: run.at + 1 })
        );
      }
    }
    if (run.stock !== null) {
      if (this.held(state, run.stock) === true) run.stock = null;
      else {
        this.gather(run, step, run.stock, state);
        return;
      }
    }
    while (run.item < step.items.length) {
      const item = step.items[run.item]!;
      if (this.held(state, item) === true) {
        run.item += 1;
        continue;
      }
      this.gather(run, step, item, state);
      return;
    }
    const here = this.planner.here();
    if (step.at !== undefined && here !== step.at.room) {
      this.leg(step.at.room, 0);
      return;
    }
    run.phase = { kind: 'acting', since: this.now() };
    this.publish();
    this.act(run, run.phase, state);
  }

  /** The rooms the plan still has to reach after the step being carried. */
  private roomsLeft(run: Run): RoomId[] {
    return run.plan.steps
      .slice(run.at + 1)
      .flatMap((step) => (step.at === undefined ? [] : [step.at.room]));
  }

  /** The realm's own step behind a plan's row. */
  private realmStep(run: Run, step: PlanStep): QuestStep | undefined {
    return run.quest.steps.find((each) => each.block === step.block);
  }

  /**
   * Where the counter stands as the client can read it: the listing walked
   * forward by what this run and the player were watched doing. Minus
   * infinity where nothing has stated it, so no step is skipped on silence.
   */
  private rankNow(run: Run, state: CharacterState): number {
    const watched = this.planner.watched()[run.quest.id]?.to;
    const listing = state.abilities;
    const listed =
      listing === null ? null : (listing.sums[run.quest.id] ?? (listing.complete ? 0 : null));
    return Math.max(watched ?? -Infinity, listed ?? -Infinity);
  }

  // ---------------------------------------------------------------- gathering

  private gather(run: Run, step: PlanStep, item: PlanItem, state: CharacterState): void {
    const nth = run.at + 1;
    const name = item.name ?? `#${item.id}`;
    const source = item.source;
    switch (source.how) {
      case 'carried':
        this.refuse(t('automation.quests.refusalItemGone', { item: name, nth }));
        return;
      case 'earlier':
        this.refuse(t('automation.quests.refusalNotHandedOver', { item: name, rank: source.rank }));
        return;
      case 'unplaced':
        this.refuse(t('automation.quests.refusalItemUnplaced', { item: name }));
        return;
      case 'buy': {
        if (item.name === undefined) {
          this.refuse(t('automation.quests.refusalItemUnnamed', { id: item.id }));
          return;
        }
        const count = item.count ?? 1;
        const at = source.at === undefined ? null : asRoomReference(source.at.room);
        /*
         * `Supplies.fetch`'s row, addressed by room where the plan chose one
         * — the field the shopping errand resolves without going back through
         * `shopPlace`, which refuses a name standing in several rooms.
         */
        const row: SupplyItem = {
          name: item.name,
          min: count,
          max: count,
          shop: source.shops[0] ?? '',
          at: at === null ? null : { map: at.map, room: at.room }
        };
        /*
         * And a shopping errand that would not *start* is the same kind of
         * fact as one that came back empty: `Supplies.fetch` refuses for
         * another errand running, an escape in flight and the walker's own
         * `refusalMoveInFlight` — every one of them a moment.
         */
        const refused = this.planner.buy(row);
        if (refused !== null) {
          this.setback(t('automation.quests.refusalNotBought', { item: name, why: refused }));
          return;
        }
        run.phase = { kind: 'fetching', item, how: 'buy', since: this.now(), before: 0 };
        this.events.notice?.(
          t('automation.quests.buying', {
            nth,
            item: name,
            count,
            shop: row.shop,
            room: source.at?.place ?? source.at?.room ?? ''
          })
        );
        this.publish();
        return;
      }
      case 'kill': {
        if (item.name === undefined) {
          this.refuse(t('automation.quests.refusalItemUnnamed', { id: item.id }));
          return;
        }
        const refused = this.planner.hunt({ id: item.id, name: item.name });
        if (refused !== null) {
          this.setback(t('automation.quests.refusalNotHunted', { item: name, why: refused }));
          return;
        }
        run.phase = { kind: 'fetching', item, how: 'hunt', since: this.now(), before: 0 };
        this.events.notice?.(t('automation.quests.hunting', { nth, item: name, mob: source.mob }));
        this.publish();
        return;
      }
      case 'ask':
      case 'said': {
        if (source.at === undefined) {
          this.refuse(t('automation.quests.refusalItemUnplaced', { item: name }));
          return;
        }
        if (this.planner.here() !== source.at.room) {
          this.leg(source.at.room, 0);
          return;
        }
        const command =
          source.how === 'ask'
            ? source.say === undefined
              ? null
              : `ask ${this.spelledHere(state, source.who) ?? source.who} ${source.say}`
            : source.say;
        if (command === null) {
          this.refuse(t('automation.quests.refusalNoWords', { item: name }));
          return;
        }
        if (fightIsRunning(state) || this.planner.moveInFlight()) return;
        const pack = packCheck();
        run.phase = {
          kind: 'fetching',
          item,
          how: 'handover',
          since: this.now(),
          before: item.name === undefined ? 0 : carriedCount(state, item.name),
          pack
        };
        const asked = this.send(
          command,
          t('automation.quests.reasonHandover', { item: name }),
          () => void (pack.sentAt = this.now())
        );
        if (!asked) return;
        this.events.notice?.(t('automation.quests.handover', { nth, item: name, command }));
        this.publish();
        return;
      }
    }
  }

  /** A fetch in progress: has the pack got it yet, and is the errand still on it? */
  private fetching(
    run: Run,
    phase: Extract<Phase, { kind: 'fetching' }>,
    state: CharacterState
  ): void {
    const { item } = phase;
    const name = item.name ?? `#${item.id}`;
    /** This fetch is over: on to the step's next item, or to the step itself. */
    const gathered = (): void => {
      // The shopping errand gave the lap back when it finished; the run still
      // has the character, so the lap is held again until the run ends.
      if (this.heldLap) this.planner.hold();
      if (run.stock !== null && item === run.stock) run.stock = null;
      else run.item += 1;
      run.setbacks = 0;
      run.phase = { kind: 'deciding', since: this.now() };
      this.decide(state);
    };
    if (this.held(state, item) === true) {
      gathered();
      return;
    }
    switch (phase.how) {
      case 'buy':
        if (this.planner.buying()) return;
        /*
         * A stock row is the one thing in a plan the **quest** does not want,
         * so it gets one trip and no more. Its floor is what mattered — a
         * counter holding four torches when the list asked for six has done
         * the job — and a trip that fetched none is reported and walked away
         * from. Counting it against the run would spend six minutes walking
         * back to the same empty shelf and then end the quest for it.
         */
        if (item.stock !== undefined) {
          if (carriedCount(state, name) < item.stock) {
            this.events.notice?.(t('automation.quests.stockUnfilled', { item: name }));
          }
          gathered();
          return;
        }
        // The shopping errand has already said why in its own words.
        this.setback(
          t('automation.quests.refusalNotBought', {
            item: name,
            why: t('automation.quests.whyErrandEnded')
          })
        );
        return;
      case 'hunt':
        if (!this.planner.hunting())
          this.setback(t('automation.quests.refusalHuntStopped', { item: name }));
        return;
      case 'handover': {
        const { pack } = phase;
        if (pack.sentAt === null) {
          // The queue's own drop is the lapse, never a clock of the run's:
          // the player's half-typed line pushes every deadline back.
          if (!this.actQueued()) {
            this.setback(t('automation.quests.refusalHandoverUnsent', { item: name }));
          }
          return;
        }
        const read = this.packAfter(pack);
        if (read === 'read') {
          this.setback(t('automation.quests.refusalHandoverUnanswered', { item: name }));
        } else if (read === 'unanswered') {
          this.setback(t('automation.quests.refusalPackUnread'));
        }
        return;
      }
    }
  }

  /**
   * Whether the pack holds this row — null where nobody has listed it. By
   * name where the plan names one, since a supply is *how many*; by row
   * where it does not.
   */
  private held(state: CharacterState, item: PlanItem): boolean | null {
    const rows = packRows(state.inventory);
    if (rows === null) return null;
    if (item.name !== undefined) return carriedCount(state, item.name) >= (item.count ?? 1);
    return rows.includes(item.id);
  }

  // ---------------------------------------------------------------- walking

  /**
   * Plan and start a leg to `to` from wherever the character stands.
   *
   * **Nothing here ends a run.** Every one of these refusals is about this
   * moment rather than about the quest: an escape in flight, a router that
   * cannot place a character mid-step, a door shut, and above all a walker
   * that refuses while a move is unanswered — which is how a rest-next-door
   * step-back killed a run one second after it healed (2026-09-22). They
   * stand the run still and it tries again. See *a setback is not the end*.
   */
  private leg(to: RoomId, legs: number, spend = true): void {
    const run = this.run;
    if (run === null) return;
    if (this.planner.busy()) {
      this.setback(t('automation.quests.refusalEscaping'));
      return;
    }
    const route = this.planner.routeTo(to);
    if (typeof route === 'string') {
      this.setback(t('automation.quests.refusalNoRoute', { room: this.placeName(to), why: route }));
      return;
    }
    if (route.blocked) {
      this.setback(
        t('automation.quests.refusalNoRoute', {
          room: this.placeName(to),
          why: route.reason ?? t('automation.walk.refusalNoRoute')
        })
      );
      return;
    }
    if (route.steps.length === 0) {
      run.phase = { kind: 'deciding', since: this.now() };
      this.publish();
      return;
    }
    const refused = this.planner.walk(route);
    if (refused !== null) {
      this.setback(
        t('automation.quests.refusalNoRoute', { room: this.placeName(to), why: refused })
      );
      return;
    }
    run.phase = {
      kind: 'walking',
      to,
      legs: spend ? legs + 1 : legs,
      since: this.now(),
      at: this.planner.here()
    };
    if (legs === 0) {
      this.events.notice?.(
        t('automation.quests.going', {
          nth: run.at + 1,
          room: this.placeName(to),
          steps: route.steps.length
        })
      );
    }
    this.publish();
  }

  /** A room's name off the plan where the plan names it, else its address. */
  private placeName(room: RoomId): string {
    const run = this.run;
    if (run === null) return room;
    for (const step of run.plan.steps) {
      if (step.at?.room === room && step.at.place !== undefined) return step.at.place;
      for (const item of step.items) {
        const at = 'at' in item.source ? item.source.at : undefined;
        if (at?.room === room && at.place !== undefined) return at.place;
      }
    }
    return room;
  }

  // ---------------------------------------------------------------- acting

  /**
   * At the act's room. An ask and a say go out once the asker is here and
   * nothing is swinging; a kill is auto-combat's, told the name, and is done
   * when the book watches the death. Both waits are bounded.
   */
  private act(run: Run, phase: Extract<Phase, { kind: 'acting' }>, state: CharacterState): void {
    const step = run.plan.steps[run.at];
    if (step === undefined) return;
    const act = step.act;
    const realm = this.realmStep(run, step);
    if (act === null || realm === undefined) {
      this.refuse(t('automation.quests.refusalUntraced', { nth: run.at + 1 }));
      return;
    }
    const nth = run.at + 1;
    if (act.verb === 'kill') {
      this.planner.fightFor(act.mob);
      // The death runs the step; the book watches it (`stepKilled`), and the
      // counter is then read as for any other act.
      const watched = this.planner.watched()[run.quest.id]?.to;
      if (realm.to !== undefined && watched !== undefined && watched >= realm.to) {
        this.confirmFrom(run, state, this.now());
        return;
      }
      if (this.now() - phase.since <= tuning().quests.waitForMs) return;
      /*
       * **Standing in its room is bounded too, not only waiting for it to
       * arrive.** `alsoFight` never goes past a `never` row, a claim or the
       * ten evil points, so a boss the realm files good, or one a stranger
       * has claimed, is refused for ever — and the run used to stand there
       * as long as it was in the room, which is the reported failure in a
       * different phase.
       */
      const present = state.room.occupants.some(
        (who) => who.kind !== 'player' && nameAnswersTo(mobKey(who.name), mobKey(act.mob))
      );
      this.setback(
        present || fightIsRunning(state)
          ? t('automation.quests.refusalMobNotFought', { mob: act.mob, nth })
          : t('automation.quests.refusalMobNotHere', { mob: act.mob, nth })
      );
      return;
    }
    if (fightIsRunning(state) || this.planner.moveInFlight()) {
      // And the same clock over the ask, for the same reason the `deciding`
      // phase has one: a fight nothing ends, a move nothing answers.
      if (this.now() - phase.since > tuning().quests.waitForMs) {
        this.setback(t('automation.quests.whyNothingMoved'));
      }
      return;
    }
    let command: string;
    if (act.verb === 'ask') {
      const spelled = this.spelledHere(state, act.who);
      if (spelled === null) {
        if (this.now() - phase.since > tuning().quests.waitForMs) {
          this.setback(t('automation.quests.refusalAskerNotHere', { who: act.who, nth }));
        }
        return;
      }
      command = `ask ${spelled} ${act.say}`;
    } else {
      command = act.phrase;
    }
    const before = new Map<number, number>();
    for (const item of [
      ...realm.takes,
      ...realm.gives.flatMap((reward) => (reward.kind === 'item' ? [reward] : []))
    ]) {
      before.set(item.id, item.name === undefined ? 0 : carriedCount(state, item.name));
    }
    const pack = packCheck();
    run.phase = {
      kind: 'confirming',
      sentAt: this.now(),
      asked: null,
      askedTimes: 0,
      before,
      pack
    };
    const sent = this.send(
      command,
      t('automation.quests.reasonAct', { nth }),
      () => void (pack.sentAt = this.now())
    );
    if (!sent) return;
    this.events.notice?.(
      run.tries > 0
        ? t('automation.quests.askingAgain', {
            nth,
            command,
            tries: run.tries + 1,
            max: tuning().quests.rollTries
          })
        : t('automation.quests.asking', { nth, command })
    );
    this.publish();
  }

  /**
   * How the room lists somebody, or null while they are not in it. Answered
   * the way the server answers a typed name (`nameAnswersTo`): the plan says
   * `Tolgard` and the room lists `Master Trader Tolgard`, and what goes on
   * the wire is the room's own spelling.
   */
  private spelledHere(state: CharacterState, who: string): string | null {
    const wanted = mobKey(who);
    const found = state.room.occupants.find(
      (each) => each.kind !== 'player' && nameAnswersTo(mobKey(each.name), wanted)
    );
    return found?.name ?? null;
  }

  private send(command: string, reason: string, sent: () => void): boolean {
    const queued = this.queue.enqueue({
      command,
      priority: 'probe',
      coalesceKey: ACT_KEY,
      expiresAt: this.now() + tuning().quests.expiresMs,
      reason,
      onSent: () => {
        sent();
        this.planner.said(command);
      }
    });
    if (!queued) this.setback(t('automation.quests.refusalNotQueued', { command }));
    return queued;
  }

  // ---------------------------------------------------------------- confirming

  /** A kill the book watched: confirmed from the moment it was seen. */
  private confirmFrom(run: Run, state: CharacterState, sentAt: number): void {
    run.phase = {
      kind: 'confirming',
      sentAt,
      asked: null,
      askedTimes: 0,
      before: new Map(),
      pack: packCheck(sentAt)
    };
    this.publish();
    this.confirm(run, run.phase, state);
  }

  /**
   * Reading the outcome. On a realm that prints its counters the listing is
   * the whole answer: asked for after the act and after the script's own
   * delay, and read only where it is newer than both. Elsewhere the pack is
   * what moved, and a step that moves nothing readable is refused rather
   * than assumed.
   */
  private confirm(
    run: Run,
    phase: Extract<Phase, { kind: 'confirming' }>,
    state: CharacterState
  ): void {
    const step = run.plan.steps[run.at];
    const realm = step === undefined ? undefined : this.realmStep(run, step);
    if (step === undefined || realm === undefined || realm.to === undefined) {
      this.refuse(t('automation.quests.refusalUnknownStep', { block: step?.block ?? 0 }));
      return;
    }
    const nth = run.at + 1;
    const now = this.now();
    const delay = (realm.delaySeconds ?? 0) * 1000;
    if (this.planner.printsCounters()) {
      const listing = state.abilities;
      const fresh = listing !== null && listing.at >= phase.sentAt + delay;
      if (!fresh) {
        if (now < phase.sentAt + delay) return;
        if (phase.asked !== null && now - phase.asked < tuning().quests.replyMs) return;
        if (phase.askedTimes >= tuning().quests.listingAsks) {
          this.setback(t('automation.quests.refusalListingUnanswered', { nth }));
          return;
        }
        // A refused enqueue is *not now*, never *never* (todo 113): the
        // stat screen's hold drops what is queued, and three asks nobody
        // took would otherwise read as three the server ignored.
        if (
          !this.queue.enqueue({
            command: 'abil',
            priority: 'probe',
            coalesceKey: 'quests:abil',
            expiresAt: now + tuning().quests.expiresMs,
            reason: t('automation.quests.reasonAbil')
          })
        ) {
          return;
        }
        phase.asked = now;
        phase.askedTimes += 1;
        return;
      }
      const rank = listing.sums[run.quest.id] ?? (listing.complete ? 0 : null);
      if (rank !== null && rank >= realm.to) {
        this.stepDone(run, state, rank);
        return;
      }
      if (stepRoll(realm) !== null && run.tries + 1 < tuning().quests.rollTries) {
        run.tries += 1;
        run.phase = { kind: 'acting', since: now };
        this.publish();
        this.act(run, run.phase, state);
        return;
      }
      this.refuse(
        stepRoll(realm) === null
          ? t('automation.quests.refusalCounterUnmoved', { nth, rank: rank ?? '?', to: realm.to })
          : t('automation.quests.refusalRollFailed', { nth, tries: run.tries + 1 })
      );
      return;
    }
    /*
     * No `abil` on this realm. What moved is the pack: the item the step took
     * is gone, the item it gave has arrived. A step that takes and gives
     * nothing leaves no evidence at all, and a roll that leaves none cannot
     * be read — both are said, never assumed.
     */
    if (phase.before.size > 0) {
      if (phase.pack.sentAt === null) {
        // The act lapsed in the queue: nothing was asked, so nothing is read.
        if (!this.actQueued()) {
          this.setback(t('automation.quests.refusalNotQueued', { command: this.wordsOf(step) }));
        }
        return;
      }
      if (now < phase.sentAt + delay) return;
      const read = this.packAfter(phase.pack);
      if (read === 'unanswered') {
        this.setback(t('automation.quests.refusalPackUnread'));
        return;
      }
      let moved = false;
      for (const item of realm.takes) {
        const was = phase.before.get(item.id) ?? 0;
        if (item.name !== undefined && carriedCount(state, item.name) < was) moved = true;
      }
      for (const reward of realm.gives) {
        if (reward.kind !== 'item' || reward.name === undefined) continue;
        if (carriedCount(state, reward.name) > (phase.before.get(reward.id) ?? 0)) moved = true;
      }
      if (moved) {
        this.stepDone(run, state, realm.to);
        return;
      }
      if (read === 'read') this.refuse(t('automation.quests.refusalPackUnmoved', { nth }));
      return;
    }
    if (stepRoll(realm) !== null) {
      this.refuse(t('automation.quests.refusalRollUnreadable', { nth }));
      return;
    }
    const watched = this.planner.watched()[run.quest.id]?.to;
    if (watched !== undefined && watched >= realm.to) {
      this.events.notice?.(t('automation.quests.stepAssumed', { nth }));
      this.stepDone(run, state, realm.to);
      return;
    }
    if (now - phase.sentAt > tuning().quests.replyMs + delay) {
      this.refuse(t('automation.quests.refusalUnwatched', { nth }));
    }
  }

  /** The pack as the act left it — `packAfter`, asked through the run's own key. */
  private packAfter(pack: PackCheck): 'read' | 'waiting' | 'unanswered' {
    const now = this.now();
    return packAfter(pack, now, (onSent) =>
      this.queue.enqueue({
        command: AFTER_WORD,
        priority: 'probe',
        coalesceKey: AFTER_KEY,
        expiresAt: now + tuning().quests.expiresMs,
        reason: t('automation.quests.reasonPackAfter'),
        onSent
      })
    );
  }

  /**
   * A pack listing landed, answering the command the server echoed before it
   * (`SessionManager.answering`). Only the run's own spelling, sent after the
   * act, is the answer: an `i` somebody else sent before the act can land after
   * the run's ask went out, and it lists the pack as it was.
   */
  noteListing(answering: string | null): void {
    const phase = this.run?.phase;
    const pack =
      phase?.kind === 'confirming' || (phase?.kind === 'fetching' && phase.how === 'handover')
        ? phase.pack
        : null;
    answers(pack, answering);
  }

  /** Whether the act is still waiting in the queue to go out. */
  private actQueued(): boolean {
    return this.queue.queued((intent) => intent.coalesceKey === ACT_KEY);
  }

  private stepDone(run: Run, state: CharacterState, rank: number): void {
    const step = run.plan.steps[run.at];
    if (step?.act?.verb === 'kill') this.planner.stopFighting(step.act.mob);
    this.events.notice?.(
      t('automation.quests.stepDone', { nth: run.at + 1, quest: run.quest.name, rank })
    );
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: this.because(),
      acted: true
    });
    this.advance(run, state);
  }

  /** On to the next step of the plan, or the end of it. */
  private advance(run: Run, state: CharacterState): void {
    run.at += 1;
    run.item = 0;
    run.tries = 0;
    run.stock = null;
    run.setbacks = 0;
    run.phase = { kind: 'deciding', since: this.now() };
    this.publish();
    if (run.at >= run.plan.steps.length) {
      this.finish();
      return;
    }
    this.decide(state);
  }

  // ---------------------------------------------------------------- ending

  private finish(): void {
    const run = this.run;
    if (run === null) return;
    const to = run.quest.steps.find((step) => step.block === run.plan.block)?.to;
    this.end('done', t('automation.quests.finished', { quest: run.quest.name, to: to ?? '?' }));
  }

  /**
   * The thing the run was about to do could not be done **this moment**.
   *
   * A walker that refuses while a move is unanswered, an escape in flight, a
   * corridor busy with monsters, an asker who has wandered off: none of them
   * says anything about the quest, and every one of them used to end the run
   * outright. The run stands still, says so once, and tries the same thing
   * again; `setbacks` spent in a row with nothing achieved between them is
   * what finally gives up, and anything going right puts the count back to
   * zero. See `mudengine-automation` § *a setback is not the end of a run*.
   */
  private setback(why: string): void {
    const run = this.run;
    if (run === null) return;
    run.setbacks += 1;
    // Whatever the run proposed and has not sent is not sent now: nothing
    // would be watching for its answer.
    this.takeBack();
    const max = tuning().quests.setbacks;
    if (run.setbacks > max) {
      this.refuse(t('automation.quests.refusalGaveUp', { why, tries: max }));
      return;
    }
    run.phase = { kind: 'held', since: this.now(), why };
    this.events.notice?.(
      t('automation.quests.heldUp', {
        why,
        tries: run.setbacks,
        max,
        seconds: Math.round(tuning().quests.retryMs / 1000)
      })
    );
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: this.because(),
      acted: false,
      refused: why
    });
    this.publish();
  }

  private refuse(why: string): void {
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: this.because(),
      acted: false,
      refused: why
    });
    this.end('stopped', t('automation.quests.refused', { why }));
  }

  private refuseStart(why: string): string {
    this.events.notice?.(why);
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.quests.becausePressed'),
      acted: false,
      refused: why
    });
    return why;
  }

  private end(status: 'done' | 'stopped', reason: string): void {
    const run = this.run;
    if (run === null) return;
    this.run = null;
    this.settle(run, status, reason);
  }

  /**
   * Everything a run leaves behind, put back, and the ending said.
   *
   * The leg included: `stop` was the only ending that took the walker down
   * with it, so switching Auto-Quest off mid-leg used to leave the character
   * walking to a quest room with nothing running it. Safe to do here because
   * `this.run` is already null by the time settle is reached, which is what
   * `stop` arranges and why.
   */
  private settle(run: Run, status: 'done' | 'stopped', reason: string): void {
    this.takeBack();
    if (run.phase.kind === 'walking' && this.planner.walking()) this.planner.stopWalking(reason);
    const step = run.plan.steps[run.at];
    if (step?.act?.verb === 'kill') this.planner.stopFighting(step.act.mob);
    if (run.phase.kind === 'fetching') this.planner.abandonErrands(reason);
    this.planner.questing(false);
    this.planner.warding(false);
    if (this.heldLap) this.planner.release();
    this.heldLap = false;
    this.events.notice?.(reason);
    this.idle = { ...this.progressOf(run), status, phase: null, detail: null, reason };
    this.lastPublished = null;
    this.events.progress?.(this.idle);
  }

  private takeBack(): void {
    this.queue.cancel(
      (intent) => intent.coalesceKey === ACT_KEY || intent.coalesceKey === AFTER_KEY
    );
  }

  private because(): string {
    const run = this.run;
    if (run === null) return '';
    return t('automation.quests.because', { quest: run.quest.name, to: this.rankOf(run) ?? '?' });
  }

  /** The rank the run reaches: the quest step the plan was asked for. */
  private rankOf(run: Run): number | null {
    return run.quest.steps.find((step) => step.block === run.plan.block)?.to ?? null;
  }

  // ---------------------------------------------------------------- progress

  private publish(): void {
    const run = this.run;
    if (run === null) return;
    const progress = this.progressOf(run);
    const key = JSON.stringify(progress);
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    this.events.progress?.(progress);
  }

  private progressOf(run: Run): QuestRunProgress {
    return {
      status: 'running',
      block: run.plan.block,
      name: run.quest.name,
      to: this.rankOf(run),
      steps: run.plan.steps.map((step, index) => ({
        block: step.block,
        state: index < run.at ? 'done' : index === run.at ? 'now' : 'left',
        words: this.wordsOf(step)
      })),
      phase: this.phaseWord(run.phase),
      detail: this.detailOf(run),
      reason: null,
      tries: run.tries
    };
  }

  /** The step named by its act, in the words the plan rows use for it. */
  private wordsOf(step: PlanStep): string {
    const act = step.act;
    if (act === null) return `#${step.block}`;
    if (act.verb === 'kill') return t('cards.quests.step.kill', { who: act.mob });
    if (act.verb === 'ask') return t('cards.quests.step.ask', { who: act.who, word: act.say });
    return t('cards.quests.step.doHere', { word: act.phrase });
  }

  private phaseWord(phase: Phase): QuestRunPhase | null {
    switch (phase.kind) {
      case 'deciding':
        return null;
      case 'held':
        return 'held';
      case 'listing':
        return 'listing';
      case 'fetching':
        return 'fetching';
      case 'walking':
      case 'waiting':
        return 'walking';
      case 'acting':
        return 'acting';
      case 'confirming':
        return 'confirming';
    }
  }

  private detailOf(run: Run): string | null {
    const step = run.plan.steps[run.at];
    const phase = run.phase;
    switch (phase.kind) {
      case 'deciding':
      case 'listing':
        return null;
      case 'held':
        return phase.why;
      case 'fetching':
        return t('automation.quests.detailFetching', {
          item: phase.item.name ?? `#${phase.item.id}`
        });
      case 'walking':
      case 'waiting':
        return t('automation.quests.detailWalking', { room: this.placeName(phase.to) });
      case 'acting':
        return step?.act === null || step === undefined
          ? null
          : step.act.verb === 'kill'
            ? t('automation.quests.detailKilling', { mob: step.act.mob })
            : t('automation.quests.detailWaitingFor', {
                who: step.act.verb === 'ask' ? step.act.who : (step.at?.place ?? '')
              });
      case 'confirming':
        return t('automation.quests.detailConfirming');
    }
  }
}
