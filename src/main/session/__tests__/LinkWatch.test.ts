import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LinkWatch } from '../LinkWatch';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { setTuning } from '../../app/tuning';
import { t } from '../../app/i18n';

/**
 * Asserted against the **shipped** fifteen seconds rather than a short number
 * injected for the test, for the reason `Reconnect.test.ts` gives: the schedule
 * somebody actually runs is the half worth pinning.
 */
const AFTER = DEFAULT_INTERNAL.tuning.reconnect.silentForMs;

/** What each hang-up had just said, in order. */
let dead: string[] = [];
let notices: string[] = [];

function build(): LinkWatch {
  return new LinkWatch({
    notice: (message) => notices.push(message),
    hangUp: () => dead.push(notices.at(-1) ?? '')
  });
}

/** The sentence for a reply owed `ms`, or for a prompt owed on the way in. */
function said(ms: number, owed: 'reply' | 'prompt' = 'reply'): string {
  const seconds = ms / 1000;
  return owed === 'reply'
    ? t('session.connection.deadLink', { seconds })
    : t('session.connection.loginStalled', { seconds });
}

beforeEach(() => {
  vi.useFakeTimers();
  dead = [];
  notices = [];
});

afterEach(() => {
  vi.useRealTimers();
  setTuning(DEFAULT_INTERNAL.tuning);
});

describe('LinkWatch', () => {
  it('calls a command that goes unanswered a dead link', () => {
    const watch = build();
    watch.noteSent();
    expect(watch.waiting).toBe(true);

    vi.advanceTimersByTime(AFTER - 1);
    expect(dead).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(dead).toEqual([said(AFTER)]);
    expect(watch.waiting).toBe(false);
  });

  it('is answered by any byte, not only by a reply to the command', () => {
    const watch = build();
    watch.noteSent();
    vi.advanceTimersByTime(AFTER - 1);
    // The unprompted status-line repaint this realm sends every thirty seconds
    // is as good an answer to "is anything there" as a reply would be.
    watch.noteReceived();
    vi.advanceTimersByTime(AFTER * 2);
    expect(dead).toEqual([]);
    expect(watch.waiting).toBe(false);
  });

  it('owes the deadline to the oldest unanswered command', () => {
    const watch = build();
    watch.noteSent();
    vi.advanceTimersByTime(AFTER - 1);
    // A character meditating every three seconds must not be able to hold a
    // dead link open for ever by sending into it.
    watch.noteSent();
    vi.advanceTimersByTime(1);
    expect(dead).toEqual([said(AFTER)]);
  });

  it('counts nothing until something is sent', () => {
    const watch = build();
    vi.advanceTimersByTime(AFTER * 4);
    expect(dead).toEqual([]);
    expect(watch.waiting).toBe(false);
  });

  it('is switched off by a zero threshold', () => {
    setTuning({
      ...DEFAULT_INTERNAL.tuning,
      reconnect: { ...DEFAULT_INTERNAL.tuning.reconnect, silentForMs: 0 }
    });
    const watch = build();
    watch.noteSent();
    expect(watch.waiting).toBe(false);
    vi.advanceTimersByTime(AFTER * 4);
    expect(dead).toEqual([]);
  });

  it('reads the threshold at each arm, so an edit reaches a running session', () => {
    const watch = build();
    setTuning({
      ...DEFAULT_INTERNAL.tuning,
      reconnect: { ...DEFAULT_INTERNAL.tuning.reconnect, silentForMs: 4_000 }
    });
    watch.noteSent();
    vi.advanceTimersByTime(4_000);
    expect(dead).toEqual([said(4_000)]);
  });

  it('owes nothing across a socket, and releases its timer', () => {
    const watch = build();
    watch.noteSent();
    watch.reset();
    vi.advanceTimersByTime(AFTER * 2);
    expect(dead).toEqual([]);

    watch.noteSent();
    watch.dispose();
    vi.advanceTimersByTime(AFTER * 2);
    expect(dead).toEqual([]);
  });

  it('says why before it hangs up, and says it once', () => {
    const watch = build();
    watch.noteSent();
    vi.advanceTimersByTime(AFTER * 2);
    expect(notices).toEqual([said(AFTER)]);
    expect(dead).toEqual([said(AFTER)]);
  });
});

/**
 * On the way in the realm owes its next prompt, and its echo of an answer is
 * not one. `logs/2026-10-06_00-27-14_rayzor.mudcap.jsonl`: the password went
 * out, `********` came back, and then nothing for seven hours.
 */
describe('LinkWatch on the way in', () => {
  it('calls a login that gets no further a dead link, however much was echoed', () => {
    const watch = build();
    watch.owePrompt();
    vi.advanceTimersByTime(AFTER - 1);
    watch.noteReceived();
    expect(dead).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(dead).toEqual([said(AFTER, 'prompt')]);
    expect(watch.waiting).toBe(false);
  });

  it('is paid by the next prompt', () => {
    const watch = build();
    watch.owePrompt();
    vi.advanceTimersByTime(AFTER - 1);
    watch.notePrompt();
    vi.advanceTimersByTime(AFTER * 2);
    expect(dead).toEqual([]);
    expect(watch.waiting).toBe(false);
  });

  it('times a prompt and a reply apart, and hangs up once for both', () => {
    const watch = build();
    watch.noteSent();
    watch.owePrompt();
    // The echo pays the reply and leaves the prompt owed.
    watch.noteReceived();
    expect(watch.waiting).toBe(true);
    watch.notePrompt();
    expect(watch.waiting).toBe(false);

    watch.noteSent();
    watch.owePrompt();
    // Nothing at all came back, so the reply, armed first, is the one named.
    vi.advanceTimersByTime(AFTER * 2);
    expect(dead).toEqual([said(AFTER)]);
    expect(notices).toEqual([said(AFTER)]);
  });

  it('owes no prompt across a socket, and none with a zero threshold', () => {
    const watch = build();
    watch.owePrompt();
    watch.reset();
    vi.advanceTimersByTime(AFTER * 2);
    expect(dead).toEqual([]);

    setTuning({
      ...DEFAULT_INTERNAL.tuning,
      reconnect: { ...DEFAULT_INTERNAL.tuning.reconnect, silentForMs: 0 }
    });
    watch.owePrompt();
    expect(watch.waiting).toBe(false);
  });
});
