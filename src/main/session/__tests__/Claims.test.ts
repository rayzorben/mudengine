import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setTuning } from '../../app/tuning';
import { Claims } from '../Claims';
import { CommandQueue, type Intent } from '../../automation/CommandQueue';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { DEFAULT_INTERNAL } from '../../../shared/internal';

/** The queues a rig built, put down after each case. */
const queues: CommandQueue[] = [];

/**
 * A session's claims over a real queue, wired as the session wires it: the
 * realm's vocabulary answers the queue's `unavailable` (todo 767, so the
 * queue's own refusal is what `askWhereIAm` reports).
 */
function rig(options: { enabled?: boolean; connected?: boolean; unavailable?: boolean } = {}) {
  const vocabulary = { locateWord: 'rm' as string | null };
  const sent: Intent[] = [];
  const queue = new CommandQueue(
    { ...DEFAULT_CONFIG.automation, enabled: options.enabled ?? true },
    {
      send: (_command, intent) => void sent.push(intent),
      connected: () => options.connected ?? true,
      unavailable: () => options.unavailable ?? false
    }
  );
  queues.push(queue);
  const claims = new Claims(
    {
      tracker: {
        takeSettledByLocate: () => [],
        staleProbe: () => null,
        expireStaleClaims: () => [],
        pendingMoves: 0,
        locateRefused: () => []
      },
      queue,
      combat: { noteMovePending: () => undefined },
      vocabulary
    },
    { notice: () => undefined }
  );
  return { claims, queue, sent, vocabulary };
}

describe('Claims.askWhereIAm', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    setTuning(DEFAULT_INTERNAL.tuning);
  });
  afterEach(() => {
    for (const queue of queues.splice(0)) queue.dispose();
    vi.useRealTimers();
    setTuning(DEFAULT_INTERNAL.tuning);
  });

  it('answers with the word it asked, expiring on the tuning’s clock (todo 762)', () => {
    setTuning({
      ...DEFAULT_INTERNAL.tuning,
      session: { ...DEFAULT_INTERNAL.tuning.session, locateExpiresMs: 7_000 }
    });
    const { claims, sent } = rig();
    expect(claims.askWhereIAm()).toEqual({ asked: 'rm' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ command: 'rm', coalesceKey: 'loop-locate' });
    expect(sent[0]?.expiresAt).toBe(1_000_000 + 7_000);
  });

  // Two askers, one question: the second joins the ask still waiting, and it is asked.
  it('answers asked when it joins the same ask still waiting for credit', () => {
    const { claims, queue, sent } = rig();
    for (let spent = 0; spent < DEFAULT_CONFIG.automation.pacing.window; spent += 1) {
      queue.enqueue({ command: 'st', priority: 'probe' });
    }
    expect(claims.askWhereIAm()).toEqual({ asked: 'rm' });
    expect(claims.askWhereIAm()).toEqual({ asked: 'rm' });
    const waiting = queue.snapshot.pending.filter((intent) => intent.command === 'rm');
    expect(waiting).toHaveLength(1);
    expect(sent.every((intent) => intent.command === 'st')).toBe(true);
  });

  /*
   * Todo 762: a word the queue refused as one this realm lacks was reported as
   * asked, so `Locating` waited out its window and then said *Asked the realm
   * where you are with “rm”* about a command that never left.
   */
  it('answers unavailable when the queue refused the word as one this realm lacks', () => {
    const { claims, sent } = rig({ unavailable: true });
    expect(claims.askWhereIAm()).toEqual({ refused: 'unavailable' });
    expect(sent).toEqual([]);
  });

  it('answers unavailable, offering nothing, where the realm has no word', () => {
    const { claims, queue, vocabulary } = rig();
    vocabulary.locateWord = null;
    const offer = vi.spyOn(queue, 'offer');
    expect(claims.askWhereIAm()).toEqual({ refused: 'unavailable' });
    expect(offer).not.toHaveBeenCalled();
  });

  /*
   * Todo 767: automation off, a held screen or no socket, and the queue sent
   * nothing, yet the ask answered with the word as if it had gone, so
   * `Locating` waited out its window and the Room card's press said nothing.
   * The first case above is the positive control: the same ask, sent.
   */
  it('answers why the queue sent nothing: switched off, held, or no socket', () => {
    const off = rig({ enabled: false });
    expect(off.claims.askWhereIAm()).toEqual({ refused: 'switched-off' });
    expect(off.sent).toEqual([]);

    const held = rig();
    held.queue.hold('the stat screen');
    expect(held.claims.askWhereIAm()).toEqual({ refused: 'held' });
    expect(held.sent).toEqual([]);

    const offline = rig({ connected: false });
    expect(offline.claims.askWhereIAm()).toEqual({ refused: 'offline' });
    expect(offline.sent).toEqual([]);
  });
});
