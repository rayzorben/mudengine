/**
 * `@disarm <dir>`, `@pick <dir>` and `@bash <dir>` (todo 86): a leader sends
 * the member with the best odds at a trapped way or a locked door, and this
 * character tries until it holds or its own odds say to stop, then answers
 * `{ok}` or `{failed}`. One path for the three; the table row says the
 * command, the answer that ends it and the bound on tries. A failed disarm
 * has no fixed line (it is the exit's own message, `TrapExit.TryDisarm`), so
 * the deadline is its answer, as in `walk/Disarm.ts`. The leader opens a
 * picked door. `mudengine-automation` › parts/remotes.md.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import { jobCommand, jobOdds, type BarrierJob } from '../../shared/barrierHands';
import { fightIsRunning, type CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import { barrierStated, disarmTries, tooHurtToBash } from '../../shared/walk';
import {
  asSpokenDirection,
  DIRECTION_NAME,
  roomAddress,
  type Direction,
  type Requirement,
  type RoomId
} from '../../shared/world';
import type { CommandQueue } from './CommandQueue';

export interface BarrierRemotesEvents {
  notice?(message: string): void;
}

interface Row {
  /** The try held: the trap is disarmed, the lock picked, the door bashed open. */
  held(block: Block, direction: Direction): boolean;
  /** The try failed on a line the server prints (a disarm prints none of its own). */
  failed(block: Block): boolean;
  /** How many tries before the odds say to stop. */
  tries(odds: number, config: AutomationConfig): number;
  /** The figure the job rolls on, for the notices. */
  skill(): string;
}

const ROWS: Readonly<Record<BarrierJob, Row>> = {
  disarm: {
    // `already disarmed` names no way; it answers the one try out.
    held: (block, direction) =>
      block.type === 'trap-disarmed' &&
      (block.groups['direction'] === undefined ||
        asSpokenDirection(block.groups['direction']) === direction),
    failed: () => false,
    tries: (odds) => disarmTries(odds, tuning().walk.disarmDoubt),
    skill: () => t('automation.remotes.skillTraps')
  },
  pick: {
    // `The door is already open.` ends it as well: nothing is left to pick.
    held: (block) =>
      block.type === 'door-changed' &&
      (block.groups['state2'] === 'unlocked' || block.groups['state'] === 'open'),
    failed: (block) => block.type === 'skill-failed',
    tries: (_odds, config) => config.movement.pickTries,
    skill: () => t('automation.remotes.skillPicklocks')
  },
  bash: {
    held: (block) => block.type === 'door-changed' && block.groups['state'] === 'open',
    failed: (block) => block.type === 'bash-failed',
    tries: (_odds, config) => config.movement.bashTries,
    skill: () => t('automation.remotes.skillStrength')
  }
};

interface Running {
  job: BarrierJob;
  from: string;
  direction: Direction;
  need: Requirement | undefined;
  here: RoomId | null;
  tries: number;
  spent: number;
  /** A try is on the wire and its answer not yet read. */
  out: boolean;
  answer(body: string): void;
}

