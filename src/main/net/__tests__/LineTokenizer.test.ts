import { describe, expect, it } from 'vitest';

import { LineTokenizer, plainText, stripAnsi } from '../LineTokenizer';
import { PROMPT_REPAINT } from '../stream-quirks';

/** Convenience: frame a whole string in one push. */
function frame(input: string): Array<[string, string]> {
  return new LineTokenizer().push(input).map((line) => [line.text, line.terminator]);
}

describe('LineTokenizer', () => {
  it('frames conventional CRLF lines', () => {
    expect(frame('one\r\ntwo\r\n')).toEqual([
      ['one\r\n', 'newline'],
      ['two\r\n', 'newline']
    ]);
  });

  it('frames a bare LF, which some servers still emit', () => {
    expect(frame('one\ntwo\n')).toEqual([
      ['one\n', 'newline'],
      ['two\n', 'newline']
    ]);
  });

  it('treats the prompt repaint as a terminator', () => {
    // The whole point: without this the prompt and everything after it arrive
    // as one unbroken line.
    const [first, second] = frame(`[HP=100/MA=50]:${PROMPT_REPAINT}You are in a room.\r\n`);
    expect(first).toEqual([`[HP=100/MA=50]:${PROMPT_REPAINT}`, 'repaint']);
    expect(second).toEqual(['You are in a room.\r\n', 'newline']);
  });

  it('keeps the repaint marker with the line it ends', () => {
    // Deliberate, and salvaged from the CoffeeScript client: a long `who`
    // listing is recognised as complete by its *terminating* marker, which only
    // works if the marker belongs to the line before it.
    const lines = new LineTokenizer().push(`Current Adventurers${PROMPT_REPAINT}`);
    expect(lines[0]?.text.endsWith(PROMPT_REPAINT)).toBe(true);
  });

  it('takes whichever terminator comes first', () => {
    expect(frame(`a\r\nb${PROMPT_REPAINT}c\r\n`).map(([, t]) => t)).toEqual([
      'newline',
      'repaint',
      'newline'
    ]);
    expect(frame(`a${PROMPT_REPAINT}b\r\n`).map(([, t]) => t)).toEqual(['repaint', 'newline']);
  });

  it('holds an unterminated tail back for the next chunk', () => {
    const tokenizer = new LineTokenizer();
    expect(tokenizer.push('partial')).toEqual([]);
    expect(tokenizer.push(' line\r\n')).toEqual([
      { text: 'partial line\r\n', terminator: 'newline' }
    ]);
  });

  it('reassembles a terminator split across chunks', () => {
    // The socket hands us arbitrary fragments; CR and LF routinely land in
    // different TCP segments under load.
    const tokenizer = new LineTokenizer();
    expect(tokenizer.push('text\r')).toEqual([]);
    expect(tokenizer.push('\nmore')).toEqual([{ text: 'text\r\n', terminator: 'newline' }]);
  });

  it('reassembles a prompt repaint split across chunks', () => {
    const tokenizer = new LineTokenizer();
    const half = PROMPT_REPAINT.slice(0, 4);
    const rest = PROMPT_REPAINT.slice(4);
    expect(tokenizer.push(`[HP=100]:${half}`)).toEqual([]);
    const lines = tokenizer.push(rest);
    expect(lines).toEqual([{ text: `[HP=100]:${PROMPT_REPAINT}`, terminator: 'repaint' }]);
  });

  it('ignores an empty chunk', () => {
    const tokenizer = new LineTokenizer();
    expect(tokenizer.push('')).toEqual([]);
    expect(tokenizer.buffered).toBe('');
  });

  it('emits empty lines rather than swallowing them', () => {
    // Blank lines are structural in this game's output: room description,
    // blank, exits.
    expect(frame('\r\n\r\n').length).toBe(2);
  });

  it('flushes a prompt that never gets a newline', () => {
    // The login prompt is exactly this: no terminator, ever, until the user
    // answers it.
    const tokenizer = new LineTokenizer();
    expect(tokenizer.push('Please enter your username or "new":')).toEqual([]);
    expect(tokenizer.flush()).toEqual([
      { text: 'Please enter your username or "new":', terminator: 'flush' }
    ]);
    expect(tokenizer.flush()).toEqual([]);
  });

  it('releases an absurdly long unterminated run rather than growing forever', () => {
    const tokenizer = new LineTokenizer();
    const lines = tokenizer.push('x'.repeat(64 * 1024 + 1));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.terminator).toBe('flush');
    expect(tokenizer.buffered).toBe('');
  });

  it('forgets buffered state on reset', () => {
    const tokenizer = new LineTokenizer();
    tokenizer.push('half a line');
    tokenizer.reset();
    expect(tokenizer.buffered).toBe('');
    expect(tokenizer.push('\r\n')).toEqual([{ text: '\r\n', terminator: 'newline' }]);
  });

  it('preserves ANSI in the framed text', () => {
    // Colour is carried alongside as a confidence signal for the parser; the
    // tokenizer must not throw it away.
    const lines = frame('\x1b[1;36mBright\x1b[0m\r\n');
    expect(lines[0]?.[0]).toContain('\x1b[1;36m');
  });
});

describe('stripAnsi', () => {
  it('removes SGR, cursor and erase sequences', () => {
    expect(stripAnsi('\x1b[1;36mA\x1b[0m\x1b[2J\x1b[K\x1b[79DB')).toBe('AB');
  });

  it('removes a two-character escape', () => {
    expect(stripAnsi('a\x1bcb')).toBe('ab');
  });

  it('leaves CP437-derived text alone', () => {
    expect(stripAnsi('░█▒ Obvious exits: north')).toBe('░█▒ Obvious exits: north');
  });
});

describe('plainText', () => {
  it('strips ANSI and the trailing terminator', () => {
    expect(
      plainText({ text: '\x1b[0;32mObvious exits: north\x1b[0m\r\n', terminator: 'newline' })
    ).toBe('Obvious exits: north');
  });

  it('strips the repaint marker along with the ANSI', () => {
    expect(plainText({ text: `[HP=100/MA=50]:${PROMPT_REPAINT}`, terminator: 'repaint' })).toBe(
      '[HP=100/MA=50]:'
    );
  });

  it('leaves interior whitespace alone, because columns are meaningful', () => {
    // The `who` list and the stat sheet are column-aligned; trimming inside a
    // line would break every pattern written against them.
    expect(
      plainText({ text: 'Name:   Rayzor      Lives/CP: 3/12\r\n', terminator: 'newline' })
    ).toBe('Name:   Rayzor      Lives/CP: 3/12');
  });
});
