/**
 * The "what to do next" planner (todo 50): asks the provider for a plan when
 * something changed, and carries the answer out through the modules that
 * already do each thing.
 *
 * It never sends a command of its own. A goal is handed on: a hunt to
 * `AutoHunt` (steered to the chosen spot), a purchase to the shop trip
 * (`Supplies.fetch`, which withdraws a short purse from the bank), a level to
 * `TrainErrand`, which the plan's settings switch on. The one line it
 * proposes is the `wear` for an item it bought, and that goes to the command
 * queue like any other.
 *
 * Asked on a trigger, never on a timer: entering the realm, a level, a death,
 * a goal done or refused, cash crossing a step, cash reaching the cheapest
 * upgrade, a change in what is worn, the player's own button, and standing
 * still for `stuckMs`. Never during a fight, while another move is out, or
 * before the room, the `st` and the `i` have been read, nor while the
 * simulator is still running the lairs' fights; the trigger waits, and a brief
 * that cannot be built yet keeps it waiting rather than losing it.
 *
 * What each plan came to is kept as a lesson (`lessons.jsonl`) and sent back
 * with every brief while the character is near the level it was learned at.
 *
 * Every step is written to the running log (`RunLog`).
 */
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import type { Block } from '../../../shared/blocks';
import type { CharacterState } from '../../../shared/character';
import type { AutomationConfig } from '../../../shared/config';
import {
  cashStep,
  goalWrites,
  layered,
  layerWrites,
  levelReady,
  type KonamiGoal,
  type KonamiLayer,
  type KonamiPlan,
  type KonamiSaving,
  type KonamiProvider,
  type KonamiReply,
  type KonamiTrigger,
  type LayerWrite
} from '../../../shared/konami';
import type { KonamiBrief } from '../../../shared/konamiBrief';
import {
  goalKey,
  killedAt,
  lessonsFor,
  type KonamiLesson,
  type LessonOutcome
} from '../../../shared/konamiLessons';
import { nextUpgradePrice, trainNotCarried, upgradeToBuy } from '../../../shared/konamiPurse';
import { readPlan, samePlan } from '../../../shared/konamiQuestions';
import {
  fitRequest,
  onlyGoal,
  requestSizes,
  requestSubstance,
  type FittedRequest
} from '../../../shared/konamiWire';
import { withoutDeclined, type RoadFacts } from '../../../shared/konamiRoad';
import {
  decisionRow,
  type KonamiActivity,
  type KonamiDecision,
  type KonamiExchange,
  type KonamiIncidentKind,
  type KonamiIncidentRow,
  type KonamiRecords,
  type KonamiSnapshot
} from '../../../shared/konamiRecords';
import { bankedCopper } from '../../../shared/coins';
import { timeOfDay } from '../../../shared/values';
import { bareName, wornItems } from '../../../shared/items';
import { nameAnswersTo } from '../../../shared/world';
import type { SessionModule } from '../Module';
import { fightIsRunning } from '../Walker';
import { Blows } from './Blows';
import { History } from './History';
import { incidentFiles, killersOf } from './incident';
import { Journal } from './Journal';
import { lessonOf, markedBad } from './lesson';
import { RoadBook } from './RoadBook';
import { AskGate } from './AskGate';
import { askWithin, loadProvider, providerPaths } from './ProviderLoader';
import { RunLog, stateLine } from './RunLog';

/** What the planner reads. */
export interface PlannerFacts {
  state(): CharacterState;
  /** The brief for this moment, with the lessons that apply, or why there is none. */
  /** `inHand`: the ground the plan in hand hunts, kept on offer (todo 76). */
  brief(
    now: number,
    lessons: KonamiLesson[],
    inHand: string | null
  ): KonamiBrief | { refusal: string };
  /** What the road ahead is projected from, gathered beside a brief (todo 68). */
  road(brief: KonamiBrief): RoadFacts | null;
  /** Something else holds the character: an escape, a move out, a walk, a shop trip. */
  busy(): boolean;
  /** `AutoHunt` is walking to or running a spot. */
  hunting(): boolean;
  /** A shop trip is under way. */
  buying(): boolean;
  /** What `AutoHunt` last said it would not do for the steered spot, or null. */
  huntRefusal(): string | null;
  /** What the training trip last said it would not do, and when, or null. */
  trainRefusal(): { why: string; at: number } | null;
  /** What the modules last said they would not do, newest first. */
  refusals(): string[];
  realm(): string | null;
  /** What the module carrying the goal is doing now, for the card. */
  activity(): KonamiActivity | null;
}

/** What the planner does, each through the module that owns it. */
export interface PlannerHands {
  /** A spot key to hunt only there, null to hunt nowhere, undefined to let `AutoHunt` choose. */
  steerHunt(key: string | null | undefined): void;
  /** Starts the shop trip; the refusal, or null. */
  buy(goal: Extract<KonamiGoal, { kind: 'buy' }>): string | null;
  /** Proposes `wear` for an item in the pack. */
  wear(name: string): void;
  /** The plan's settings changed: the session configures again through `over`. */
  relayer(): void;
}

export interface PlannerEvents {
  changed(): void;
  notice(message: string): void;
}

/**
 * Triggers on a clock or a drift, asked only when what the ask would decide
 * has changed since the last plan (todo 66): the provider is paid per call.
 */
const UNCHANGED_SKIPS: ReadonlySet<KonamiTrigger> = new Set<KonamiTrigger>([
  'review',
  'stuck',
  'cash-step',
  'upgrade-affordable'
]);

/** A decision's id: its moment, and a little to tell two in one millisecond apart. */
function decisionId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** What is worn, as one word: a change is a new plan's worth. */
function wornMark(state: CharacterState): string {
  return wornItems(state.inventory.items)
    .map((item) => bareName(item.name))
    .sort()
    .join(',');
}

/**
 * What the character sheet still lacks before a plan can be made from it,
 * or null once the room, the `st` and the `i` have all been read.
 */
