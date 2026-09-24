/**
 * Reading the pack after a script was asked for something.
 *
 * A script's `giveitem` and `takeitem` print nothing that names the item
 * (`TextBlockPart.cs:132`): the sentence is the realm author's prose, so no
 * broadcast keeps the pack true across one and only a listing asked for
 * **after** the act can say what it did — told apart from anybody else's by
 * the command the server echoes before it. Shared by the quest run's handover
 * and the item errand's ask (todo 806), which ask the same question. See
 * `mudengine-automation` › *A handover is read off a listing asked for after it*.
 */
import { tuning } from '../app/tuning';

export interface PackCheck {
  /** When the act went out; null while it waits in the queue. */
  sentAt: number | null;
  /** When the first listing was asked for, which the whole wait is bounded from. */
  askingSince: number | null;
  /** When one was last asked for, and how many times the queue took one. */
  asked: number | null;
  askedTimes: number;
  /** Whether the asker's own listing has gone out, and whether it has been answered. */
  listSent: boolean;
  answered: boolean;
}

export const packCheck = (sentAt: number | null = null): PackCheck => ({
  sentAt,
  askingSince: null,
  asked: null,
  askedTimes: 0,
  listSent: false,
  answered: false
});

/**
 * `Commands.cs`' own long word for `i`. Nothing else in this client asks with
 * it — the entry probe, the deposit and a run's first read all send `i` — so
 * the server's echo of it names a listing asked for after an act, and only a
 * listing asked after one's own act is taken as its answer (`listSent`).
 */
export const AFTER_WORD = 'inventory';

/**
 * The pack as the act left it: `read` once a listing asked for after the act
 * has landed, `waiting` while one is owed — asked for through `ask`,
 * `quests.replyMs` apart, the one measurement of how long a listing takes —
 * and `unanswered` once `quests.listingAsks` of them went unanswered. The act
 * is the answer only once it is on the wire, so nothing is asked before; the
 * queue keeps the listing behind it, and the server answers in turn.
 */
export function packAfter(
  pack: PackCheck,
  now: number,
  ask: (onSent: () => void) => boolean
): 'read' | 'waiting' | 'unanswered' {
  if (pack.answered) return 'read';
  if (pack.sentAt === null) return 'waiting';
  const { replyMs, listingAsks } = tuning().quests;
  if (pack.asked !== null && now - pack.asked < replyMs) return 'waiting';
  // Counted in asks the queue took, and bounded in time from the first as
  // well: a queue that refuses every ask would otherwise count none of them.
  pack.askingSince ??= now;
  if (pack.askedTimes >= listingAsks || now - pack.askingSince > replyMs * listingAsks) {
    return 'unanswered';
  }
  // A refused enqueue is *not now*, never *never* (todo 113).
  if (!ask(() => void (pack.listSent = true))) return 'waiting';
  pack.asked = now;
  pack.askedTimes += 1;
  return 'waiting';
}

/**
 * A pack listing landed, answering the command the server echoed before it
 * (`SessionManager.answering`). Only the asker's own spelling, sent after its
 * act, is the answer: an `i` somebody else sent before the act can land after
 * the ask went out, and it lists the pack as it was.
 */
export function noteListing(pack: PackCheck | null, answering: string | null): void {
  if (pack === null || !pack.listSent) return;
  if (answering?.trim().toLowerCase() === AFTER_WORD) pack.answered = true;
}
