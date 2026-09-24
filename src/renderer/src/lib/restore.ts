/**
 * The restored backscrolls, written one console at a time, the shown one first.
 *
 * Every character's terminal is mounted at launch and each attaches with its
 * whole retained output — up to `terminal.scrollback` lines. Written at once,
 * four of them parsed side by side and the console the player is looking at
 * finished last among equals (todo 02, 2026-09-23). Queued, it finishes first
 * and the hidden ones fill in behind it, sliced (`sliceLines`), so the window
 * answers throughout. See `mudengine-ui` › *A launch restores the shown console
 * first*.
 */

export interface RestoreJob {
  /** Whether this console is the one on screen, asked when a slot frees. */
  shown(): boolean;
  /** Write the backscroll; call `done` once it has been parsed. */
  run(done: () => void): void;
}

export interface RestoreQueue {
  /** Queue a restore; the answer takes it back, running or not. */
  add(job: RestoreJob): () => void;
  /**
   * A shown console whose attach is still on its way: no hidden restore takes
   * the slot until it arrives. The answer lets go, and is safe to call twice.
   */
  hold(): () => void;
}

export function restoreQueue(): RestoreQueue {
  const waiting: RestoreJob[] = [];
  let running: RestoreJob | null = null;
  let holds = 0;

  const next = (): void => {
    if (running !== null || waiting.length === 0) return;
    const shown = waiting.findIndex((job) => job.shown());
    if (shown === -1 && holds > 0) return;
    const [job] = waiting.splice(shown === -1 ? 0 : shown, 1);
    if (job === undefined) return;
    running = job;
    job.run(() => {
      // A job taken back while it ran has already freed the slot.
      if (running !== job) return;
      running = null;
      next();
    });
  };

  return {
    add(job) {
      waiting.push(job);
      next();
      return () => {
        const at = waiting.indexOf(job);
        if (at !== -1) waiting.splice(at, 1);
        if (running === job) {
          // A terminal disposed mid-restore never calls back.
          running = null;
          next();
        }
      };
    },
    hold() {
      holds += 1;
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        holds -= 1;
        next();
      };
    }
  };
}

/** The window's one queue: every console in it shares the thread. */
export const restores = restoreQueue();
