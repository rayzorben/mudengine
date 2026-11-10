import { describe, expect, it } from 'vitest';

import { LocalEcho } from '../localEcho';
import { stampOf } from '@shared/stamps';

const PROMPT = '\x1b[0;36m[HP=608/608,MA=98/100]:\x1b[0m';
const REPAINT = '\x1b[79D\x1b[K';

/**
 * The prompt row as a terminal leaves it, for the bytes these tests write:
 * printable text, `\b` as a cursor move, a repaint as a cleared row.
 */
function row(written: string): string {
  let cells: string[] = [];
  let at = 0;
  const plain = written.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;]*m/g, '');
  for (let i = 0; i < plain.length; i++) {
    if (plain.startsWith(REPAINT, i)) {
      cells = [];
      at = 0;
      i += REPAINT.length - 1;
    } else if (plain[i] === '\b') at = Math.max(0, at - 1);
    else {
      cells[at] = plain[i]!;
      at += 1;
    }
  }
  return cells.join('').trimEnd();
}

/** A console at a prompt, with what it has written so far. */
function atPrompt() {
  const echo = new LocalEcho();
  let screen = echo.arrived(PROMPT, true);
  return {
    echo,
    type: (data: string, now = 0) => (screen += echo.typed(data, now)),
    arrive: (text: string, prompt = false) => (screen += echo.arrived(text, prompt)),
    screen: () => screen
  };
}

describe('a key drawn before its echo', () => {
  it('is drawn at a prompt and not before one', () => {
    const echo = new LocalEcho();
    // Positive control: before any prompt nothing is drawn and the echo paints as sent.
    expect(echo.typed('l', 0)).toBe('');
    expect(echo.arrived('l', false)).toBe('l');
    echo.arrived(`\r\n${PROMPT}`, true);
    expect(echo.typed('l', 0)).toBe('l');
  });

  it('is never drawn twice: the echo is taken out of the chunk, bunched or split', () => {
    const c = atPrompt();
    for (const key of 'look') c.type(key);
    c.arrive('l');
    c.arrive('oo'); // two keys in one packet, as Festus's capture has them
    c.arrive('k');
    expect(row(c.screen())).toBe('[HP=608/608,MA=98/100]:look');
    // Positive control: the same row model shows a double when the echo is not taken out.
    expect(row(c.screen() + 'look')).toBe('[HP=608/608,MA=98/100]:looklook');
  });

  it('erases as the realm does, and takes the erase out of the echo', () => {
    const c = atPrompt();
    for (const key of ['l', 'o', 'x', '\x7f', 'o']) c.type(key);
    expect(row(c.screen())).toBe('[HP=608/608,MA=98/100]:loo');
    c.arrive('lox\b \bo');
    expect(row(c.screen())).toBe('[HP=608/608,MA=98/100]:loo');
  });

  it('passes the client stamps through while matching', () => {
    const c = atPrompt();
    c.type('l');
    expect(c.echo.arrived(`${stampOf(7)}l`, false)).toBe(stampOf(7));
  });
});

describe('a guess the realm does not confirm', () => {
  it('is taken back before a repaint, and the echo from the realm paints the row', () => {
    const c = atPrompt();
    c.type('l');
    c.arrive(`${REPAINT}${PROMPT}`, true);
    // The realm still echoes the key it holds, after the new prompt.
    c.arrive('l');
    expect(row(c.screen())).toBe('[HP=608/608,MA=98/100]:l');
    // That echo was not drawn here, so the rest of the line waits for the realm until the next prompt.
    expect(c.echo.typed('o', 0)).toBe('');
  });

  it('is taken back when the realm echoes something else, as a password prompt does', () => {
    const c = atPrompt();
    c.type('s');
    c.arrive('*');
    expect(row(c.screen())).toBe('[HP=608/608,MA=98/100]:*');
  });

  it('is taken back once it has waited the limit', () => {
    const echo = new LocalEcho();
    echo.arrived(PROMPT, true);
    echo.typed('l', 1000);
    expect(echo.expire(2499, 1500)).toBe('');
    expect(echo.expire(2500, 1500)).toBe('\b \b');
    expect(echo.oldest).toBeNull();
  });
});

describe('Enter', () => {
  it('stops drawing until the next prompt', () => {
    const c = atPrompt();
    c.type('n');
    c.type('\r');
    expect(c.echo.typed('e', 0)).toBe('');
    c.arrive('n\r\nA hall.\r\n');
    c.arrive('e');
    c.arrive(`\r\n${PROMPT}`, true);
    expect(c.echo.typed('w', 0)).toBe('w');
  });

  it('draws an erase over a key typed since a redraw, and goes on drawing after it', () => {
    const c = atPrompt();
    c.echo.reset();
    c.arrive(`${REPAINT}${PROMPT}`, true);
    // Positive control: nothing typed since the redraw, so the realm's line is unknown and the erase is its own.
    expect(c.echo.typed('\x7f', 0)).toBe('');
    c.arrive('\b \b');
    c.arrive(`${REPAINT}${PROMPT}`, true);
    for (const key of ['g', 'b', 'x', '\x7f', ' ']) c.type(key);
    c.arrive('gbx\b \b ');
    // Still drawing past the erase: the `h` is on the row before its echo, and once after it.
    c.type('h');
    expect(row(c.screen())).toBe('[HP=608/608,MA=98/100]:gb h');
    c.arrive('h');
    expect(row(c.screen())).toBe('[HP=608/608,MA=98/100]:gb h');
  });

  it('leaves an erase undrawn when the realm holds nothing to erase', () => {
    const c = atPrompt();
    c.type('\r');
    c.arrive(`\r\n${PROMPT}`, true);
    expect(c.echo.typed('\x7f', 0)).toBe('');
  });
});

describe('the echo round trip and the switch', () => {
  it('tells when each drawn key came back whole, with when it was drawn', () => {
    const heard: number[] = [];
    const echo = new LocalEcho((at) => heard.push(at));
    echo.arrived(PROMPT, true);
    echo.typed('l', 10);
    echo.typed('o', 20);
    echo.arrived('l', false);
    expect(heard).toEqual([10]);
    echo.arrived('o', false);
    expect(heard).toEqual([10, 20]);
  });

  it('forgets the line when a key is sent undrawn, and still takes out a drawn echo', () => {
    const echo = new LocalEcho();
    echo.arrived(PROMPT, true);
    expect(echo.typed('l', 0)).toBe('l');
    // Sent while off, as the hook sends it: forgotten, never typed, and the drawn `l` still waits for its echo.
    echo.forget();
    expect(echo.arrived('lo', false)).toBe('o');
    // The line is unknown now, so an erase is left to the realm even at the next prompt.
    echo.arrived(`\r\n${PROMPT}`, true);
    expect(echo.typed('\x7f', 0)).toBe('');
    expect(echo.typed('k', 0)).toBe('k');
  });
});
