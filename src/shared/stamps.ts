/**
 * The time a status line reached the console, carried inside the painted text.
 *
 * A chunk carries a private OSC sequence holding its epoch ms where a status
 * line row gets its time, and one holding `-` where text overwrites a timed
 * row, so the backscroll, written from the same text, keeps the times too and
 * a replayed page draws what the live console did (todos 25, 27). A row the
 * client wrote about a decision of its own also names the decision's kind
 * after the time, for the console's gear (todo 119). xterm drops an OSC no
 * handler claims, so a console that does not read it shows nothing.
 * `mudengine-session` › *A status line's time rides in the painted text*.
 */
import { asDecisionKind, type DecisionKind } from './decisionSettings';
import type { StreamChunk } from './types';

/** The OSC number. Unassigned by xterm and by the terminals this family targets. */
export const STAMP_OSC = 7717;

const STAMP_OPEN = `\x1b]${STAMP_OSC};`;
/** A time's payload: epoch ms, then the decision the row reports where it names one. */
const TIMED = '(\\d+)(?:;([a-z-]+))?';
const STAMP = new RegExp(`\\x1b\\]${STAMP_OSC};(?:${TIMED}|-)\\x07`, 'g');
const TIMED_PAYLOAD = new RegExp(`^${TIMED}$`);
/** The payload that takes the time off the row it lands on. */
const CLEARED = '-';

/** What goes on a row at one offset: its time, or the end of the time it had. */
export type RowTime = 'time' | 'clear';

/** A painted chunk with where its rows' times go, before they are written into its text. */
export interface TimedChunk extends StreamChunk {
  /** Ascending offsets into `text`. Absent on a chunk that times no row. */
  times?: ReadonlyArray<{ offset: number; put: RowTime; decision?: DecisionKind }>;
}

/** What a stamp says about its row: its time and the decision written on it, or that it was cleared. */
export type RowStamp = { at: number; decision: DecisionKind | null } | 'clear';

/** The sequence for one instant, naming the decision the row is about where it is about one. */
export function stampOf(at: number, decision?: DecisionKind): string {
  return `${STAMP_OPEN}${Math.trunc(at)}${decision === undefined ? '' : `;${decision}`}\x07`;
}

/** The sequence that takes the time off the row it lands on. */
export function clearOf(): string {
  return `${STAMP_OPEN}${CLEARED}\x07`;
}

/**
 * The chunk as the console is sent it: each row time written in at its
 * offset as the chunk's `at` or a clear, and each mark moved past what went
 * in ahead of it. Where the times go is `TerminalFeed`'s choice (`RowTimes`).
 */
export function stampChunk(chunk: TimedChunk): StreamChunk {
  const { times, ...rest } = chunk;
  if (times === undefined || times.length === 0) return rest;
  const written = times.map((time) =>
    time.put === 'time' ? stampOf(chunk.at, time.decision) : clearOf()
  );
  let text = '';
  let from = 0;
  times.forEach(({ offset }, index) => {
    text += chunk.text.slice(from, offset) + written[index]!;
    from = offset;
  });
  text += chunk.text.slice(from);
  const shift = (offset: number): number =>
    times.reduce(
      (moved, time, index) => (time.offset <= offset ? moved + written[index]!.length : moved),
      offset
    );
  return {
    ...rest,
    text,
    ...(rest.marks ? { marks: rest.marks.map((m) => ({ ...m, offset: shift(m.offset) })) } : {})
  };
}

/** The last time or clear in `text`, for a reader that drops the text but keeps the row's time. */
export function lastStamp(text: string): string {
  return text.match(STAMP)?.at(-1) ?? '';
}

/** Where the text proper begins: past a stamp at its very front, else 0. */
export function afterStamp(text: string): number {
  if (!text.startsWith(STAMP_OPEN)) return 0;
  const end = text.indexOf('\x07', STAMP_OPEN.length);
  return end === -1 ? 0 : end + 1;
}

/** Painted text with every stamp taken out, for a reader that measures or matches it. */
export function unstamped(text: string): string {
  return text.includes(STAMP_OPEN) ? text.replace(STAMP, '') : text;
}

/** What an OSC payload says about its row, or null when it says nothing this client wrote. */
export function stampAt(payload: string): RowStamp | null {
  if (payload === CLEARED) return 'clear';
  const parts = TIMED_PAYLOAD.exec(payload);
  if (parts === null) return null;
  const at = Number(parts[1]);
  if (!Number.isSafeInteger(at)) return null;
  if (parts[2] === undefined) return { at, decision: null };
  const decision = asDecisionKind(parts[2]);
  return decision === null ? null : { at, decision };
}
