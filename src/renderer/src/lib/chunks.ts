/**
 * Text cut into pieces of at least `size` characters, each ending on a line's
 * end (the last excepted), so a restored backscroll is handed to the terminal
 * a slice at a time: xterm yields between writes and never inside one. A line
 * longer than `size` is one piece rather than cut, which keeps a sequence or
 * a surrogate pair whole.
 */
export function sliceLines(text: string, size: number): string[] {
  const pieces: string[] = [];
  const step = Math.max(1, Math.trunc(size));
  let at = 0;
  while (at < text.length) {
    if (text.length - at <= step) {
      pieces.push(text.slice(at));
      break;
    }
    const end = text.indexOf('\n', at + step - 1);
    const stop = end === -1 ? text.length : end + 1;
    pieces.push(text.slice(at, stop));
    at = stop;
  }
  return pieces;
}

/** Visible columns of a line as printed: escape sequences and the terminator aside. */
export function printedWidth(text: string): number {
  return text
    .replace(/\x1B\[[0-9;?]*[\x40-\x7E]|\x1B[\x30-\x7E]/g, '')
    .replace(/\r?\n$/, '')
    .replace(/\r$/, '').length;
}
