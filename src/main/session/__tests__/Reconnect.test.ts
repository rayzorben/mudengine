import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Reconnect } from '../Reconnect';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { setTuning } from '../../app/tuning';
import type { ConnectionState, ConnectionTarget } from '../../../shared/types';

/**
 * The ladder is asserted against the **shipped** numbers rather than short
 * ones injected for the test. What a player asked for is 0s, 5s, 10s and then
 * 15s, and a test over 5ms steps proves the arithmetic while saying nothing
 * about the schedule anybody actually runs — which is the half `internal.yaml`
 * exists to keep editable and therefore the half worth pinning.
 */
const TARGET: ConnectionTarget = { host: 'realm.example', port: 2427, encoding: 'cp437' };

const state = (over: Partial<ConnectionState> = {}): ConnectionState => ({
  phase: 'closed',
  target: TARGET,
  connectedAt: null,
  detail: null,
  negotiated: {
    localEnabled: [],
    remoteEnabled: [],
    binary: false,
    suppressGoAhead: false,
    remoteEcho: false
  },
  ...over
});

let dials: ConnectionTarget[] = [];
let notices: string[] = [];
let enabled = true;
/** How many times the host was told the retry state moved. */
let changes = 0;
/** What the next dial reports back. A retry follows anything but `connected`. */
let answer: ConnectionState = state({ phase: 'error' });

function build(): Reconnect {
  return new Reconnect({
    enabled: () => enabled,
    dial: (target) => {
      dials.push(target);
      return Promise.resolve(answer);
    },
    changed: () => {
      changes += 1;
    },
    notice: (message) => notices.push(message)
  });
}

/**
 * A session that connected, held for `heldMs`, and then lost its socket.
 *
 * The two states are what the host feeds through `observe`, in the order the
 * manager publishes them — the second is the one that nulls `connectedAt`, and
 * reading the clock from it rather than from the first is the mistake this
 * helper exists to make impossible to write by accident.
 */
function drop(reconnect: Reconnect, heldMs: number): void {
  reconnect.observe(state({ phase: 'connected', connectedAt: Date.now() - heldMs }));
  reconnect.observe(state({ phase: 'closed' }));
  reconnect.lost(null);
}

beforeEach(() => {
  vi.useFakeTimers();
  dials = [];
  notices = [];
  enabled = true;
  changes = 0;
  answer = state({ phase: 'error' });
});

afterEach(() => {
  vi.useRealTimers();
  setTuning(DEFAULT_INTERNAL.tuning);
});

describe('a lost connection', () => {
  it('dials at once, then waits 5s, 10s and 15s for as long as it takes', async () => {
    const reconnect = build();
    drop(reconnect, 60_000);

    // Nothing is dialled from inside the close itself: `lost` is called while
    // the socket is still being torn down, so even the immediate attempt goes
    // through a timer.
    expect(dials).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(0);
    expect(dials).toHaveLength(1);

    // Each attempt reports `error`, so the next rung is scheduled from it.
    for (const wait of [5_000, 10_000, 15_000, 15_000]) {
      const before = dials.length;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(dials).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(dials).toHaveLength(before + 1);
    }
    expect(dials.every((target) => target === TARGET)).toBe(true);
  });

  it('carries the ladder across a connection that did not hold', async () => {
    /*
     * Every dial *succeeds* here, and every connection is dropped a second
     * later — a full BBS, or a realm rebooting. This is the shape that would
     * dial somebody else's host as fast as TCP allows if a socket merely
     * opening were taken as the outage ending.
     */
    const reconnect = build();
    answer = state({ phase: 'connected', connectedAt: Date.now() });
    drop(reconnect, 60_000);

    await vi.advanceTimersByTimeAsync(0);
    expect(dials).toHaveLength(1);

    for (const wait of [5_000, 10_000, 15_000]) {
      drop(reconnect, 1_000);
      const before = dials.length;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(dials).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(dials).toHaveLength(before + 1);
    }
  });

  it('starts the ladder over once a connection has settled', async () => {
    const reconnect = build();
    answer = state({ phase: 'connected', connectedAt: Date.now() });
    drop(reconnect, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(dials).toHaveLength(1);

    // One rung in, and then a connection that held past `settledMs`: the outage
    // ended with it, so the next loss is dialled at once rather than after 10s.
    drop(reconnect, 1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dials).toHaveLength(2);

    drop(reconnect, DEFAULT_INTERNAL.tuning.reconnect.settledMs);
    await vi.advanceTimersByTimeAsync(0);
    expect(dials).toHaveLength(3);
  });

  it('stops at the attempt cap and says how to dial again', async () => {
    setTuning({
      ...DEFAULT_INTERNAL.tuning,
      reconnect: { ...DEFAULT_INTERNAL.tuning.reconnect, maxAttempts: 2 }
    });
    const reconnect = build();
    drop(reconnect, 60_000);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dials).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(dials).toHaveLength(2);
    expect(notices.at(-1)).toMatch(/Press Connect/);
  });

  it('leaves a connection alone once it is up again', async () => {
    const reconnect = build();
    answer = state({ phase: 'connected', connectedAt: Date.now() });
    drop(reconnect, 60_000);

    await vi.advanceTimersByTimeAsync(0);
    expect(dials).toHaveLength(1);
    // Whether it *holds* is the next `lost`'s business, not a second dial's.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dials).toHaveLength(1);
  });
});

