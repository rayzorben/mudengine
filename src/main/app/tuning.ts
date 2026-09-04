/**
 * The main process's view of the `tuning:` block, read wherever it is used.
 *
 * Every number this client uses to decide something lives in `internal.yaml`
 * (see `src/shared/internal.ts`). Getting one to the code that acts on it is
 * the awkward half: a timeout is read inside a socket, a retry count inside a
 * loop runner, a cap inside a parser — none of which has a configuration
 * object to hand, and threading one through every constructor would put a
 * parameter on forty classes to carry a number none of them chooses.
 *
 * So it follows `app/i18n.ts` exactly: a process-wide value, set once at
 * startup and again whenever the file changes, read through a function. The
 * two properties that makes it safe are the same ones the dictionary has —
 * **it is only ever read**, and **there is a complete default under it**, so
 * anything constructed before the file has been read (a unit test, a probe
 * script, the moments before `createInternal` runs) gets the shipped numbers
 * rather than an absence.
 *
 * Read at the point of use rather than captured, so a saved edit reaches a
 * session that is already running. The one thing that cannot be done from
 * here is re-arming a timer that has already been scheduled with an older
 * interval; those pick the change up on their next tick.
 */
import { DEFAULT_INTERNAL, type TuningConfig } from '../../shared/internal';

let current: TuningConfig = DEFAULT_INTERNAL.tuning;

/** Called by `index.ts` when the internal settings file is read or reloaded. */
export function setTuning(next: TuningConfig): void {
  current = next;
}

/** The numbers in force. Never captured into a field: read where it is used. */
export function tuning(): TuningConfig {
  return current;
}
