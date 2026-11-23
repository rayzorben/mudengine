/**
 * The phone shell's vocabulary: when it replaces the desktop layout, which
 * tabs it has, the commands its chips send, and how a line the server coloured
 * is cut into runs a chrome element can wear. See `mudengine-ui` › the phone shell.
 */

/** A small touch screen. A desktop window dragged narrow is not one, so a pointer is part of the question. */
export const PHONE_QUERY = '(max-width: 640px) and (pointer: coarse)';

/** `?phone=1` forces the shell on a desktop browser, `?phone=0` keeps the desktop layout on a phone. */
export function phoneWanted(search: string, matches: boolean): boolean {
  const asked = new URLSearchParams(search).get('phone');
  return asked === '1' ? true : asked === '0' ? false : matches;
}

export const PHONE_TABS = ['terminal', 'chat', 'pack', 'loops', 'map'] as const;
export type PhoneTab = (typeof PHONE_TABS)[number];

/** What the chips above the command field send: the realm's own words, so they stay in code. */
export const PHONE_CHIPS: readonly string[] = ['n', 'e', 's', 'w', 'u', 'd', 'look', 'rest', 'i'];

/** How much of a pool is left, 0 to 1, or null while either figure is unknown (never 0). */
export function fraction(value: number | null, max: number | null): number | null {
  if (value === null || max === null || max <= 0) return null;
  return Math.min(1, Math.max(0, value / max));
}

/** A tone a run wears, from the SGR colour the server chose. */
export type RunTone = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | null;

export interface Run {
  text: string;
  tone: RunTone;
  bold: boolean;
}

/** Black (30) is drawn as white: the console is black, and black text on it cannot be read. */
const TONES: readonly RunTone[] = [
  'white',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white'
];
const ESCAPE = /\x1b\[([0-9;]*)m/g;

/**
 * A line cut at each colour change. Only the sixteen colours and bold are
 * kept: a MUD sends nothing else, and a code this does not know leaves the
 * run as it was rather than guessing. Other escape sequences are dropped.
 */
export function runsOf(line: string): Run[] {
  const runs: Run[] = [];
  let tone: RunTone = null;
  let bold = false;
  let from = 0;
  const push = (to: number) => {
    const text = line.slice(from, to).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    if (text.length > 0) runs.push({ text, tone, bold });
  };
  for (const match of line.matchAll(ESCAPE)) {
    push(match.index);
    from = match.index + match[0].length;
    for (const code of (match[1] ?? '').split(';').map((part) => Number(part || 0))) {
      if (code === 0) {
        tone = null;
        bold = false;
      } else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) tone = null;
      else if (code >= 30 && code <= 37) tone = TONES[code - 30] ?? null;
      else if (code >= 90 && code <= 97) {
        tone = TONES[code - 90] ?? null;
        bold = true;
      }
    }
  }
  push(line.length);
  return runs;
}

/**
 * Under this share of the resting height, with a field focused, the bottom of the
 * window is covered. Gboard in portrait is about a third of a phone's height, so a
 * keyboard leaves about 0.66; the browser's own bars take a few percent.
 */
const KEYBOARD_SHARE = 0.8;

/** Whether a touch keyboard is up: a field has focus and the visible height has shrunk. */
export function keyboardUp(visible: number, resting: number, fieldFocused: boolean): boolean {
  return fieldFocused && visible < resting * KEYBOARD_SHARE;
}
