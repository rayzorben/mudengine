/**
 * The retained output of one session, so that attaching a terminal to it is
 * lossless.
 *
 * The terminal is a byte stream and xterm reconstructs its own state from one,
 * so "catch this terminal up" is just "write everything that has happened".
 * Keeping that in main rather than in a renderer is what makes three things
 * work: popping a tab out to its own window, popping it back, and reloading the
 * renderer during development without emptying a live connection.
 *
 * This is not the parser's line log. `SessionManager` keeps 500 framed lines
 * for the Stream card and for state replay; those are what a *parser* reads.
 * This is what a *terminal* draws, and it holds the escape sequences the
 * framing deliberately strips — including the in-place status-line repaint,
 * which replays correctly precisely because it is kept verbatim.
 */

/** Retained output per session. Roughly a screenful a second for half an hour. */
export const DEFAULT_BACKSCROLL_BYTES = 2 * 1024 * 1024;

export class Backscroll {
  private readonly chunks: { text: string; bytes: number }[] = [];
  private total = 0;

  constructor(private readonly maxBytes: number = DEFAULT_BACKSCROLL_BYTES) {}

  get bytes(): number {
    return this.total;
  }

  write(text: string): void {
    if (text.length === 0) return;
    const bytes = Buffer.byteLength(text, 'utf8');
    this.chunks.push({ text, bytes });
    this.total += bytes;
    this.trim();
  }

  /** Everything retained, oldest first, ready to be written to a terminal. */
  get text(): string {
    return this.chunks.map((chunk) => chunk.text).join('');
  }

  clear(): void {
    this.chunks.length = 0;
    this.total = 0;
  }

  /**
   * Drops whole chunks off the front, and slices the last one if it alone is
   * bigger than the whole budget.
   *
   * Two properties, in priority order.
   *
   * **The newest output is never dropped.** The cap protects memory; it must
   * not cost the live screen. An earlier version trimmed the surviving chunk
   * from its *start* to the first newline, which emptied the buffer whenever
   * one oversized chunk ended in a newline — losing exactly the output the
   * terminal was about to draw.
   *
   * **The replay begins at a line boundary.** A raw stream cut at an arbitrary
   * offset can resume halfway through an escape sequence, and writing that into
   * a fresh xterm spends the first visible line recovering from a control
   * sequence with no introducer. Advancing to just past the next newline costs
   * a few characters at the oldest edge and cannot produce a corrupt first
   * screen. If honouring the boundary would discard everything, the unaligned
   * tail is kept instead — see the first property.
   */
  private trim(): void {
    while (this.total > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.total -= dropped?.bytes ?? 0;
    }

    const first = this.chunks[0];
    if (!first || this.total <= this.maxBytes) return;

    const from = Math.min(this.total - this.maxBytes, first.text.length);
    const newline = first.text.indexOf('\n', from);
    const aligned = newline === -1 ? '' : first.text.slice(newline + 1);
    const kept = aligned.length > 0 ? aligned : first.text.slice(from);

    this.total -= first.bytes;
    if (kept.length === 0) {
      this.chunks.shift();
      return;
    }
    const bytes = Buffer.byteLength(kept, 'utf8');
    this.chunks[0] = { text: kept, bytes };
    this.total += bytes;
  }
}