function unread(state: CharacterState): string | null {
  const missing: string[] = [];
  if (state.room.map === null || state.room.number === null) missing.push('the room');
  if (state.progress.level === null || state.vitals.hpMax === null) missing.push('the stats');
  if (state.inventory.wealth === null) missing.push('the inventory');
  return missing.length === 0 ? null : missing.join(', ');
}

/** Where a goal has got to. */
type GoalState = { kind: 'none' } | { kind: 'started' } | { kind: 'running' } | { kind: 'wearing' };

/** A fingerprint of what moves when the character is getting somewhere. */
function progressMark(state: CharacterState): string {
  const { vitals, room, progress, inventory } = state;
  return JSON.stringify([
    vitals.hp,
    vitals.mana,
    room.map,
    room.number,
    progress.exp,
    progress.level,
    inventory.wealth,
    inventory.items.length,
    state.inCombat
  ]);
}

export class KonamiPlanner implements SessionModule {
  private on = false;
  private paused = false;
  private providerPath = '';
  private provider: KonamiProvider | null = null;
  private loading = false;
  private refusal: string | null = null;
  private asking = false;
  private pending: KonamiTrigger | null = null;
  private plan: KonamiPlan | null = null;
  private goal: GoalState = { kind: 'none' };
  private readonly journal: Journal;
  private readonly log: RunLog;
  private worn: string | null = null;
  /** The brief's last refusal, said once until it changes. */
  private briefRefused: string | null = null;
  /** Not before this is a brief that refused built again. */
  private briefAgainAt = 0;
  /** When the provider is paid for an ask: not after a failure, nor twice over the same substance. */
  private readonly gate = new AskGate(() => {
    const { retryMs, retryMaxMs } = tuning().konami;
    return { retryMs, retryMaxMs };
  });
  /** When the review clock last ran out, asked or not. */
  private reviewedAt = 0;
  /** The copper carried that pays for the level ready, while it is not carried yet. */
  private trainAt: number | null = null;
  /** Since when a brief has come back with lairs still to simulate; null when none has. */
  private simulatingSince: number | null = null;
  /**
   * The lairs still unsimulated when the wait last ran out: not waited on
   * again until more than that are (the book started over for new figures).
   */
  private simulateGaveUpAt: number | null = null;
  /** What past plans came to, oldest first: read from the records once, added to as plans end. */
  private readonly lessons: KonamiLesson[];
  /** The road ahead, and what the player declined on it. */
  private readonly road: RoadBook;
  /** What the character did (`History`). */
  private readonly history: History;
  private huntSaid: string | null = null;
  /** What held the hunt when last said, so a wait is written once. */
  private waitSaid: string | null = null;
  private readonly blows = new Blows(() => tuning().konami.blowsKept);
  private readonly incidents: KonamiIncidentRow[] = [];
  private step: number | null = null;
  private upgradeAt: number | null = null;
  /** Whether a level was ready to train at the last state; null before the first. */
  private ready: boolean | null = null;
  private inRealm = false;
  private mark = '';
  private markedAt = Date.now();
  /** The stretch whose pay has been said to fall short, by its start, so it asks once (todo 78). */
  private saidUnderpaid: number | null = null;
  /** The saving whose copper has been said to be there, so it asks once. */
  private saidSaved: KonamiSaving | null = null;
  /** A stuck log has been written for this stretch of standing still. */
  private stuckLogged = false;
  private timer: NodeJS.Timeout | null = null;
  /** The character's own settings, as last handed to `over`. */
  private own: AutomationConfig | null = null;
  /**
   * Moves whenever what was asked stops mattering: a pause, a reset, the
   * switch off, disposal. A reply that comes back to a different generation
   * is dropped, since the character it was about is no longer the planner's.
   */
  private generation = 0;
  private disposed = false;
  /** `automation.enabled`, the master switch everything the plan hands a goal to obeys. */
  private master = true;

  constructor(
    private readonly facts: PlannerFacts,
    private readonly hands: PlannerHands,
    private readonly events: PlannerEvents,
    private readonly records: KonamiRecords | null,
    private readonly home: string | null
  ) {
    this.journal = new Journal(records, () => tuning().konami.journal);
    this.log = new RunLog(records);
    this.lessons = records?.lessons() ?? [];
    this.road = new RoadBook(records);
    this.history = new History(
      records,
      () => tuning().konami.historyShown,
      () => this.events.changed()
    );
  }

  /** Where this run's log is written, or null with no records. */
  get logPath(): string | null {
    return this.log.path;
  }

  /** What was sent and what came back for one decision still kept, or null. */
  exchange(id: string): KonamiExchange | null {
    const decision = this.journal.decisions.find((kept) => kept.id === id);
    if (decision === undefined) return null;
    return {
      request: decision.sent,
      raw: decision.raw,
      refusal: decision.refusal
    };
  }

  /**
   * Running: switched on, not paused, a provider in hand, and automation's
   * master switch on. With it off nothing the plan hands a goal to acts, so a
   * plan asked for then is a plan nothing walks.
   */
  get running(): boolean {
    return this.on && !this.paused && this.provider !== null && this.master;
  }

  configure(automation: AutomationConfig): void {
    if (automation.enabled !== this.master) {
      this.master = automation.enabled;
      this.log.say('switch', `automation ${this.master ? 'on' : 'off'}`);
      this.events.changed();
      if (this.master && this.on) this.trigger('asked');
    }
    const on = automation.superKonamiMode;
    const path = automation.konamiProviderPath;
    const pathChanged = path !== this.providerPath;
    this.providerPath = path;
    if (pathChanged) this.provider = null;
    if (on === this.on && !pathChanged) return;
    this.log.say('switch', `${on ? 'on' : 'off'}, provider ${path || '(the extensions folder)'}`);
    this.on = on;
    if (!on) {
      // Configuring now, through `over`, which is already taking the plan off.
      this.standDown(false);
      return;
    }
    void this.load();
  }

