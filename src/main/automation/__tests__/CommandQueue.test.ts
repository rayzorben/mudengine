import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { MASKED_COMMAND } from '../../../shared/automation';
import { DEFAULT_CONFIG } from '../../../shared/config';
import type { AutomationConfig } from '../../../shared/config';

const base: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 2, minGapMs: 100, ackTimeoutMs: 1000 }
};

let sent: string[];
let queue: CommandQueue;

function make(overrides: Partial<AutomationConfig> = {}): CommandQueue {
  sent = [];
  return new CommandQueue({ ...base, ...overrides }, { send: (command) => sent.push(command) });
}

beforeEach(() => {
  vi.useFakeTimers();
  queue = make();
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

describe('pacing', () => {
  it('sends the first command immediately', () => {
    queue.enqueue({ command: 'exp', priority: 'probe' });
    expect(sent).toEqual(['exp']);
  });

  it('spaces sends by the minimum gap', () => {
    queue.enqueue({ command: 'a', priority: 'probe' });
    queue.enqueue({ command: 'b', priority: 'probe' });
    expect(sent).toEqual(['a']);

    vi.advanceTimersByTime(100);
    expect(sent).toEqual(['a', 'b']);
  });

  it('stops at the window and waits for acknowledgement', () => {
    // The measured reason this exists: the server accepts about twenty
    // commands in flight and silently discards the rest, with no complaint and
    // no disconnect. Exceeding the window loses commands undetectably.
    for (const command of ['a', 'b', 'c', 'd']) {
      queue.enqueue({ command, priority: 'probe' });
    }
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual(['a', 'b']);
  });

  it('releases another send when a prompt comes back', () => {
    for (const command of ['a', 'b', 'c']) queue.enqueue({ command, priority: 'probe' });
    vi.advanceTimersByTime(500);
    expect(sent).toHaveLength(2);

    queue.notePrompt();
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['a', 'b', 'c']);
  });

  it('reclaims credit when a command never produces a prompt', () => {
    // Not everything answers with a status line. Without this the window would
    // close permanently the first time one went unanswered.
    for (const command of ['a', 'b', 'c']) queue.enqueue({ command, priority: 'probe' });
    vi.advanceTimersByTime(500);
    expect(sent).toHaveLength(2);

    vi.advanceTimersByTime(1200);
    expect(sent).toEqual(['a', 'b', 'c']);
  });
});

describe('priority', () => {
  it('sends the highest priority first', () => {
    queue.enqueue({ command: 'idle', priority: 'idle' });
    queue.enqueue({ command: 'n', priority: 'emergency' });
    queue.enqueue({ command: 'attack', priority: 'combat' });

    // The first goes immediately; ordering shows on the ones that queue. The
    // third waits on an acknowledgement, because the window is two.
    vi.advanceTimersByTime(300);
    expect(sent).toEqual(['idle', 'n']);

    queue.notePrompt();
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['idle', 'n', 'attack']);
  });

  it('keeps insertion order within a priority band', () => {
    for (const command of ['a', 'b', 'c']) queue.enqueue({ command, priority: 'probe' });
    vi.advanceTimersByTime(200);
    queue.notePrompt();
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['a', 'b', 'c']);
  });
});

