/**
 * The time a block reached the console, carried inside the painted text.
 *
 * Each pushed chunk carries a private OSC sequence holding its epoch ms, so
 * the backscroll, written from the same text, keeps the time too, and a
 * replayed page draws the same times the live console did (todo 25). xterm
 * drops an OSC no handler claims, so a console that does not read it shows
 * nothing. `mudengine-session` › *A block's time rides in the painted text*.
 */
import type { StreamChunk } from './types';

/** The OSC number. Unassigned by xterm and by the terminals this family targets. */
export const STAMP_OSC = 7717;

const STAMP_OPEN = `\x1b]${STAMP_OSC};`;
const STAMP = new RegExp(`\\x1b\\]${STAMP_OSC};\\d+\\x07`, 'g');
const LEADING_BREAKS = /^[\r\n]+/;

/** The sequence for one instant. */
export function stampOf(at: number): string {
  return `${STAMP_OPEN}${Math.trunc(at)}\x07`;
}

/**
 * The chunk with its time on the row its text begins on, each later mark moved
 * past it. A reply opens with the line break ending the prompt and echo row;
 * stamped before it, every reply would move that row's time off the moment
 * the command went out, so the stamp goes after the breaks when text follows.
 */
export function stampChunk(chunk: StreamChunk): StreamChunk {
  const stamp = stampOf(chunk.at);
  const breaks = LEADING_BREAKS.exec(chunk.text)?.[0].length ?? 0;
  const at = breaks < chunk.text.length ? breaks : 0;
  return {
    ...chunk,
    text: chunk.text.slice(0, at) + stamp + chunk.text.slice(at),
    ...(chunk.marks
      ? {
          marks: chunk.marks.map((m) =>
            m.offset >= at ? { ...m, offset: m.offset + stamp.length } : m
          )
        }
      : {})
  };
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

/** The epoch ms an OSC payload names, or null when it is not a time. */
export function stampAt(payload: string): number | null {
  if (!/^\d+$/.test(payload)) return null;
  const at = Number(payload);
  return Number.isSafeInteger(at) ? at : null;
}