  /** The player's pause: the plan's settings come off and the character is the player's again. */
  togglePause(): boolean {
    this.paused = !this.paused;
    this.log.say(this.paused ? 'paused' : 'resumed', 'by the player');
    if (this.paused) this.standDown();
    else {
      // Resumed is not stuck: the clock starts from the press (todo 79).
      this.markedAt = Date.now();
      this.trigger('asked');
    }
    this.events.changed();
    return this.paused;
  }

  /**
   * The player pressed Stop on a walk or a lap: the character is to stay
   * put, so the planner pauses rather than taking the stop for a goal done
   * and planning the next walk a second later.
   */
  playerStopped(): void {
    if (!this.running) return;
    this.events.notice(t('automation.konami.pausedByStop'));
    this.togglePause();
  }

  /** The player's *ask again*. */
  askNow(): void {
    this.log.say('button', 'the player asked again');
    this.trigger('asked');
  }

  /**
   * The settings the session runs on: the character's own, with the plan's
   * laid over them while the planner runs.
   */
  over(own: AutomationConfig): AutomationConfig {
    this.own = own;
    // The switch as this reload states it: turned off, the plan comes off in the same reload.
    const plan = own.superKonamiMode && this.running ? this.plan : null;
    return plan === null ? own : layered(own, plan.layer, plan.goal.kind);
  }

  /** The plan's settings as writes into the character's file, for *keep these*. */
  keep(): LayerWrite[] | null {
    const layer: KonamiLayer | undefined = this.plan?.layer;
    return layer === undefined || this.own === null ? null : layerWrites(this.own, layer);
  }

  onBlock(block: Block): void {
    this.blows.onBlock(block);
    if (!this.running) return;
    switch (block.type) {
      case 'user-dies':
        this.log.say('died', stateLine(this.facts.state()));
        this.noteDeath();
        this.incident('death');
        this.settle('died', t('automation.konami.died'));
        this.hands.steerHunt(null);
        this.trigger('death');
        return;
      case 'user-levels':
        this.log.say('level', stateLine(this.facts.state()));
        this.trigger('level');
        return;
      case 'user-trains':
        this.log.say('trained', stateLine(this.facts.state()));
        if (this.plan?.goal.kind === 'train') this.settle('done', null);
        this.trigger('trained');
        return;
      default:
        return;
    }
  }

  onCharacter(state: CharacterState): void {
    const inRealm = state.phase === 'in-game';
    if (inRealm && !this.inRealm) {
      this.log.say('entered', 'the realm');
      this.trigger('entered');
    }
    if (!inRealm && this.inRealm) this.log.say('left', 'the realm');
    this.inRealm = inRealm;
    this.history.watch(state, this.running, this.facts.activity());
    if (!this.running || !inRealm) return;
    this.watchWorn(state);
    this.watchHunt();
    const mark = progressMark(state);
    if (mark !== this.mark) {
      this.mark = mark;
      this.markedAt = Date.now();
      this.stuckLogged = false;
    }
    this.watchCash(state);
    this.watchReady(state);
    this.watchGoal(state);
    this.consider(state);
  }

  reset(): void {
    this.generation += 1;
    this.pending = null;
    this.goal = { kind: 'none' };
    this.inRealm = false;
    this.step = null;
    this.upgradeAt = null;
    this.trainAt = null;
    this.ready = null;
    this.worn = null;
    this.briefRefused = null;
    this.briefAgainAt = 0;
    this.gate.reset();
    this.reviewedAt = 0;
    this.simulatingSince = null;
    this.simulateGaveUpAt = null;
    this.huntSaid = null;
    this.blows.reset();
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.disarm();
  }

  snapshot(): KonamiSnapshot {
    const state = this.facts.state();
    const level = state.progress.level;
    const { lessonLevels, lessonsSent, lessonsShown, deathLevels } = tuning().konami;
    const sent = new Set(lessonsFor(this.lessons, level, lessonLevels, lessonsSent, deathLevels));
    const latest = this.journal.latest;
    const since =
      latest?.outcome === 'applied' && latest.plan !== null ? latest.brief.character.exp : null;
    return {
      on: this.on,
      paused: this.paused,
      provider: this.provider?.name ?? null,
      asking: this.asking,
      pending: this.pending,
      automation: this.master,
      refusal: this.refusal,
      plan: this.plan,
      decisions: [...this.journal.decisions].reverse().map(decisionRow),
      incidents: [...this.incidents].reverse(),
      log: this.log.path,
      expSince: since === null || state.progress.exp === null ? null : state.progress.exp - since,
      activity: this.running && this.plan !== null ? this.facts.activity() : null,
      history: this.history.newestFirst(),
      road: this.road.view(state, tuning().konami.roadSteps),
      lessons: this.lessons
        .slice(-lessonsShown)
        .reverse()
        .map((lesson) => ({ ...lesson, applies: sent.has(lesson) })),
      lessonsKept: this.lessons.length,
      level,
      lessonLevels
    };
  }

  /**
   * The player's *not this*: the plan in force is turned down, remembered as
   * a lesson so it is not offered back at this level, and a new one asked for.
   */
  veto(): void {
    this.turnDown(t('automation.konami.vetoed'), true);
  }

  /**
   * The plan in force dropped and a new one asked for: settled as turned down,
   * with a lesson only where the player meant the provider to be told.
   */
  private turnDown(why: string, learn: boolean): void {
    const plan = this.plan;
    if (plan === null || plan.goal.kind === 'wait' || !this.running) return;
    this.log.say('vetoed', `by the player · ${stateLine(this.facts.state())}`);
    this.goal = { kind: 'none' };
    this.hands.steerHunt(null);
    this.settle('vetoed', why, learn);
    // Its settings come off with it; the next plan lays its own.
    this.plan = null;
    this.hands.relayer();
    this.trigger('vetoed');
  }