describe('coalescing', () => {
  it('collapses repeated requests for the same intent', () => {
    // One `st` is as good as two.
    queue.enqueue({ command: 'x', priority: 'probe' });
    expect(queue.enqueue({ command: 'st', priority: 'probe', coalesceKey: 'probe:st' })).toBe(true);
    expect(queue.enqueue({ command: 'st', priority: 'probe', coalesceKey: 'probe:st' })).toBe(
      false
    );

    vi.advanceTimersByTime(500);
    expect(sent.filter((c) => c === 'st')).toHaveLength(1);
  });

  it('does not collapse two identical commands with no coalesce key', () => {
    // The bug a text-matching de-duplicator causes: a second `n` is a different
    // move, and swallowing it strands a walk. Coalescing is by intent only.
    queue.enqueue({ command: 'n', priority: 'user' });
    queue.enqueue({ command: 'n', priority: 'user' });
    vi.advanceTimersByTime(300);
    expect(sent).toEqual(['n', 'n']);
  });

  it('raises a coalesced intent to the higher priority', () => {
    queue.enqueue({ command: 'x', priority: 'probe' });
    queue.enqueue({ command: 'look', priority: 'idle', coalesceKey: 'look' });
    queue.enqueue({ command: 'look', priority: 'combat', coalesceKey: 'look' });
    queue.enqueue({ command: 'other', priority: 'probe' });

    vi.advanceTimersByTime(200);
    expect(sent[1]).toBe('look');
  });
});

describe('cancellation', () => {
  it('drops queued intents that are no longer wanted', () => {
    // The reason a client-side queue exists: a sent command cannot be recalled,
    // so anything still queued is the only part of a plan still revisable.
    queue.enqueue({ command: 'a', priority: 'probe' });
    queue.enqueue({ command: 'walk-1', priority: 'idle' });
    queue.enqueue({ command: 'walk-2', priority: 'idle' });

    expect(queue.cancel((intent) => intent.priority === 'idle')).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual(['a']);
  });

  it('drops an intent that expired before it could be sent', () => {
    queue.enqueue({ command: 'a', priority: 'probe' });
    queue.enqueue({ command: 'stale', priority: 'idle', expiresAt: Date.now() + 50 });
    vi.advanceTimersByTime(400);
    expect(sent).toEqual(['a']);
  });

  it('refuses an intent that is already expired', () => {
    expect(queue.enqueue({ command: 'x', priority: 'idle', expiresAt: Date.now() - 1 })).toBe(
      false
    );
  });
});

describe('deferring to the player', () => {
  it('holds everything while a half-typed line is on the wire', () => {
    // The server buffers our bytes into the same input line as the player's
    // in-flight keystrokes: anything sent mid-line becomes `lpu thin kobold
    // thief`, which this server says out loud in the room. Captured live.
    queue.noteTyping(true);
    queue.enqueue({ command: 'idle', priority: 'idle' });
    expect(sent).toEqual([]);

    // However long they think mid-word — a timed grace released here, which
    // is exactly the corruption above.
    vi.advanceTimersByTime(5_000);
    expect(sent).toEqual([]);
  });

  it('sends the moment the line is committed', () => {
    queue.noteTyping(true);
    queue.enqueue({ command: 'attack', priority: 'combat' });
    expect(sent).toEqual([]);

    // Enter: the command comes immediately after, not a grace period later.
    queue.noteTyping(false);
    expect(sent).toEqual(['attack']);
  });

  it('writes an abandoned line off rather than staying silent for ever', () => {
    // Two characters typed and walked away must not silence the keep-alive
    // and recovery for the whole evening.
    queue.noteTyping(true);
    queue.enqueue({ command: 'idle', priority: 'idle' });
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(21_000);
    expect(sent).toEqual(['idle']);
  });

  it('lets an emergency through, committing the half-typed line first', () => {
    // An escape glued onto a half-typed `l` is `ln`, said out loud — the
    // escape never runs. So the player's line is committed first and the
    // move goes out clean behind it. The documented exception to the hold.
    const cleared: string[] = [];
    const q = new CommandQueue(base, {
      send: (command) => sent.push(command),
      clearTypedLine: () => {
        cleared.push('cleared');
        q.noteTyping(false);
      }
    });
    sent = [];
    q.noteTyping(true);
    q.enqueue({ command: 'n', priority: 'emergency' });
    expect(cleared).toEqual(['cleared']);
    expect(sent).toEqual(['n']);
    q.dispose();
  });

  it('holds even what the player asked for behind their own half-typed line', () => {
    // A login answer sent through a half-typed username corrupts both.
    queue.noteTyping(true);
    queue.enqueue({ command: 'guest', priority: 'user' });
    expect(sent).toEqual([]);
    queue.noteTyping(false);
    expect(sent).toEqual(['guest']);
  });
});

