/**
 * One client per profile, because two fight over everything a client owns.
 *
 * The trigger was a measurement, not a tidiness argument. Two instances left
 * running by a harness held the Chromium profile under `~/.config/mudengine`,
 * and the *next* launch spent **3.4 seconds** blocked in its very first
 * `localStorage.getItem` — the synchronous read `useOverridablePreference`
 * makes during the first render — while Chromium waited on the storage the
 * older process was holding. The window is shown at `ready-to-show`, which
 * fires when the empty document paints its background, so the stall was
 * displayed: a black window for three seconds, and nothing anywhere saying
 * why. Measured cold, same profile, `npm run dev`: 4.1s to first contentful
 * paint with a rival instance, 0.9s without, and 1.1s once the strays were
 * killed.
 *
 * The storage stall is only the symptom that got noticed. Two clients on one
 * profile also write the same `mob-lore.json`, the same world memory, the same
 * fight logs and the same `workspace.json` — every one of them a lazily
 * flushed file whose last writer wins — and, with `autoConnect`, dial
 * characters that are already in the realm, where the server drops one of the
 * two. There is no version of that which is what somebody meant.
 *
 * **The lock is per user-data directory**, which is Electron's own rule and the
 * one that keeps the harnesses working: `smoke`, `first-run`, `live-check` and
 * `signal-probe` each pass their own `--user-data-dir`, so they still run
 * beside a client that is open. What is refused is a second client on *this*
 * profile — including, deliberately, one launched with a different
 * `MUDENGINE_CONFIG` but the same user data, because the storage, the workspace
 * and the Chromium profile are shared whatever the options file says.
 *
 * A refusal is said out loud and the original is raised. A client that exits
 * silently when double-launched is indistinguishable from one that crashed.
 */
import { t } from './i18n';

export interface InstanceOptions {
  /** Electron's per-user-data-directory lock. False means somebody has it. */
  claim(): boolean;
  /** Subscribe to another launch bouncing off this one. */
  onAnotherLaunch(handler: () => void): void;
  /** Bring what is already running back to the front. */
  raise(): void;
  /** Into the terminal that launched it: there is no window to report through. */
  say(message: string): void;
  /**
   * Leave. Deliberately not the quit path: nothing has been opened yet, so
   * there is nothing to tear down, and raising `before-quit` here would run a
   * confirmation about characters this process never loaded.
   */
  leave(): void;
}

/** What the second launch says on its way out. */
export const ALREADY_RUNNING = t('app.instance.alreadyRunning');

/**
 * Whether this process owns the profile and may go on starting.
 *
 * Returns false only after saying so and asking to leave, so the caller's
 * whole job is to build nothing.
 */
export function ownTheProfile(options: InstanceOptions): boolean {
  if (!options.claim()) {
    options.say(ALREADY_RUNNING);
    options.leave();
    return false;
  }

  options.onAnotherLaunch(() => options.raise());
  return true;
}
