/**
 * The time a status line reached the console, carried inside the painted text.
 *
 * A chunk carries a private OSC sequence holding its epoch ms where a status
 * line row gets its time, and one holding `-` where text overwrites a timed
 * row, so the backscroll, written from the same text, keeps the times too and
 * a replayed page draws what the live console did (todos 25, 27). xterm drops
 * an OSC no handler claims, so a console that does not read it shows nothing.
 * `mudengine-session` › *A status line's time rides in the painted text*.
 */
import type { StreamChunk } from './types';

/** The OSC number. Unassigned by xterm and by the terminals this family targets. */
export const STAMP_OSC = 7717;

const STAMP_OPEN = `\x1b]${STAMP_OSC};`;
const STAMP = new RegExp(`\\x1b\\]${STAMP_OSC};(?:\\d+|-)\\x07`, 'g');
/** The payload that takes the time off the row it lands on. */
const CLEARED = '-';

/** What goes on a row at one offset: its time, or the end of the time it had. */
export type RowTime = 'time' | 'clear';

/** A painted chunk with where its rows' times go, before they are written into its text. */
export interface TimedChunk extends StreamChunk {
  /** Ascending offsets into `text`. Absent on a chunk that times no row. */
  times?: ReadonlyArray<{ offset: number; put: RowTime }>;
}

/** The sequence for one instant. */
export function stampOf(at: number): string {
  return `${STAMP_OPEN}${Math.trunc(at)}\x07`;
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
  const stamp = stampOf(chunk.at);
  let text = '';
  let from = 0;
  for (const { offset, put } of times) {
    text += chunk.text.slice(from, offset) + (put === 'time' ? stamp : clearOf());
    from = offset;
  }
  text += chunk.text.slice(from);
  const shift = (offset: number): number =>
    times.reduce(
      (moved, time) =>
        time.offset <= offset
          ? moved + (time.put === 'time' ? stamp.length : clearOf().length)
          : moved,
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

/** The epoch ms an OSC payload names, `clear` for a cleared row, or null when it is neither. */
export function stampAt(payload: string): number | 'clear' | null {
  if (payload === CLEARED) return 'clear';
  if (!/^\d+$/.test(payload)) return null;
  const at = Number(payload);
  return Number.isSafeInteger(at) ? at : null;
}
