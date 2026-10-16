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
 * A marked line carries its id the same way, in `LINE_OSC` (todo 143).
 * `mudengine-session` › *A status line's time rides in the painted text*.
 */
import { asDecisionKind, type DecisionKind } from './decisionSettings';
import type { LineId, StreamChunk } from './types';

/** The OSC number. Unassigned by xterm and by the terminals this family targets. */
export const STAMP_OSC = 7717;
/** The OSC that opens a marked line with its id, beside `STAMP_OSC`. */
export const LINE_OSC = 7718;
const LINE_OPEN = `\x1b]${LINE_OSC};`;
const LINE_STAMP = new RegExp(`\\x1b\\]${LINE_OSC};([0-9a-z]+\\.[0-9a-z]+)\\x07`, 'g');
/** A line id: when its book was opened, then its count, both base 36 (`MarkBook`). */
const LINE_ID = /^[0-9a-z]+\.[0-9a-z]+$/;

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
  /** Ascending offsets of the marked lines' starts, with their ids. Absent on a chunk with none. */
  lines?: ReadonlyArray<{ offset: number; id: LineId }>;
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
 * offset as the chunk's `at` or a clear, and each marked line's id at its
 * start. Where the times go is `TerminalFeed`'s choice (`RowTimes`); what the
 * lines are marked with is the host's to add (`MarkBook.painted`).
 */
export function stampChunk(chunk: TimedChunk): StreamChunk {
  const { times, lines, ...rest } = chunk;
  const written = [
    ...(lines ?? []).map(({ offset, id }) => ({ offset, text: lineIdOf(id) })),
    ...(times ?? []).map((time) => ({
      offset: time.offset,
      text: time.put === 'time' ? stampOf(chunk.at, time.decision) : clearOf()
    }))
  ].sort((a, b) => a.offset - b.offset);
  if (written.length === 0) return rest;
  let text = '';
  let from = 0;
  for (const { offset, text: put } of written) {
    text += chunk.text.slice(from, offset) + put;
    from = offset;
  }
  return { ...rest, text: text + chunk.text.slice(from) };
}

/** The sequence that opens a marked line with its id. */
export function lineIdOf(id: LineId): string {
  return `${LINE_OPEN}${id}\x07`;
}

/** The id a `LINE_OSC` payload names, or null when it is not one this client wrote. */
export function lineIdAt(payload: string): LineId | null {
  return LINE_ID.test(payload) ? payload : null;
}

/** Every line id in painted text, in order. */
export function lineIdsIn(text: string): LineId[] {
  if (!text.includes(LINE_OPEN)) return [];
  return [...text.matchAll(LINE_STAMP)].map((found) => found[1]!);
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

/** Painted text with every stamp and line id taken out, for a reader that measures or matches it. */
export function unstamped(text: string): string {
  const untimed = text.includes(STAMP_OPEN) ? text.replace(STAMP, '') : text;
  return untimed.includes(LINE_OPEN) ? untimed.replace(LINE_STAMP, '') : untimed;
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