describe('a connection that ended rather than dropped', () => {
  it('is not dialled again when the player left the realm, and is told so', async () => {
    const reconnect = build();
    reconnect.observe(state({ phase: 'connected', connectedAt: Date.now() }));
    reconnect.observe(state({ phase: 'closed' }));
    reconnect.lost('left-realm');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(dials).toHaveLength(0);
    expect(notices.join(' ')).toMatch(/left the realm/);
  });

  it('is not dialled again when the realm refused the login', async () => {
    const reconnect = build();
    reconnect.observe(state({ phase: 'connected', connectedAt: Date.now() }));
    reconnect.observe(state({ phase: 'closed' }));
    reconnect.lost('login-refused');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(dials).toHaveLength(0);
    expect(notices.join(' ')).toMatch(/refused the login/);
  });

  it('says nothing at all when the character never asked for this', async () => {
    enabled = false;
    const reconnect = build();
    drop(reconnect, 60_000);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(dials).toHaveLength(0);
    expect(notices).toEqual([]);
  });
});

describe('something else taking the connection over', () => {
  it('calls a pending retry off, which is what Disconnect presses', async () => {
    const reconnect = build();
    drop(reconnect, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(dials).toHaveLength(1);
    expect(reconnect.pending).toBe(true);

    reconnect.cancel();
    expect(reconnect.pending).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dials).toHaveLength(1);
  });

  it('does not schedule another rung after the dial it already sent is called off', async () => {
    // A list rather than a variable: TypeScript narrows one assigned only from
    // inside a callback to `never`, and the workaround for that is noise.
    const settle: Array<(state: ConnectionState) => void> = [];
    const reconnect = new Reconnect({
      enabled: () => enabled,
      dial: (target) => {
        dials.push(target);
        return new Promise<ConnectionState>((resolve) => settle.push(resolve));
      },
      changed: () => {
        changes += 1;
      },
      notice: (message) => notices.push(message)
    });

    drop(reconnect, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(dials).toHaveLength(1);

    // The player pressed Connect while this dial was still in flight. The
    // answer that arrives afterwards belongs to an outage nobody is running.
    reconnect.cancel();
    settle[0]?.(state({ phase: 'error' }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dials).toHaveLength(1);
  });

  it('abandons a retry that would fire into a live connection', async () => {
    const reconnect = build();
    drop(reconnect, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(dials).toHaveLength(1);

    // The player dialled by hand during the 5s wait. Firing now would tear down
    // the socket they just made.
    reconnect.observe(state({ phase: 'connected', connectedAt: Date.now() }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dials).toHaveLength(1);
  });

  /*
   * **Switching the setting off reaches a ladder already running.**
   *
   * `enabled()` is a callback for exactly this, and it was consulted only when
   * the socket dropped — so the answer was fixed at the moment of the drop and
   * the ladder then ran to `maxAttempts`, 999,999, whatever the profile said
   * afterwards. With nothing on screen offering to stop it, that is a client
   * dialling a realm all night with credentials somebody has untick-ed.
   */
  it('stops when the character stops wanting it, mid-ladder', async () => {
    const reconnect = build();
    drop(reconnect, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(dials).toHaveLength(1);

    enabled = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dials).toHaveLength(1);
    expect(notices.join(' ')).toMatch(/switched off/);
    expect(reconnect.pending).toBe(false);
  });

  /*
   * **A server that accepts and hangs up is bounded far lower than an outage.**
   *
   * The realm this client ships pointed at is a MajorMUD behind a BBS, and
   * `login-failed` has exactly one pattern — GreaterMUD's wording. A front end
   * that answers a refused password in its own words and then drops the line
   * arrives here as an ordinary loss with nothing to stand the ladder down, so
   * without this the credentials go back out every fifteen seconds for as long
   * as the client is left running.
   */
  it('gives up when the realm keeps accepting and dropping', async () => {
    setTuning({
      ...DEFAULT_INTERNAL.tuning,
      reconnect: { ...DEFAULT_INTERNAL.tuning.reconnect, maxFlaps: 3 }
    });
    const reconnect = build();
    answer = state({ phase: 'connected', connectedAt: Date.now() });

    // Three connections, each dropped a second after it opened.
    drop(reconnect, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    drop(reconnect, 1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    drop(reconnect, 1_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dials).toHaveLength(3);

    drop(reconnect, 1_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dials).toHaveLength(3);
    expect(notices.join(' ')).toMatch(/stopped dialling/);
  });

  /* And an outage never flaps: it refuses or never answers, so it never gets a
     socket to be dropped from. That is the case asked to run unbounded. */
  it('does not count a dial that never connected as a drop', async () => {
    setTuning({
      ...DEFAULT_INTERNAL.tuning,
      reconnect: { ...DEFAULT_INTERNAL.tuning.reconnect, maxFlaps: 2 }
    });
    const reconnect = build();
    drop(reconnect, 60_000);
    // Every attempt fails to connect; the ladder runs on regardless.
    await vi.advanceTimersByTimeAsync(0);
    for (const wait of [5_000, 10_000, 15_000, 15_000, 15_000]) {
      await vi.advanceTimersByTimeAsync(wait);
    }
    expect(dials.length).toBeGreaterThanOrEqual(6);
    expect(notices.join(' ')).not.toMatch(/stopped dialling/);
  });

  /* The rail draws it and the tab's dial acts on it, so it has to be told. */
  it('tells the host when a retry is armed and when it is called off', async () => {
    const reconnect = build();
    expect(changes).toBe(0);
    drop(reconnect, 60_000);
    expect(reconnect.pending).toBe(true);
    expect(changes).toBeGreaterThan(0);

    const armed = changes;
    reconnect.cancel();
    expect(reconnect.pending).toBe(false);
    expect(changes).toBeGreaterThan(armed);
  });

  it('releases its timer on dispose', async () => {
    const reconnect = build();
    drop(reconnect, 60_000);
    reconnect.dispose();
    expect(reconnect.pending).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dials).toHaveLength(0);
  });
});
