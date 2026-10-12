/**
 * The colour in effect at a point in the backscroll, as the SGR sequences that
 * set it, so a page cut there opens in the colour its first line was printed
 * in (todo 120). Read backwards from the cut to the last sequence that resets
 * (an empty or 0 parameter on its own: `ESC[m`, `ESC[0m`, `ESC[0;31m`): that one and
 * every one after it, in order. Within `tuning.records.colourLookBehind`
 * characters; none found is the default colour, ''.
 */
import { tuning } from '../app/tuning';

/** Any SGR: CSI, parameters of digits and `;`, then `m`. */
const SGR = /\x1b\[([0-9;]*)m/g;

/**
 * Whether a parameter list resets: an empty or 0 parameter standing on its
 * own, not the 0 inside a 256-colour or true-colour code (`38;5;0`, `48;2;0;0;0`).
 */
function resets(params: string): boolean {
  const list = params.split(';');
  for (let at = 0; at < list.length; at += 1) {
    const param = list[at]!;
    if (param === '' || Number(param) === 0) return true;
    if (param === '38' || param === '48' || param === '58') {
      if (list[at + 1] === '5') at += 2;
      else if (list[at + 1] === '2') at += 4;
    }
  }
  return false;
}

export function colourBefore(
  text: string,
  cut: number,
  lookBehind = tuning().records.colourLookBehind
): string {
  const from = Math.max(0, cut - lookBehind);
  const window = text.slice(from, cut);
  const found: Array<{ text: string; resets: boolean }> = [];
  for (const match of window.matchAll(SGR)) {
    found.push({ text: match[0], resets: resets(match[1] ?? '') });
  }
  let start = found.length;
  while (start > 0 && !found[start - 1]!.resets) start -= 1;
  // No reset in reach: what follows the window's first SGR is all that is known.
  if (start > 0) start -= 1;
  const sequences = found.slice(start).map((sgr) => sgr.text);
  // A reset alone is the default already: nothing to carry.
  const only = found[start];
  if (sequences.length === 1 && only?.resets === true && /^\x1b\[[0;]*m$/.test(only.text))
    return '';
  return sequences.join('');
}
