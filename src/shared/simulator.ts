/**
 * Where a fight's trials are run: asked for, and answered later. The odds book
 * and the blessing choice ask through this, so the trials need not run on the
 * thread that holds the sockets. The app runs them on worker threads
 * (`app/simulatorPool.ts`); a test or a probe in slices on its own thread
 * (`session/slicedSimulator.ts`). `simulateFight` is the fight either way.
 */
import type { Survival, SurvivalInput } from './survival';

export interface FightSimulator {
  /**
   * Runs `input`'s trials and calls `done` once with what they came to, or
   * with null where `simulateFight` would answer null: never before `run`
   * returns, and never after the returned function is called, which drops
   * the run.
   */
  run(input: SurvivalInput, done: (survival: Survival | null) => void): () => void;
}
