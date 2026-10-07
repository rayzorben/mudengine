/**
 * Fights run on worker threads (`simulatorWorker.ts`), so the trials the odds
 * book and the blessing choice keep running are off the thread that holds the
 * sockets and answers the window; mudengine-automation › *The verdict is also
 * run as a fight* has the measurement. One pool for the app,
 * `menace.simulatorThreads` workers, each given one run at a time, the rest
 * queued in the order asked.
 *
 * A worker that fails, or a run that cannot be posted to one, is said once,
 * and every run from then on goes to the simulator the composition root hands
 * in for it (`SlicedSimulator`, on main), the ones queued or running
 * included: slower, never lost.
 */
import { Worker } from 'node:worker_threads';

import { t } from './i18n';
import { tuning } from './tuning';
import type { FightSimulator } from '../../shared/simulator';
import type { Survival, SurvivalInput } from '../../shared/survival';
import { errorMessage } from '../../shared/values';

interface Run {
  readonly id: number;
  readonly input: SurvivalInput;
  readonly done: (survival: Survival | null) => void;
  dropped: boolean;
  /** Drops it where it went after a failure. */
  dropMoved: (() => void) | null;
}

interface Thread {
  readonly worker: Worker;
  running: Run | null;
}

export class SimulatorPool implements FightSimulator {
  private readonly threads: Thread[] = [];
  private readonly waiting: Run[] = [];
  private nextId = 1;
  /** Set once a worker fails: where every run goes from then on. */
  private fallback: (FightSimulator & { dispose(): void }) | null = null;
  private disposed = false;

  constructor(
    /** The worker's built entry (`simulatorWorker.js` beside `index.js`). */
    private readonly workerFile: string,
    private readonly say: (message: string) => void,
    /** Where runs go once a worker has failed. */
    private readonly fallbackOf: () => FightSimulator & { dispose(): void }
  ) {}

  run(input: SurvivalInput, done: (survival: Survival | null) => void): () => void {
    if (this.disposed) return () => undefined;
    if (this.fallback !== null) return this.fallback.run(input, done);
    const run: Run = { id: this.nextId++, input, done, dropped: false, dropMoved: null };
    this.waiting.push(run);
    this.pump();
    return () => {
      run.dropped = true;
      run.dropMoved?.();
    };
  }

  /** Stops every worker; nothing runs or starts after. */
  dispose(): void {
    this.disposed = true;
    for (const thread of this.threads) void thread.worker.terminate();
    this.threads.length = 0;
    this.waiting.length = 0;
    this.fallback?.dispose();
  }

  /** Hands the next runs to idle workers, starting one while under the count. */
  private pump(): void {
    while (this.waiting.length > 0 && this.fallback === null) {
      const run = this.waiting[0]!;
      if (run.dropped) {
        this.waiting.shift();
        continue;
      }
      const thread = this.idle();
      if (thread === null) return;
      this.waiting.shift();
      thread.running = run;
      try {
        thread.worker.postMessage({ id: run.id, input: run.input });
      } catch (error) {
        // An input that cannot be cloned to the worker: the slices take it, and every run after.
        this.fail(errorMessage(error));
        return;
      }
    }
  }

  private idle(): Thread | null {
    if (this.disposed) return null;
    const free = this.threads.find((thread) => thread.running === null);
    if (free !== undefined) return free;
    if (this.threads.length >= Math.max(1, tuning().menace.simulatorThreads)) return null;
    return this.start();
  }

  private start(): Thread {
    const worker = new Worker(this.workerFile);
    const thread: Thread = { worker, running: null };
    worker.on('message', (message: { id: number; survival: Survival | null }) => {
      // An answer after the pool failed or was put down: its run went elsewhere, or nowhere.
      if (!this.threads.includes(thread)) return;
      const run = thread.running;
      thread.running = null;
      if (run !== null && run.id === message.id && !run.dropped) run.done(message.survival);
      this.pump();
    });
    worker.on('error', (error) => this.fail(errorMessage(error)));
    worker.on('messageerror', (error) => this.fail(errorMessage(error)));
    worker.on('exit', (code) => {
      if (this.threads.includes(thread)) this.fail(`exited with code ${code}`);
    });
    // A pool waiting on nothing never holds the process open on the way out.
    worker.unref();
    this.threads.push(thread);
    return thread;
  }

  /** Every run, the ones in hand included, to the slices on main from now on; said once. */
  private fail(why: string): void {
    if (this.fallback !== null || this.disposed) return;
    this.fallback = this.fallbackOf();
    this.say(t('notices.simulator.workerFailed', { error: why }));
    const owed = [
      ...this.threads.flatMap((thread) => (thread.running === null ? [] : [thread.running])),
      ...this.waiting
    ];
    for (const thread of this.threads) void thread.worker.terminate();
    this.threads.length = 0;
    this.waiting.length = 0;
    for (const run of owed) {
      if (run.dropped) continue;
      run.dropMoved = this.fallback.run(run.input, (survival) => {
        if (!run.dropped) run.done(survival);
      });
    }
  }
}