export class BarrierRemotes {
  private running: Running | null = null;
  /** The state as of the last line, for a try the deadline sends. */
  private latest: CharacterState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private config: AutomationConfig,
    private readonly queue: Pick<CommandQueue, 'enqueue'>,
    private readonly events: BarrierRemotesEvents = {}
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
  }

  /** A granted `@disarm`, `@pick` or `@bash`; `answer` speaks back to the sender. */
  start(
    job: BarrierJob,
    from: string,
    argument: string | null,
    state: CharacterState,
    answer: (body: string) => void
  ): void {
    const direction = argument === null ? null : asSpokenDirection(argument);
    if (direction === null) {
      this.events.notice?.(t('automation.remotes.barrierNoWay', { from, job }));
      return;
    }
    this.end(null);
    const words = { from, job, direction: DIRECTION_NAME[direction] };
    const need =
      state.room.exits.find((way) => way.direction === direction)?.requirement ?? undefined;
    const refusal = this.refusal(job, need, state, words);
    if (refusal !== null) {
      this.events.notice?.(refusal);
      answer('{failed}');
      return;
    }
    const { strength, traps, picklocks } = state.progress;
    const odds = jobOdds(job, { strength, traps, picklocks }, need) ?? 0;
    const tries = Math.max(1, ROWS[job].tries(odds, this.config));
    this.running = {
      job,
      from,
      direction,
      need,
      here: roomAddress(state.room),
      tries,
      spent: 0,
      out: false,
      answer
    };
    this.events.notice?.(
      t('automation.remotes.barrierTrying', { ...words, percent: Math.round(odds * 100), tries })
    );
    this.latest = state;
    this.tryOnce();
  }

  onBlock(block: Block, state: CharacterState): void {
    const running = this.running;
    if (running === null || !running.out) return;
    const row = ROWS[running.job];
    this.latest = state;
    if (row.held(block, running.direction)) {
      this.events.notice?.(
        t('automation.remotes.barrierHeld', { ...this.words(running), count: running.spent + 1 })
      );
      this.end('{ok}');
      return;
    }
    if (row.failed(block)) this.failedOnce(running);
  }

  /** A fight, another room or automation switched off ends the job. */
  onCharacter(state: CharacterState): void {
    const running = this.running;
    if (running === null) return;
    this.latest = state;
    const moved = roomAddress(state.room) !== running.here;
    if (!this.config.enabled || fightIsRunning(state) || moved) {
      this.events.notice?.(t('automation.remotes.barrierLeft', this.words(running)));
      this.end('{failed}');
    }
  }

  reset(): void {
    this.end(null);
    this.latest = null;
  }

  dispose(): void {
    this.end(null);
  }

  /** Why this character cannot take the job at all, or null. */
  private refusal(
    job: BarrierJob,
    need: Requirement | undefined,
    state: CharacterState,
    words: { from: string; job: BarrierJob; direction: string }
  ): string | null {
    if (fightIsRunning(state)) return t('automation.remotes.barrierFighting', words);
    // A lock with a key and no figure: only that key opens it (`RoomManager`, -999).
    if (job !== 'disarm' && need?.keyId !== undefined && !barrierStated(need)) {
      return t('automation.remotes.barrierKeyOnly', words);
    }
    const { strength, traps, picklocks } = state.progress;
    const odds = jobOdds(job, { strength, traps, picklocks }, need);
    if (odds === null || odds <= 0) {
      return t('automation.remotes.barrierNoOdds', { ...words, skill: ROWS[job].skill() });
    }
    return this.tooHurt(job, need, state, words);
  }

  /** A failed disarm fires the trap at this character; a bash costs up to 3 HP. */
  private tooHurt(
    job: BarrierJob,
    need: Requirement | undefined,
    state: CharacterState,
    words: { from: string; job: BarrierJob; direction: string }
  ): string | null {
    if (job === 'bash' && tooHurtToBash(state.vitals, this.config.health.restBelow)) {
      return t('automation.remotes.barrierHurt', words);
    }
    const damage = job === 'disarm' ? (need?.damage ?? null) : null;
    const { hp } = state.vitals;
    if (damage !== null && hp !== null && hp <= damage) {
      return t('automation.remotes.barrierTrapKills', { ...words, damage, hp });
    }
    return null;
  }

  private tryOnce(): void {
    const running = this.running;
    const state = this.latest;
    if (running === null || state === null) return;
    const refusal = this.tooHurt(running.job, running.need, state, this.words(running));
    if (refusal !== null) {
      this.events.notice?.(refusal);
      this.end('{failed}');
      return;
    }
    this.queue.enqueue({
      command: jobCommand(running.job, running.direction),
      priority: 'movement',
      coalesceKey: 'remote:barrier',
      stillWanted: () => this.running === running,
      reason: t('automation.remotes.reasonBarrier', this.words(running)),
      onSent: () => {
        running.out = true;
        this.arm(running, tuning().walk.disarmAnswerMs);
      }
    });
    // Unsent by then, the queue dropped it (a stat screen, the room changed).
    this.arm(running, tuning().remotes.replyMs);
  }

  /** No answer by the deadline: a disarm's failure, or a line lost. */
  private arm(running: Running, ms: number): void {
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.running !== running) return;
      if (running.out) {
        this.failedOnce(running);
        return;
      }
      this.events.notice?.(t('automation.remotes.barrierLeft', this.words(running)));
      this.end('{failed}');
    }, ms);
  }

  private failedOnce(running: Running): void {
    running.out = false;
    running.spent += 1;
    if (running.spent < running.tries) {
      this.tryOnce();
      return;
    }
    this.events.notice?.(
      t('automation.remotes.barrierGaveUp', { ...this.words(running), count: running.spent })
    );
    this.end('{failed}');
  }

  /** The job over, answered with `body` (null: said nothing, a newer job replaced it). */
  private end(body: string | null): void {
    const running = this.running;
    this.running = null;
    this.clear();
    if (running !== null && body !== null) running.answer(body);
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private words(running: Running): { from: string; job: BarrierJob; direction: string } {
    return { from: running.from, job: running.job, direction: DIRECTION_NAME[running.direction] };
  }
}