describe('a re-proposed intent', () => {
  it('keeps the later expiry when coalesced', () => {
    // A standing intent must not die of old age while the player's typing
    // holds the queue: the re-proposal says it still holds.
    queue.noteTyping(true);
    queue.enqueue({
      command: 'pu rat',
      priority: 'combat',
      coalesceKey: 'attack:rat',
      expiresAt: Date.now() + 1_000
    });
    vi.advanceTimersByTime(900);
    queue.enqueue({
      command: 'pu rat',
      priority: 'combat',
      coalesceKey: 'attack:rat',
      expiresAt: Date.now() + 1_000
    });
    vi.advanceTimersByTime(500);
    queue.noteTyping(false);
    expect(sent).toEqual(['pu rat']);
  });
});

/*
 * A word this realm does not have. An unrecognised command on this server
 * family is *said out loud in the room*, so sending one is not a wasted
 * command — it is a broadcast, and a probe on a clock is one per ask for the
 * evening.
 */
describe('a command the realm has no word for', () => {
  const withAnswer = (unavailable: (command: string) => boolean): CommandQueue => {
    sent = [];
    return new CommandQueue(base, { send: (command) => sent.push(command), unavailable });
  };

  it('is refused before it reaches the wire, and says it was', () => {
    const asked: string[] = [];
    const q = withAnswer((command) => {
      asked.push(command);
      return command === 'rm';
    });
    expect(q.enqueue({ command: 'rm', priority: 'probe' })).toBe(false);
    expect(q.enqueue({ command: 'st', priority: 'probe' })).toBe(true);
    expect(sent).toEqual(['st']);
    expect(asked).toEqual(['rm', 'st']);
    q.dispose();
  });

  /*
   * The player may be finding out, and they outrank automation everywhere else
   * in this class too. Nothing typed is ever held back on the client's opinion
   * of what the realm knows.
   */
  it('never refuses the person at the keyboard', () => {
    const q = withAnswer(() => true);
    expect(q.enqueue({ command: 'rm', priority: 'user' })).toBe(true);
    expect(sent).toEqual(['rm']);
    q.dispose();
  });

  /* No answerer at all is "the realm has every word", the behaviour before. */
  it('sends everything when nobody is answering', () => {
    queue.enqueue({ command: 'rm', priority: 'probe' });
    expect(sent).toEqual(['rm']);
  });
});

describe('the master switch', () => {
  it('drops automation when disabled but still passes the player through', () => {
    const off = make({ enabled: false });
    expect(off.enqueue({ command: 'st', priority: 'probe' })).toBe(false);
    expect(off.enqueue({ command: 'n', priority: 'user' })).toBe(true);
    expect(sent).toEqual(['n']);
    off.dispose();
  });

  /* The keep-alive serves the connection, not the character — see `keepsLink`. */
  it('passes the keep-alive, in its own band, and nothing else of automation’s', () => {
    const off = make({ enabled: false });
    expect(off.enqueue({ command: '', priority: 'idle', keepsLink: true })).toBe(true);
    expect(off.enqueue({ command: 'l', priority: 'idle' })).toBe(false);
    expect(sent).toEqual(['']);
    off.dispose();
  });
});

/*
 * 2026-09-18: a keep-alive every 45 seconds for seven hours into a socket
 * that had closed, each one filed as sent and reported unanswered.
 */
