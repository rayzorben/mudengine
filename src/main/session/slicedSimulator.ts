/**
 * Fights run on the thread that asked, in slices of `survivalSliceMs`, so the
 * socket's thread is handed back between them, a fight's trials carried into
 * the next slice (`startFight`). What a session runs on when it was given no
 * pool: the tests and the probes. The app's runs go to worker threads
 * (`app/simulatorPool.ts`).
 */
import { tuning } from '../app/tuning';
import type { FightSimulator } from '../../shared/simulator';
import {
  startFight,
  type FightTrials,
  type Survival,
  type SurvivalInput
} from '../../shared/survival';

interface Run {
  readonly input: SurvivalInput;
  readonly done: (survival: Survival | null) => void;
  trials: FightTrials | null;
  dropped: boolean;
}

export class SlicedSimulator implements FightSimulator {
  private readonly runs: Run[] = [];
  private slice: NodeJS.Immediate | null = null;

  run(input: SurvivalInput, done: (survival: Survival | null) => void): () => void {
    const run: Run = { input, done, trials: null, dropped: false };
    this.runs.push(run);
    this.schedule();
    return () => {
      run.dropped = true;
    };
  }

  /** Drops every run and the slice waiting to start. */
  dispose(): void {
    for (const run of this.runs) run.dropped = true;
    this.runs.length = 0;
    if (this.slice !== null) clearImmediate(this.slice);
    this.slice = null;
  }

  private schedule(): void {
    if (this.slice !== null || this.runs.length === 0) return;
    this.slice = setImmediate(() => {
      this.slice = null;
      this.work();
    });
  }

  /** Runs trials until the slice is spent, a fight part way carried into the next one. */
  private work(): void {
    const began = performance.now();
    const budget = tuning().menace.survivalSliceMs;
    const spent = (): boolean => performance.now() - began >= budget;
    while (this.runs.length > 0 && !spent()) {
      const run = this.runs[0]!;
      if (run.dropped) {
        this.runs.shift();
        continue;
      }
      if (run.trials === null) {
        const trials = startFight(run.input);
        if (trials === null) {
          this.runs.shift();
          run.done(null);
          continue;
        }
        run.trials = trials;
      }
      run.trials.run(spent);
      if (!run.trials.done) break;
      this.runs.shift();
      run.done(run.trials.result());
    }
    this.schedule();
  }
}
