/**
 * The session a probe drives, and how a probe that never got in ends.
 *
 * A probe turns automation off so nothing sends but the probe, and with
 * automation off the client's login stops at the realm's menu (`98af3b22`), so
 * a character is never left in the realm with nothing to rest, run or heal it.
 * A probe is watched while it runs, so its login goes on into the realm. The
 * switch is a `SessionDeps` field that `client.ts` never sets and only this
 * file passes (todo 20261105-1600-01, `mudengine-verify` › *The probe fleet*).
 */
import { SessionManager } from '../../src/main/session/SessionManager.ts';

/** A `SessionManager` whose login enters the realm with automation off. */
export function probeSession(sink, deps = {}) {
  return new SessionManager(sink, { ...deps, entersRealmWithAutomationOff: true });
}

/**
 * The run measured nothing, so it fails: a probe that exits zero here reads as
 * a clean result to whoever ran it. Returns the line to print.
 */
export function neverReachedRealm(who = '') {
  process.exitCode = 1;
  return `${who}never reached the realm; nothing to measure.`;
}