describe('a closed socket', () => {
  it('takes nothing and sends nothing until one is open again', () => {
    let open = true;
    sent = [];
    const gated = new CommandQueue(base, {
      send: (command) => sent.push(command),
      connected: () => open
    });
    expect(gated.enqueue({ command: 'st', priority: 'probe' })).toBe(true);
    open = false;
    expect(gated.enqueue({ command: '', priority: 'idle' })).toBe(false);
    expect(gated.enqueue({ command: 'n', priority: 'user' })).toBe(false);
    gated.notePrompt();
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual(['st']);
    open = true;
    expect(gated.enqueue({ command: 'i', priority: 'probe' })).toBe(true);
    expect(sent).toEqual(['st', 'i']);
    gated.dispose();
  });

  it('sends nothing already queued once the socket has gone', () => {
    let open = true;
    sent = [];
    const gated = new CommandQueue(base, {
      send: (command) => sent.push(command),
      connected: () => open
    });
    // The window is two: the third waits for a prompt's credit.
    for (const command of ['a', 'b', 'c']) gated.enqueue({ command, priority: 'probe' });
    vi.advanceTimersByTime(100);
    expect(sent).toEqual(['a', 'b']);
    open = false;
    gated.notePrompt();
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual(['a', 'b']);
    gated.dispose();
  });
});

describe('snapshot', () => {
  it('reports depth and what is waiting, for the decision trace', () => {
    queue.enqueue({ command: 'a', priority: 'probe', reason: 'entering the realm' });
    queue.enqueue({ command: 'b', priority: 'idle', reason: 'idle' });
    queue.enqueue({ command: 'c', priority: 'idle' });

    const snapshot = queue.snapshot;
    expect(snapshot.inFlight).toBe(1);
    expect(snapshot.depth).toBe(2);
    expect(snapshot.pending.map((p) => p.command)).toContain('b');
    expect(snapshot.pending.find((p) => p.command === 'b')?.reason).toBe('idle');
  });

  /*
   * The trace is drawn, not only written down.
   *
   * This snapshot is what the Automation card and the status rail show, and
   * `SessionManager` republishes it on every block — so a login answer waiting
   * out the typing hold or the pacing gap put the filled password on screen in
   * full until it drained. `reportable` never sees a pending intent.
   */
  it('masks a command carrying a credential while it waits', () => {
    queue.enqueue({ command: 'first', priority: 'probe' });
    queue.enqueue({ command: 'login vaelor hunter2', priority: 'user', secret: true });

    const pending = queue.snapshot.pending;
    expect(pending.map((intent) => intent.command)).not.toContain('login vaelor hunter2');
    expect(pending.at(-1)?.command).toMatch(/^•+$/);
    // Fixed width, so the length of what it hides is not recorded either.
    expect(pending.at(-1)?.command).toBe(MASKED_COMMAND);
  });
});

describe('the gap and what it is for', () => {
  it('does not pause before a command when nothing is outstanding', () => {
    /*
     * The gap stops commands stacking up on a server that is still working.
     * With nothing in flight the server is idle and waiting, so there is
     * nothing to stack and the pause is pure latency — which is what made the
     * login, a strict request/response exchange, slower than it needed to be.
     */
    queue.enqueue({ command: 'a', priority: 'probe' });
    expect(sent).toEqual(['a']);

    queue.notePrompt();
    queue.enqueue({ command: 'b', priority: 'probe' });
    expect(sent).toEqual(['a', 'b']);
  });

  it('still paces a burst, where commands would stack', () => {
    // Two enqueued at once: the second has something outstanding ahead of it.
    queue.enqueue({ command: 'a', priority: 'probe' });
    queue.enqueue({ command: 'b', priority: 'probe' });
    expect(sent).toEqual(['a']);

    vi.advanceTimersByTime(100);
    expect(sent).toEqual(['a', 'b']);
  });
});

/*
 * A command the server threw away — todo 02, reported 2026-09-06.
 *
 * `You fumble in confusion!` is `ActionFigure.CheckConfusion` discarding
 * whatever was sent at the top of `Player.HandleCommand`. Nothing acted on it,
 * so the decision that produced it still holds; the reported transcript shows
 * a loop's `e` fumbled, nothing re-sent, and the walk waiting out its
 * eight-second deadline and giving up.
 */
