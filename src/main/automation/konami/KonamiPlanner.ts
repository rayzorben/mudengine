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
  type KonamiGoal,
  type KonamiLayer,
  type KonamiPlan,
  type KonamiProvider,
  type KonamiTrigger,
  type LayerWrite
} from '../../../shared/konami';
import type { KonamiBrief } from '../../../shared/konamiBrief';
import { lessonsFor, type KonamiLesson, type LessonOutcome } from '../../../shared/konamiLessons';
import {
  nextUpgradePrice,
  planQuestions,
  readPlan,
  samePlan
} from '../../../shared/konamiQuestions';
import type {
  KonamiDecision,
  KonamiExchange,
  KonamiIncidentKind,
  KonamiIncidentRow,
  KonamiRecords,
  KonamiSnapshot
} from '../../../shared/konamiRecords';
import { bankedCopper } from '../../../shared/coins';
import { bareName, wornItems } from '../../../shared/items';
import { nameAnswersTo } from '../../../shared/world';
import type { SessionModule } from '../Module';
import { fightIsRunning } from '../Walker';
import { Blows } from './Blows';
import { incidentFiles } from './incident';
import { Journal } from './Journal';
import { lessonOf } from './lesson';
import { askWithin, loadProvider, providerPaths } from './ProviderLoader';
import { RunLog, stateLine } from './RunLog';

