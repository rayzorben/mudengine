/**
 * A deadline judged only after the socket input already waiting has been read.
 * A timer whose time passed while the main thread was busy fires in the event
 * loop's timers phase, before the poll phase reads what arrived meanwhile, so
 * a verdict given there hangs up on a far end that was answering: on
 * 2026-10-29 UTC route plans held the thread for 59 to 73 seconds and two healthy
 * connections were hung up as dead. `setImmediate` runs after the poll phase.
 */

/** An armed deadline, owned by whoever armed it. */
export interface Deadline {
  /** Idempotent: a cleared or expired deadline stays quiet. */
  clear(): void;
}

export function deadline(ms: number, expire: () => void, holdsProcess = true): Deadline {
  let immediate: NodeJS.Immediate | null = null;
  let timer: NodeJS.Timeout | null = setTimeout(() => {
    timer = null;
    immediate = setImmediate(() => {
      immediate = null;
      expire();
    });
    if (!holdsProcess) immediate.unref();
  }, ms);
  if (!holdsProcess) timer.unref();
  return {
    clear() {
      if (timer !== null) clearTimeout(timer);
      if (immediate !== null) clearImmediate(immediate);
      timer = null;
      immediate = null;
    }
  };
}

/** `fn` every `ms`, each beat run after the input waiting at it is read, as `deadline` judges. */
export function repeating(ms: number, fn: () => void, holdsProcess = true): Deadline {
  let immediate: NodeJS.Immediate | null = null;
  const timer = setInterval(() => {
    // A beat still waiting for its turn is the same beat.
    if (immediate !== null) return;
    immediate = setImmediate(() => {
      immediate = null;
      fn();
    });
    if (!holdsProcess) immediate.unref();
  }, ms);
  if (!holdsProcess) timer.unref();
  return {
    clear() {
      clearInterval(timer);
      if (immediate !== null) clearImmediate(immediate);
      immediate = null;
    }
  };
}
