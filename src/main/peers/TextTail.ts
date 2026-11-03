/**
 * The last stretch of a terminal's text, kept for a remote controller who
 * opens it (todo 20261031-1156-01). Kept as the chunks painted, so a paint
 * costs its own length and not the whole tail's, and cut at a line start so
 * no colour or cursor sequence is handed over half-written.
 */
export class TextTail {
  private chunks: string[] = [];
  private length = 0;

  constructor(private readonly most: () => number) {}

  append(text: string): void {
    if (text.length === 0) return;
    this.chunks.push(text);
    this.length += text.length;
    const most = this.most();
    while (this.chunks.length > 1 && this.length - this.chunks[0]!.length >= most) {
      this.length -= this.chunks.shift()!.length;
    }
  }

  /** The tail, from the first whole line within `most` characters of its end. */
  text(): string {
    const whole = this.chunks.join('');
    if (whole.length <= this.most()) return whole;
    const cut = whole.slice(-this.most());
    const line = cut.indexOf('\n');
    return line < 0 ? '' : cut.slice(line + 1);
  }
}