  /**
   * The player's *go here instead*: one of the goals the last answer gave
   * odds to, in place of the one it chose. The answer's pick is remembered as
   * turned down, and the player's is a decision of its own, asked with the
   * same brief.
   */
  choose(key: string): void {
    const latest = this.journal.latest;
    const plan = latest?.outcome === 'applied' ? latest.plan : null;
    if (latest === null || plan === null || !this.running) return;
    const option = plan.options.find((each) => goalKey(each.goal) === key);
    if (option === undefined || goalKey(option.goal) === goalKey(plan.goal)) return;
    this.log.say(
      'chosen',
      `by the player: ${goalNotice(option.goal)}, not ${goalNotice(plan.goal)}`
    );
    this.settle('vetoed', t('automation.konami.chose', { goal: goalNotice(option.goal) }));
    const now = Date.now();
    // The goal's pick carries the odds of what was chosen, not of what was turned down.
    const chosen: KonamiPlan = {
      ...plan,
      goal: option.goal,
      picks: plan.picks.map((pick) =>
        pick.question === 'goal' ? { ...pick, label: key, p: option.p } : pick
      )
    };
    this.journal.add({
      ...latest,
      id: decisionId(now),
      at: now,
      trigger: 'chosen',
      plan: chosen,
      outcome: 'applied',
      outcomeWhy: null,
      settledAt: null,
      goalSince: { at: now, exp: this.facts.state().progress.exp }
    });
    this.apply(chosen);
  }

  /**
   * The player's no to a goal on the road (todo 68), by its key: it is left off
   * the road and never offered to the provider again. Marked bad, it is also a
   * lesson sent near the level the road would have reached it. The goal in
   * hand is turned down as *not this* is, and a new plan asked for.
   */
  decline(key: string, bad: boolean): void {
    const state = this.facts.state();
    const found = this.road.find(key, state, tuning().konami.roadSteps);
    const current = this.plan !== null && goalKey(this.plan.goal) === key ? this.plan.goal : null;
    const goal = found?.goal ?? current;
    if (goal === null || (goal.kind !== 'hunt' && goal.kind !== 'buy')) return;
    const level = found?.level ?? state.progress.level;
    if (!this.road.mark(goal, bad, level, Date.now())) return;
    this.log.say(bad ? 'marked' : 'declined', `by the player: ${goalNotice(goal)}`);
    const why = t('automation.konami.markedBad');
    if (current !== null) {
      // Declined, it is only dropped; marked bad, the provider is told as well.
      this.turnDown(bad ? why : t('automation.konami.vetoed'), bad);
      this.events.changed();
      return;
    }
    if (bad) {
      const lesson = markedBad({
        goal,
        level,
        state,
        attack: this.own?.combat.attack ?? null,
        why,
        now: Date.now()
      });
      this.lessons.push(lesson);
      this.records?.lesson(lesson);
    }
    this.events.changed();
  }

  /** The player takes a no back: the goal may be on the road and offered again. */
  restore(key: string): void {
    const gone = this.road.restore(key);
    if (gone === null) return;
    this.log.say('restored', `by the player: ${goalNotice(gone.goal)}`);
    this.events.changed();
  }

  /** The player's *forget*: the lesson learned at `at` is no longer kept or sent. */
  forget(at: number): void {
    const index = this.lessons.findIndex((lesson) => lesson.at === at);
    if (index < 0) return;
    const [gone] = this.lessons.splice(index, 1);
    this.records?.rewriteLessons(this.lessons);
    this.log.block('forgot', 'by the player', gone);
    this.events.changed();
  }

  /** Where the card may open: this run's log, or an incident's folder, by its moment. */
  revealable(at: number | null): { path: string; kind: 'file' | 'directory' } | null {
    if (at === null) return this.log.path === null ? null : { path: this.log.path, kind: 'file' };
    const incident = this.incidents.find((each) => each.at === at);
    return incident === undefined || incident.path === null
      ? null
      : { path: incident.path, kind: 'directory' };
  }

  private async load(): Promise<void> {
    if (this.loading || this.provider !== null) return;
    this.loading = true;
    try {
      const loaded = await loadProvider(providerPaths(this.providerPath, this.home));
      // Switched off or put away while the file loaded: nothing to arm.
      if (this.disposed || !this.on) return;
      if ('refusal' in loaded) {
        this.log.say('provider', `not loaded: ${loaded.refusal}`);
        this.refusal = loaded.refusal;
        this.events.notice(loaded.refusal);
        return;
      }
      this.provider = loaded.provider;
      this.log.say('provider', `loaded ${loaded.provider.name}`);
      this.refusal = null;
      this.events.notice(t('automation.konami.loaded', { provider: loaded.provider.name }));
      this.arm();
      // Already in the realm when it loaded: the edge `onCharacter` asks on has passed.
      if (!this.paused && this.inRealm) this.trigger('entered');
    } finally {
      this.loading = false;
      this.events.changed();
    }
  }