/** What the planner reads. */
export interface PlannerFacts {
  state(): CharacterState;
  /** The brief for this moment, with the lessons that apply, or why there is none. */
  brief(now: number, lessons: KonamiLesson[]): KonamiBrief | { refusal: string };
  /** Something else holds the character: an escape, a move out, a walk, a shop trip. */
  busy(): boolean;
  /** `AutoHunt` is walking to or running a spot. */
  hunting(): boolean;
  /** A shop trip is under way. */
  buying(): boolean;
  /** What `AutoHunt` last said it would not do for the steered spot, or null. */
  huntRefusal(): string | null;
  /** What the modules last said they would not do, newest first. */
  refusals(): string[];
  realm(): string | null;
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
  /** Since when a brief has come back with lairs still to simulate; null when none has. */
  private simulatingSince: number | null = null;
  /**
   * The lairs still unsimulated when the wait last ran out: not waited on
   * again until more than that are (the book started over for new figures).
   */
  private simulateGaveUpAt: number | null = null;
  /** What past plans came to, oldest first: read from the records once, added to as plans end. */
  private readonly lessons: KonamiLesson[];
  private huntSaid: string | null = null;
  private readonly blows = new Blows(() => tuning().konami.blowsKept);
  private readonly incidents: KonamiIncidentRow[] = [];
  private step: number | null = null;
  private upgradeAt: number | null = null;
  private inRealm = false;
  private mark = '';
  private markedAt = Date.now();
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
      request: { state: decision.brief, questions: decision.questions },
      raw: decision.raw,
      refusal: decision.refusal
    };
  }

  /** Running: switched on, not paused, and a provider in hand. */
  get running(): boolean {
    return this.on && !this.paused && this.provider !== null;
  }

  configure(automation: AutomationConfig): void {
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
    else this.trigger('asked');
    this.events.changed();
    return this.paused;
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
        this.incident('death');
        this.settle('failed', t('automation.konami.died'), 'died');
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
    this.worn = null;
    this.briefRefused = null;
    this.briefAgainAt = 0;
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
    return {
      on: this.on,
      paused: this.paused,
      provider: this.provider?.name ?? null,
      asking: this.asking,
      pending: this.pending,
      refusal: this.refusal,
      plan: this.plan,
      decisions: [...this.journal.decisions].reverse().map((decision) => ({
        id: decision.id,
        at: decision.at,
        trigger: decision.trigger,
        plan: decision.plan,
        refusal: decision.refusal,
        outcome: decision.outcome,
        outcomeWhy: decision.outcomeWhy
      })),
      incidents: [...this.incidents].reverse(),
      log: this.log.path
    };
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
    if (this.plan !== null && !fightIsRunning(state)) {
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
    this.hands.steerHunt(undefined);
    if (relayer) this.hands.relayer();
  }

  private trigger(why: KonamiTrigger): void {
    if (!this.running) {
      this.log.say('trigger', `${why}, not asked: ${this.idleWhy()}`);
      return;
    }
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

  private watchCash(state: CharacterState): void {
    const onHand = state.inventory.wealth;
    const total = onHand === null ? null : onHand + bankedCopper(state.banks);
    const step = cashStep(total);
    if (step !== null && this.step !== null && step > this.step) {
      this.log.say('cash', `${total ?? '?'} copper in all, a step up`);
      this.trigger('cash-step');
    }
    if (step !== null) this.step = step;
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
      case 'train':
        if (state.progress.expNeeded !== null && state.progress.expNeeded > 0) {
          this.finish('done', null);
        }
        return;
      case 'wait':
        return;
      default: {
        const never: never = goal;
        return never;
      }
    }
  }

  private finish(outcome: 'done' | 'refused', why: string | null): void {
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
   * leaves (a death is `failed` to the journal and `died` to the lesson).
   */
  private settle(
    outcome: 'done' | 'refused' | 'failed' | 'replaced',
    why: string | null,
    learned: LessonOutcome | null = outcome === 'failed' ? null : outcome
  ): void {
    const decision = this.journal.latest;
    if (decision?.outcome === 'applied' && learned !== null) this.learn(decision, learned, why);
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
    const { lessonLevels, lessonsSent } = tuning().konami;
    const brief = this.facts.brief(now, lessonsFor(this.lessons, level, lessonLevels, lessonsSent));
    if ('refusal' in brief) {
      // Kept waiting and tried again after a tick, so entering the realm is never lost.
      if (this.pending === null) this.pending = why;
      this.briefAgainAt = Date.now() + tuning().konami.tickMs;
      this.log.wait(`${why}: no brief yet: ${brief.refusal}`);
      if (brief.refusal !== this.briefRefused) {
        this.briefRefused = brief.refusal;
        this.refusal = brief.refusal;
        this.events.notice(t('automation.konami.noBrief', { why: brief.refusal }));
      }
      this.events.changed();
      return;
    }
    this.briefRefused = null;
    if (this.stillSimulating(why, brief, now)) return;
    this.asking = true;
    this.events.changed();
    const asked = planQuestions(brief);
    const generation = this.generation;
    const request = { state: brief, questions: asked.questions };
    this.log.say('asking', `${provider.name} for ${why} · ${stateLine(this.facts.state())}`);
    this.log.block('sent', `${Object.keys(asked.questions).length} questions`, request);
    const answer = await askWithin(provider, request, tuning().konami.askTimeoutMs);
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
    const previous = this.plan;
    const decision: KonamiDecision = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      at: now,
      trigger: why,
      provider: provider.name,
      model: 'refusal' in answer ? null : answer.reply.model,
      brief,
      questions: asked.questions,
      raw: 'refusal' in answer ? null : answer.raw,
      plan,
      refusal: 'refusal' in answer ? answer.refusal : null,
      outcome: plan === null ? 'failed' : 'applied',
      outcomeWhy: null,
      settledAt: null
    };
    this.settle('replaced', null);
    this.journal.add(decision);
    this.upgradeAt = nextUpgradePrice(brief);
    if (plan === null) {
      this.refusal = decision.refusal;
      this.events.notice(decision.refusal ?? '');
      this.events.changed();
      return;
    }
    this.refusal = null;
    if (why === 'stuck' && previous !== null && samePlan(previous, plan) && !this.stuckLogged) {
      this.stuckLogged = true;
      this.incident('stuck');
    }
    this.apply(plan);
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
    const said = this.facts.huntRefusal();
    if (said === this.huntSaid) return;
    this.huntSaid = said;
    if (said !== null) this.log.say('hunt', `refused: ${said}`);
  }

  /** Why the planner is not running, in words. */
  private idleWhy(): string {
    if (!this.on) return 'switched off';
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