describe('putting back a command the realm threw away', () => {
  it('sends it again, after the delay the server imposes', () => {
    queue.enqueue({ command: 'e', priority: 'movement' });
    expect(sent).toEqual(['e']);

    expect(queue.resendLast('e')).toBe(true);
    // Not on the status line that follows the fumble: the character is inside
    // the server's own 1,000ms wait.
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(['e']);

    vi.advanceTimersByTime(600);
    expect(sent).toEqual(['e', 'e']);
  });

  /* A talk-box line's command is the player's, and a lost one breaks the path. */
  it('puts back one of a talk-box line’s commands, still the player’s', () => {
    queue.enqueue({ command: 's', priority: 'user', typed: true });
    expect(sent).toEqual(['s']);
    expect(queue.resendLast('s')).toBe(true);
    expect(queue.snapshot.pending).toEqual([
      expect.objectContaining({ command: 's', priority: 'user', typed: true })
    ]);
  });

  /*
   * The echo is the server's own statement of which command it is answering.
   * A mismatch means the fumbled one was not what this queue sent — the player
   * typed it — and replaying automation's last command instead would send a
   * move nobody asked for.
   */
  it('refuses when the fumbled command is not the one it sent', () => {
    queue.enqueue({ command: 'e', priority: 'movement' });
    expect(queue.resendLast('bank')).toBe(false);
    expect(queue.resendLast(null)).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual(['e']);
  });

  it('has nothing to put back before anything has been sent', () => {
    expect(queue.resendLast('e')).toBe(false);
  });

  /* Once per send: a second fumble re-arms it from the resend, so confusion
     eating four in a row is four resends and never a loop over one intent. */
  it('puts one command back once', () => {
    queue.enqueue({ command: 'e', priority: 'movement' });
    expect(queue.resendLast('e')).toBe(true);
    expect(queue.resendLast('e')).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual(['e', 'e']);
    // And the resend is itself resendable, which is what makes a run of
    // fumbles recoverable rather than one.
    expect(queue.resendLast('e')).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual(['e', 'e', 'e']);
  });

  /*
   * An escape must never queue behind a walk step serving out a confusion
   * delay: `drain` skips what is not due rather than waiting on it.
   */
  it('does not hold up anything else while it waits', () => {
    queue.enqueue({ command: 'e', priority: 'movement' });
    queue.notePrompt();
    expect(queue.resendLast('e')).toBe(true);

    queue.enqueue({ command: 'w', priority: 'emergency' });
    expect(sent).toEqual(['e', 'w']);
  });

  /*
   * It goes back at the head of its own band — it was decided before
   * everything now queued and keeps its `seq`, which is what says so — but
   * **only among what is due**. An intent that can go now is not held for a
   * second because this one is serving out the server's delay: that is the
   * same refusal that keeps an escape from queueing behind it, and holding the
   * whole queue on an intent nobody is waiting for is worse than reordering
   * two steps of one walk.
   */
  it('lets what is due go while it waits, rather than stalling the queue', () => {
    queue.enqueue({ command: 'e', priority: 'movement' });
    queue.notePrompt();
    expect(queue.resendLast('e')).toBe(true);
    queue.enqueue({ command: 'n', priority: 'movement' });
    queue.enqueue({ command: 's', priority: 'movement' });

    // Both of those are due and the resend is not, so both go first and the
    // resend follows when the server is listening again.
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual(['e', 'n', 's', 'e']);
  });

  /*
   * And **among what is due it keeps its place**, which is the half "at the
   * head" is about: it was decided before everything now queued, so its
   * original `seq` sorts it first. Shown with the queue held by the player's
   * typing, which is what lets the delay run out while nothing drains.
   */
  it('keeps its place among intents that are equally due', () => {
    queue.enqueue({ command: 'e', priority: 'movement' });
    queue.notePrompt();
    expect(queue.resendLast('e')).toBe(true);
    queue.noteTyping(true);
    vi.advanceTimersByTime(2000);
    queue.enqueue({ command: 'n', priority: 'movement' });
    expect(sent).toEqual(['e']);

    queue.noteTyping(false);
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['e', 'e', 'n']);
  });

  /*
   * Its deadline moves with it. An expiry measured against a send that never
   * ran would drop a command that was never given its chance.
   */
  it('carries its expiry past the delay rather than dying inside it', () => {
    queue.enqueue({ command: 'e', priority: 'movement', expiresAt: Date.now() + 200 });
    expect(queue.resendLast('e')).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual(['e', 'e']);
  });

  /*
   * What it remembers is bounded by the acknowledgement timeout **on the way
   * in**, not by the fumble that reads it back.
   *
   * The first cut trimmed only inside `resendLast`, which fires while a
   * character is confused and approximately never otherwise — so the list grew
   * one entry per automated command for the life of the session, each holding
   * the `onSent` closure a walk step captures. Roughly 29,000 of them over an
   * unattended night, with every leg walked reachable through them.
   */
  it('forgets a command old enough to have been answered', () => {
    queue.enqueue({ command: 'a', priority: 'probe' });
    vi.advanceTimersByTime(base.pacing.ackTimeoutMs + 200);
    queue.notePrompt();
    queue.enqueue({ command: 'b', priority: 'probe' });

    // `a` is older than the window the server answers in, so a fumble naming
    // it is answering something else entirely.
    expect(queue.resendLast('a')).toBe(false);
    expect(queue.resendLast('b')).toBe(true);
  });

  /* A socket that closed took the fight, the room and the reason with it. */
  it('forgets what it sent when the queue is cleared', () => {
    queue.enqueue({ command: 'e', priority: 'movement' });
    queue.clear();
    expect(queue.resendLast('e')).toBe(false);
  });
});