  /**
   * One owned interval (`tuning.konami.tickMs`, never under five seconds, as an
   * event's): the stuck clock, and a waiting trigger once the character is free.
   */
  private arm(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), tuning().konami.tickMs);
  }

  private disarm(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (!this.running || !this.inRealm) return;
    const state = this.facts.state();
    // Asked again on a clock while a plan runs, so a goal that goes on working is still reviewed.
    const latest = this.journal.latest;
    const review = tuning().konami.reviewMs;
    if (latest?.outcome === 'applied' && this.pending === null && !this.asking && review > 0) {
      if (Date.now() - Math.max(latest.at, this.reviewedAt) >= review) {
        this.reviewedAt = Date.now();
        this.log.say('review', `the plan has run ${Math.round(review / 60_000)} minutes`);
        this.trigger('review');
      }
    }
    // A hunt lap standing at a stop waits for respawns, and a lap the hunt waits on is still
    // moving the character; the review clock reconsiders either.
    const activity = this.facts.activity();
    const camping =
      (activity?.doing.kind === 'hunt' && !activity.doing.walking && activity.walk === null) ||
      (activity?.doing.kind === 'waiting' && activity.doing.on === 'lap');
    this.watchPay(state);
    if (this.plan !== null && !fightIsRunning(state) && !camping) {
      if (Date.now() - this.markedAt >= tuning().konami.stuckMs && this.pending === null) {
        // Measured again from now, so a plan that changes nothing is not asked every tick.
        this.log.say('stuck', `nothing moved for ${Math.round(tuning().konami.stuckMs / 1000)}s`);
        this.markedAt = Date.now();
        this.trigger('stuck');
      }
    }
    this.consider(state);
  }

  private standDown(relayer = true): void {
    this.generation += 1;
    if (!this.on) this.disarm();
    this.pending = null;
    this.goal = { kind: 'none' };
    this.gate.reset();
    this.reviewedAt = 0;
    this.hands.steerHunt(undefined);
    if (relayer) this.hands.relayer();
  }

  private trigger(why: KonamiTrigger): void {
    if (!this.running) {
      this.log.say('trigger', `${why}, not asked: ${this.idleWhy()}`);
      return;
    }
    // A failed ask's back-off is waited out by a retry, not by the player's own ask or a death.
    if (why === 'asked' || why === 'death') this.gate.release();
    // Something happened: the brief is built again at once, so a choice with one option is
    // made now rather than behind a held ask.
    if (!UNCHANGED_SKIPS.has(why)) this.briefAgainAt = 0;
    // A death outranks whatever was waiting: its log is written and its plan is what matters.
    if (this.pending === null || why === 'death') {
      this.log.say('trigger', why);
      this.pending = why;
    } else {
      this.log.say('trigger', `${why}, folded into the ${this.pending} already waiting`);
    }
    this.events.changed();
    this.consider(this.facts.state());
  }

  /**
   * A level has become ready to train: experience counts `expNeeded` down to
   * nothing as it comes in, and nothing the realm prints says so, so no other
   * trigger would ask. Unread is not an answer, and changes nothing.
   */
  private watchReady(state: CharacterState): void {
    const ready = levelReady(state.progress);
    if (ready === null) return;
    if (ready && this.ready === false) {
      this.log.say('ready', `a level to train · ${stateLine(state)}`);
      this.trigger('ready');
    }
    this.ready = ready;
  }

  /**
   * A hunt paying far under what it was chosen on (todo 78): its measured rate
   * where the brief had one, else the estimate. Over `underMinutes` of the
   * stretch, under `underShare` of it, a new plan is asked for, once.
   */
  private watchPay(state: CharacterState): void {
    const latest = this.journal.latest;
    const goal = latest?.plan?.goal;
    if (latest === null || goal?.kind !== 'hunt' || this.goal.kind !== 'running') return;
    const since = latest.goalSince;
    if (this.saidUnderpaid === since.at || since.exp === null || state.progress.exp === null)
      return;
    const { underShare, underMinutes } = tuning().konami;
    const minutes = (Date.now() - since.at) / 60_000;
    if (minutes < underMinutes) return;
    const spot = latest.brief.hunting.spots.find((each) => each.key === goal.key);
    const expected = spot?.exp.measured?.perHour ?? spot?.exp.perHour ?? null;
    if (expected === null || expected <= 0) return;
    const paid = ((state.progress.exp - since.exp) * 60) / minutes;
    if (paid >= expected * underShare) return;
    this.saidUnderpaid = since.at;
    this.log.say(
      'underpaid',
      `${Math.round(paid)} an hour at ${goal.name}, chosen at ${Math.round(expected)}`
    );
    this.trigger('underpaid');
  }

  private watchCash(state: CharacterState): void {
    const onHand = state.inventory.wealth;
    const total = onHand === null ? null : onHand + bankedCopper(state.banks);
    const step = cashStep(total);
    if (step !== null && this.step !== null && step > this.step) {
      this.log.say('cash', `${total ?? '?'} copper in all, a step up`);
      this.trigger('cash-step');
    }
    if (step !== null) this.step = step;
    // The copper a plan saves for is there: carried where the trainer wants it on hand.
    const saving = this.plan?.saving ?? null;
    if (saving !== null && saving !== this.saidSaved) {
      const have = saving.carried ? onHand : total;
      if (have !== null && have >= saving.copper) {
        this.saidSaved = saving;
        this.log.say(
          'cash',
          `${have} copper reaches the ${saving.copper} saved for ${saving.what}`
        );
        this.trigger('saved');
      }
    }
    if (this.trainAt !== null && onHand !== null && onHand >= this.trainAt) {
      this.log.say('cash', `${onHand} copper carried pays the ${this.trainAt} training costs`);
      this.trainAt = null;
      this.trigger('train-affordable');
    }
    if (this.upgradeAt !== null && total !== null && total >= this.upgradeAt) {
      this.log.say('cash', `${total} copper reaches the ${this.upgradeAt} the next upgrade costs`);
      this.upgradeAt = null;
      this.trigger('upgrade-affordable');
    }
  }

  /** Where the goal in hand has got to, and whether it is over. */
  private watchGoal(state: CharacterState): void {
    const goal = this.plan?.goal;
    if (goal === undefined || this.goal.kind === 'none') return;
    switch (goal.kind) {
      case 'hunt': {
        if (this.facts.hunting()) {
          if (this.goal.kind !== 'running') this.log.say('goal', `hunting ${goal.name}`);
          this.goal = { kind: 'running' };
          return;
        }
        if (this.facts.busy()) return;
        const refused = this.facts.huntRefusal();
        if (this.goal.kind === 'started' && refused !== null) this.finish('refused', refused);
        else if (this.goal.kind === 'running') this.finish('done', null);
        return;
      }
      case 'buy': {
        const wanted = bareName(goal.name);
        const held = state.inventory.items.find((item) =>
          nameAnswersTo(bareName(item.name), wanted)
        );
        if (held?.equipped === true) {
          this.finish('done', null);
          return;
        }
        if (held !== undefined && this.goal.kind !== 'wearing') {
          this.log.say('goal', `bought ${goal.name}, wearing it`);
          this.goal = { kind: 'wearing' };
          this.hands.wear(goal.name);
          return;
        }
        if (this.facts.buying()) {
          if (this.goal.kind !== 'running') this.log.say('goal', `on the way to buy ${goal.name}`);
          this.goal = { kind: 'running' };
        } else if (this.goal.kind === 'running' && held === undefined) {
          this.finish('refused', t('automation.konami.notBought', { item: goal.name }));
        }
        return;
      }
      case 'train': {
        if (state.progress.expNeeded !== null && state.progress.expNeeded > 0) {
          this.finish('done', null);
          return;
        }
        // The trip would not go (no cash, no trainer reached) since training was the goal: it ends
        // refused. One said before is about a trip that is not this one.
        const refused = this.facts.trainRefusal();
        const since = this.journal.latest?.goalSince.at ?? 0;
        if (refused !== null && refused.at >= since) {
          this.finish('refused', refused.why);
          return;
        }
        // And a trip that never set off, whatever it said before or did not say at all.
        const going = this.facts.activity()?.doing.kind === 'train';
        if (!going && Date.now() - since >= tuning().konami.trainStartMs) {
          this.finish('refused', refused?.why ?? t('automation.konami.trainDidNotGo'));
        }
        return;
      }
      case 'wait':
        return;
      default: {
        const never: never = goal;
        return never;
      }
    }
  }

  private finish(outcome: 'done' | 'refused', why: string | null): void {
    const goal = this.plan?.goal;
    if (outcome === 'done' && goal?.kind === 'buy') {
      this.history.bought(goal);
    }
    this.log.say(
      'goal',
      `${outcome}${why === null ? '' : `: ${why}`} · ${stateLine(this.facts.state())}`
    );
    this.goal = { kind: 'none' };
    this.settle(outcome, why);
    this.trigger(outcome === 'done' ? 'goal-done' : 'goal-refused');
  }

  /**
   * What became of the plan in hand: the journal's outcome, and the lesson it
   * leaves under the same word.
   */
  private settle(outcome: LessonOutcome, why: string | null, learn = true): void {
    const decision = this.journal.latest;
    if (learn && decision?.outcome === 'applied') this.learn(decision, outcome, why);
    this.journal.settle(outcome, why);
    this.events.changed();
  }

  private learn(decision: KonamiDecision, outcome: LessonOutcome, why: string | null): void {
    const now = Date.now();
    const lesson = lessonOf({
      decision,
      outcome,
      why,
      state: this.facts.state(),
      blows: this.blows.since(now - tuning().konami.blowWindowMs),
      fightGapMs: tuning().konami.fightGapMs,
      lessonMinMs: tuning().konami.lessonMinMs,
      now
    });
    if (lesson === null) return;
    this.lessons.push(lesson);
    this.records?.lesson(lesson);
    this.log.block('learned', lesson.outcome, lesson);
  }

  /** A death, with who landed the blows of the last fight and where. */
  private noteDeath(): void {
    const { blowWindowMs, fightGapMs } = tuning().konami;
    const killers = killersOf(this.blows.since(Date.now() - blowWindowMs), fightGapMs);
    this.history.died(this.facts.state().room.name, killers);
  }

  /** Asks now if a trigger is waiting and the character is free. */
  private consider(state: CharacterState): void {
    const why = this.pending;
    if (why === null || this.asking || !this.running || state.phase !== 'in-game') return;
    if (fightIsRunning(state)) {
      this.log.wait(`${why}: a fight is on`);
      return;
    }
    if (this.facts.busy()) {
      this.log.wait(`${why}: the character is walking, running or on a shop trip`);
      return;
    }
    const missing = unread(state);
    if (missing !== null) {
      this.log.wait(`${why}: ${missing} not read yet`);
      return;
    }
    if (Date.now() < this.briefAgainAt) return;
    this.pending = null;
    void this.ask(why);
  }

  private async ask(why: KonamiTrigger): Promise<void> {
    const provider = this.provider;
    if (provider === null) return;
    const now = Date.now();
    const level = this.facts.state().progress.level;
    const {
      lessonLevels,
      lessonsSent,
      maxSpots,
      upgradesPerSlot,
      requestChars,
      trimGrounds,
      trimOffers,
      trimLessons,
      beforeNamed,
      savingGear,
      trainRetryMs,
      buyRetryMs,
      deathLevels
    } = tuning().konami;
    const goal = this.plan?.goal;
    const inHand = goal?.kind === 'hunt' ? goal.key : null;
    const sending = lessonsFor(this.lessons, level, lessonLevels, lessonsSent, deathLevels);
    const full = this.facts.brief(now, sending, inHand);
    if ('refusal' in full) {
      // Kept waiting and tried again after a tick, so entering the realm is never lost.
      if (this.pending === null) this.pending = why;
      this.briefAgainAt = Date.now() + tuning().konami.tickMs;
      this.log.wait(`${why}: no brief yet: ${full.refusal}`);
      if (full.refusal !== this.briefRefused) {
        this.briefRefused = full.refusal;
        this.refusal = full.refusal;
        this.events.notice(t('automation.konami.noBrief', { why: full.refusal }));
      }
      this.events.changed();
      return;
    }
    this.briefRefused = null;
    if (this.stillSimulating(why, full, now)) return;
    // Never offered: what the player said no to, and the grounds that killed it lately (todo 76).
    const shut = new Set([...this.road.declined, ...killedAt(this.lessons, level, deathLevels)]);
    const open = withoutDeclined(full, shut);
    this.road.learn(this.facts.road(open));
    const fitted = fitRequest(
      open,
      requestSizes({
        maxSpots,
        upgradesPerSlot,
        lessonsSent,
        requestChars,
        trimGrounds,
        trimOffers,
        trimLessons,
        beforeNamed,
        savingGear,
        trainRetryMs
      })
    );
    const brief = fitted.brief;
    this.upgradeAt = nextUpgradePrice(brief);
    this.trainAt = trainNotCarried(brief);
    const substance = requestSubstance(fitted);
    // Nothing to decide has changed since the last plan: not paid for again (todo 66).
    if (UNCHANGED_SKIPS.has(why) && this.plan !== null && this.gate.unchanged(substance)) {
      this.log.say('not asked', `${why}: nothing to decide has changed since the last ask`);
      // Standing still with nothing new to decide is what the stuck log is for.
      if (why === 'stuck' && !this.stuckLogged) {
        this.stuckLogged = true;
        this.incident('stuck');
      }
      this.events.changed();
      return;
    }
    // A level that is ready and paid for, then gear the purse covers: neither is asked (todos 66, 77).
    const only = onlyGoal(fitted) ?? upgradeToBuy(open, buyRetryMs, this.plan?.saving ?? null);
    if (only !== null) {
      this.gate.planned(substance);
      this.decideHere(why, fitted, only, now);
      return;
    }
    // Only a call to the provider waits out a failure before it.
    const heldUntil = this.gate.heldUntil(Date.now());
    if (heldUntil !== null) {
      this.pending ??= why;
      this.briefAgainAt = heldUntil;
      this.log.wait(`${why}: the last ask failed; asking again at ${timeOfDay(heldUntil)}`);
      this.events.changed();
      return;
    }
    this.asking = true;
    this.events.changed();
    const asked = fitted.asked;
    const generation = this.generation;
    this.log.say('asking', `${provider.name} for ${why} · ${stateLine(this.facts.state())}`);
    this.log.block(
      'sent',
      `${Object.keys(asked.questions).length} questions, ${fitted.chars} characters` +
        (fitted.over ? ` (over the budget at the smallest trim)` : ''),
      fitted.sent
    );
    const answer = await askWithin(provider, fitted.sent, tuning().konami.askTimeoutMs);
    this.asking = false;
    const took = `${((Date.now() - now) / 1000).toFixed(1)}s`;
    if ('refusal' in answer) this.log.say('failed', `after ${took}: ${answer.refusal}`);
    else this.log.block('received', `after ${took} from ${answer.reply.model}`, answer.raw);
    if (generation !== this.generation || !this.running) {
      this.log.say('dropped', 'the reply: paused, switched off or reset while it was asked');
      this.events.changed();
      return;
    }
    const plan = 'refusal' in answer ? null : readPlan(answer.reply, asked);
    if (plan === null) {
      this.failed(why, fitted, 'refusal' in answer ? answer.refusal : null, provider.name, now);
      return;
    }
    this.gate.planned(substance);
    const previous = this.plan;
    this.record(why, fitted, plan, provider.name, 'refusal' in answer ? null : answer, now);
    this.refusal = null;
    if (why === 'stuck' && previous !== null && samePlan(previous, plan) && !this.stuckLogged) {
      this.stuckLogged = true;
      this.incident('stuck');
    }
    this.apply(plan);
  }

  /**
   * One goal offered is no question: the level that is ready is trained, and
   * the settings the plan in hand laid stay. Recorded as a decision with
   * nothing sent, so the card shows why the plan changed and that it cost nothing.
   */
  private decideHere(
    why: KonamiTrigger,
    fitted: FittedRequest,
    goal: KonamiGoal,
    now: number
  ): void {
    // A saving stands until its own item is the thing bought (todo 77).
    const saving = this.plan?.saving ?? null;
    const plan: KonamiPlan = {
      goal,
      layer: this.plan?.layer ?? {},
      picks: [],
      options: [{ goal, p: 1 }],
      saving: goal.kind === 'buy' && saving?.item === goal.item ? null : saving
    };
    this.log.say('decided', `${goalNotice(goal)}: decided here, so nothing was asked`);
    this.record(why, fitted, plan, this.provider?.name ?? '', null, now);
    this.refusal = null;
    this.apply(plan);
  }

  /** The decision journalled, the plan before it settled as replaced unless it continues. */
  private record(
    why: KonamiTrigger,
    fitted: FittedRequest,
    plan: KonamiPlan,
    provider: string,
    reply: { reply: KonamiReply; raw: unknown } | null,
    now: number
  ): void {
    const latest = this.journal.latest;
    const continues =
      latest?.outcome === 'applied' &&
      latest.plan !== null &&
      goalKey(latest.plan.goal) === goalKey(plan.goal);
    const decision: KonamiDecision = {
      id: decisionId(now),
      at: now,
      trigger: why,
      provider,
      model: reply?.reply.model ?? null,
      brief: fitted.brief,
      sent: reply === null ? null : fitted.sent,
      raw: reply?.raw ?? null,
      plan,
      refusal: null,
      outcome: 'applied',
      outcomeWhy: null,
      settledAt: null,
      goalSince: continues ? latest.goalSince : { at: now, exp: fitted.brief.character.exp }
    };
    // The same goal back is the same stretch: learned from when it ends, not now.
    this.settle('replaced', null, !continues);
    this.journal.add(decision);
  }

  /**
   * An ask that made no plan: listed, but the plan in hand runs on, unsettled,
   * and the same trigger is asked again after a back-off that doubles with each
   * failure in a row (`retryMs` up to `retryMaxMs`).
   */
  private failed(
    why: KonamiTrigger,
    fitted: FittedRequest,
    refusal: string | null,
    provider: string,
    now: number
  ): void {
    const againAt = this.gate.failed(Date.now());
    this.pending ??= why;
    this.briefAgainAt = againAt;
    this.journal.add({
      id: decisionId(now),
      at: now,
      trigger: why,
      provider,
      model: null,
      brief: fitted.brief,
      sent: fitted.sent,
      raw: null,
      plan: null,
      refusal,
      outcome: 'failed',
      outcomeWhy: null,
      settledAt: null,
      goalSince: { at: now, exp: fitted.brief.character.exp }
    });
    this.log.say('retry', `${why} again at ${timeOfDay(againAt)}; the plan in hand runs on`);
    this.refusal = refusal;
    this.events.notice(refusal ?? '');
    this.events.changed();
  }

  private apply(plan: KonamiPlan): void {
    this.plan = plan;
    this.log.say(
      'plan',
      `${goalNotice(plan.goal)} · ${plan.picks.map((pick) => `${pick.question}=${pick.label} (${Math.round(pick.p * 100)}%)`).join(', ')}`
    );
    if (this.own !== null) {
      this.log.settings(this.own, [
        ...layerWrites(this.own, plan.layer),
        ...goalWrites(plan.goal.kind)
      ]);
    }
    this.hands.relayer();
    const goal = plan.goal;
    this.goal = { kind: 'started' };
    switch (goal.kind) {
      case 'hunt':
        this.log.say('handed', `hunt of ${goal.key} to the Hunting grounds`);
        this.hands.steerHunt(goal.key);
        break;
      case 'buy': {
        this.hands.steerHunt(null);
        this.log.say(
          'handed',
          `buying ${goal.name} at ${goal.shop} (${goal.at.map}/${goal.at.room}) to the shop trip`
        );
        const refused = this.hands.buy(goal);
        if (refused !== null) this.finish('refused', refused);
        break;
      }
      case 'train':
      case 'wait':
        this.hands.steerHunt(null);
        break;
      default: {
        const never: never = goal;
        return never;
      }
    }
    this.events.notice(goalNotice(goal));
    this.events.changed();
  }

  /**
   * Whether to hold the ask while the simulator runs the lairs' fights: a
   * brief built before then leaves every lair out and offers what little is
   * left. Held for `simulateWaitMs` at most, then asked with what there is.
   */
  private stillSimulating(why: KonamiTrigger, brief: KonamiBrief, now: number): boolean {
    const left = brief.hunting.excluded.unsimulated;
    if (this.simulateGaveUpAt !== null && left <= this.simulateGaveUpAt) return false;
    this.simulateGaveUpAt = null;
    if (left === 0) {
      if (this.simulatingSince !== null) {
        this.log.say(
          'simulated',
          `every lair's fight after ${Math.round((now - this.simulatingSince) / 1000)}s`
        );
      }
      this.simulatingSince = null;
      return false;
    }
    this.simulatingSince ??= now;
    if (now - this.simulatingSince >= tuning().konami.simulateWaitMs) {
      this.log.say('simulated', `not all: asking anyway with ${left} lairs not yet simulated`);
      this.simulatingSince = null;
      this.simulateGaveUpAt = left;
      return false;
    }
    if (this.pending === null) this.pending = why;
    this.briefAgainAt = now + tuning().konami.tickMs;
    this.log.wait(`${why}: the simulator is still running the lairs' fights`);
    this.events.changed();
    return true;
  }

  /** What is worn changed by any hand: a different character to plan for. */
  private watchWorn(state: CharacterState): void {
    if (state.inventory.wealth === null) return;
    const worn = wornMark(state);
    if (this.worn !== null && worn !== this.worn) {
      this.log.say('gear', `worn changed: ${this.worn || 'nothing'} -> ${worn || 'nothing'}`);
      this.trigger('gear');
    }
    this.worn = worn;
  }

  /** The Hunting grounds' own refusals, written as they change. */
  private watchHunt(): void {
    // What holds the goal from moving, said when it changes, so a still character says why.
    const doing = this.plan === null ? null : this.facts.activity()?.doing;
    const waiting = doing?.kind === 'waiting' ? doing.on : null;
    if (waiting !== this.waitSaid) {
      this.waitSaid = waiting;
      if (waiting !== null) this.log.say('hunt', `not set off: ${waiting}`);
    }
    const said = this.facts.huntRefusal();
    if (said === this.huntSaid) return;
    this.huntSaid = said;
    if (said !== null) this.log.say('hunt', `refused: ${said}`);
  }

  /** Why the planner is not running, in words. */
  private idleWhy(): string {
    if (!this.on) return 'switched off';
    if (!this.master) return 'automation is off';
    if (this.paused) return 'paused';
    return this.refusal ?? 'no provider loaded';
  }

  private incident(kind: KonamiIncidentKind): void {
    if (this.records === null) return;
    const at = Date.now();
    const state = this.facts.state();
    const files = incidentFiles({
      kind,
      at,
      state,
      realm: this.facts.realm(),
      lines: this.records.recentLines(tuning().konami.logLines),
      decisions: this.journal.decisions,
      plan: this.plan,
      blows: this.blows.since(at - tuning().konami.blowWindowMs),
      fightGapMs: tuning().konami.fightGapMs,
      roundSeconds: tuning().hunting.roundSeconds,
      refusals: this.facts.refusals()
    });
    const path = this.records.incident(kind, at, files);
    this.log.say('written', `${kind} log to ${path ?? '(nowhere)'}`);
    this.incidents.push({ kind, at, path });
    const over = this.incidents.length - tuning().konami.incidentsKept;
    if (over > 0) this.incidents.splice(0, over);
    this.events.notice(
      kind === 'death'
        ? t('automation.konami.deathLog', { path: path ?? '' })
        : t('automation.konami.stuckLog', { path: path ?? '' })
    );
    this.events.changed();
  }
}

/** What the character is told when a goal is handed on. */
function goalNotice(goal: KonamiGoal): string {
  switch (goal.kind) {
    case 'hunt':
      return t('automation.konami.goal.hunt', { name: goal.name });
    case 'buy':
      return t('automation.konami.goal.buy', {
        item: goal.name,
        shop: goal.shop,
        copper: goal.copper
      });
    case 'train':
      return t('automation.konami.goal.train');
    case 'wait':
      return t('automation.konami.goal.wait');
    default: {
      const never: never = goal;
      return never;
    }
  }
}
