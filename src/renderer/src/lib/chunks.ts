import type { StreamChunk, TerminalMark } from '@shared/types';

/** One run of a chunk to write on its own, marked or not. */
export interface Segment {
  text: string;
  mark?: TerminalMark;
}

/**
 * The chunk as segments, so each marked line can be written and marked alone.
 *
 * A mark names the offset a line starts at; the segment runs to the end of
 * that line, terminator included, so the marker the writer registers before
 * it sits on the row the line lands on and the write after it starts on the
 * next. A chunk with no marks is one segment — the ordinary case, and the
 * one that must cost nothing.
 */
export function splitMarks(chunk: StreamChunk): Segment[] {
  const marks = chunk.marks ?? [];
  if (marks.length === 0) return [{ text: chunk.text }];
  const segments: Segment[] = [];
  let at = 0;
  for (const { offset, mark } of marks) {
    if (offset < at || offset >= chunk.text.length) continue;
    if (offset > at) segments.push({ text: chunk.text.slice(at, offset) });
    const end = chunk.text.indexOf('\n', offset);
    const stop = end === -1 ? chunk.text.length : end + 1;
    segments.push({ text: chunk.text.slice(offset, stop), mark });
    at = stop;
  }
  if (at < chunk.text.length) segments.push({ text: chunk.text.slice(at) });
  return segments;
}

/** Visible columns of a line as printed: escape sequences and the terminator aside. */
export function printedWidth(text: string): number {
  return text
    .replace(/\x1B\[[0-9;?]*[\x40-\x7E]|\x1B[\x30-\x7E]/g, '')
    .replace(/\r?\n$/, '')
    .replace(/\r$/, '').length;
}