describe('a screen that is not the command prompt', () => {
  it('empties the queue and refuses everything, the player included', () => {
    queue.enqueue({ command: 'a', priority: 'probe' });
    queue.enqueue({ command: 'b', priority: 'probe' });
    expect(sent).toEqual(['a']);

    expect(queue.hold('the stat screen is up')).toBe(true);
    expect(queue.snapshot.depth).toBe(0);
    expect(queue.holding).toBe('the stat screen is up');

    // Not the escape hatch typing has: a field screen has no command line for
    // an emergency to be sent clean to, and the player's own toolbar press is
    // a command for the realm too.
    queue.enqueue({ command: 'n', priority: 'emergency' });
    queue.enqueue({ command: 'i', priority: 'user' });
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual(['a']);
  });

  it('is idempotent, so two independent arms announce once', () => {
    expect(queue.hold('you asked to train stats')).toBe(true);
    expect(queue.hold('the stat screen is up')).toBe(false);
    // The first reason stands: it is the one already said out loud.
    expect(queue.holding).toBe('you asked to train stats');
  });

  it('sends again once a prompt says there is a command line', () => {
    queue.hold('the stat screen is up');
    expect(queue.release()).toBe(true);
    expect(queue.release()).toBe(false);

    queue.enqueue({ command: 'rm', priority: 'probe' });
    expect(sent).toEqual(['rm']);
  });

  it('does not outlive the session it was holding for', () => {
    queue.hold('the stat screen is up');
    // What the socket closing, a reconnection and leaving the realm all call.
    queue.clear();
    expect(queue.holding).toBe(null);
    queue.enqueue({ command: 'rm', priority: 'probe' });
    expect(sent).toEqual(['rm']);
  });

  it('reads as standing down while it is up', () => {
    expect(queue.snapshot.suppressed).toBe(false);
    queue.hold('the stat screen is up');
    expect(queue.snapshot.suppressed).toBe(true);
    queue.release();
    expect(queue.snapshot.suppressed).toBe(false);
  });
});
