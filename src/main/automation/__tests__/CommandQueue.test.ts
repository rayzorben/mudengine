import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
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

describe('the master switch', () => {
  it('drops automation when disabled but still passes the player through', () => {
    const off = make({ enabled: false });
    expect(off.enqueue({ command: 'st', priority: 'probe' })).toBe(false);
    expect(off.enqueue({ command: 'n', priority: 'user' })).toBe(true);
    expect(sent).toEqual(['n']);
    off.dispose();
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
