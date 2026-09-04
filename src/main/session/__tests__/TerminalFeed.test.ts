import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ABANDON_MS,
  BARE_ENTER,
  PARTIAL_DELAY_MS,
  TerminalFeed,
  type Emitted
} from '../TerminalFeed';
import { LineTokenizer, plainText } from '../../net/LineTokenizer';
import { PROMPT_REPAINT } from '../../net/stream-quirks';
import { STATUS_LINE } from '../../parse/patterns';
import type { BlockType } from '../../../shared/blocks';

const PROMPT = '\x1b[1;32m[HP=34/MA=12]:\x1b[0m';

/**
 * A stand-in for the classifier: the handful of shapes these tests need,
 * typed the way the real rules would type them.
 */
function typeOf(plain: string): BlockType | null {
  if (STATUS_LINE.test(plain.trimStart())) return 'status-line';
  if (/^(rm|l|who|dance)$/.test(plain)) return 'command-echo';
  if (/^Location: \d+,\d+$/.test(plain)) return 'user-profile';
  if (/ bites you for \d+ damage!$/.test(plain)) return 'mob-hits';
  if (/^\S+ gossips: /.test(plain)) return 'conversation-gossip';
  return null;
}

/** Drives a feed the way `SessionManager` does: frame, classify, emit, tail. */
function harness(quiet: string[] = ['rm', 'l']) {
  const released: Emitted[] = [];
  const tokenizer = new LineTokenizer();
  const feed = new TerminalFeed(
    {
      isQuiet: (word) => quiet.includes(word),
      isStatus: (plain) => STATUS_LINE.test(plain),
      now: () => Date.now()
    },
    (emitted) => released.push(emitted)
  );
  const painted: string[] = [];
  const chunk = (text: string): string => {
    for (const framed of tokenizer.push(text)) {
      feed.line(framed.text, framed.terminator, plainText(framed), typeOf(plainText(framed)));
    }
    feed.partial(tokenizer.buffered);
    const out = feed.take();
    painted.push(out.text);
    return out.text;
  };
  const flush = (): string => {
    for (const framed of tokenizer.flush()) {
      feed.line(framed.text, framed.terminator, plainText(framed), typeOf(plainText(framed)));
    }
    const out = feed.take();
    painted.push(out.text);
    return out.text;
  };
  return { feed, chunk, flush, released, painted, shown: () => painted.join('') };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/*
 * The rule the whole design has to keep: outside a quiet window the terminal
 * sees every byte, in order, in the same call the bytes arrived in. Framing
 * added nothing and withheld nothing.
 */
describe('with nothing quiet in flight', () => {
  it('reproduces the stream byte for byte, chunk by chunk', () => {
    const h = harness();
    const stream = [
      'You are standing in a hall.\r\n',
      'Obvious exits: north, sou',
      'th\r\n\r\n' + PROMPT + PROMPT_REPAINT + PROMPT,
      'A giant rat bites you for 3 damage!\r\n'
    ];
    for (const piece of stream) expect(h.chunk(piece)).toBe(piece);
    expect(h.shown()).toBe(stream.join(''));
  });

  it('paints an unterminated prompt the moment it arrives', () => {
    const h = harness();
    expect(h.chunk(PROMPT)).toBe(PROMPT);
    // And not again when the idle flush frames it as a line.
    expect(h.flush()).toBe('');
  });

  it('never quietens what the player typed', () => {
    const h = harness();
    h.chunk(PROMPT);
    h.feed.sent('rm', 'user');
    expect(h.chunk('rm\r\nLocation: 1,2147\r\n')).toBe('rm\r\nLocation: 1,2147\r\n');
  });
});

describe('a quiet command', () => {
  it('withholds its echo and its answer, and shows the status line that ends it', () => {
    const h = harness();
    h.chunk(PROMPT);
    h.flush();
    h.feed.sent('rm', 'automation');
    expect(h.chunk('rm\r\n')).toBe('');
    expect(h.chunk('Location: 1,2147\r\n\r\n')).toBe('');
    // The repaint marker still reaches the terminal, then the new prompt.
    expect(h.chunk(PROMPT_REPAINT + PROMPT)).toBe(PROMPT_REPAINT + PROMPT);
    // And the window is closed: the next line is shown.
    expect(h.chunk('\r\nSomeone walks in.\r\n')).toBe('\r\nSomeone walks in.\r\n');
  });

  it('closes on a status line the idle flush frames later, not twice', () => {
    const h = harness();
    h.chunk(PROMPT);
    h.flush();
    h.feed.sent('rm', 'automation');
    h.feed.sent('l', 'automation');
    h.chunk('rm\r\nLocation: 1,2147\r\n');
    // The tail is the status line: recognised, the window for `rm` closes
    // and the prompt is painted at once...
    expect(h.chunk(PROMPT_REPAINT + PROMPT)).toBe(PROMPT_REPAINT + PROMPT);
    // ...and when the flush frames it, `l`'s window is still the next one,
    // not popped as though the prompt had acknowledged both.
    h.flush();
    expect(h.feed.quiet).toBe(true);
    expect(h.chunk('l\r\nA hall.\r\n')).toBe('');
  });

  /*
   * A monster attacking in the middle of `rm`'s answer is not the answer,
   * and it needs its own row: the withheld echo's newline was what would
   * have ended the prompt row.
   */
  it('lets a volunteered line through, on a row of its own', () => {
    const h = harness();
    h.chunk(PROMPT);
    h.flush();
    h.feed.sent('rm', 'automation');
    h.chunk('rm\r\n');
    expect(h.chunk('A giant rat bites you for 3 damage!\r\n')).toBe(
      '\r\nA giant rat bites you for 3 damage!\r\n'
    );
    expect(h.chunk('Location: 1,2147\r\n')).toBe('');
    expect(h.chunk('Bob gossips: hi\r\n')).toBe('Bob gossips: hi\r\n');
  });

  it('holds the unterminated tail briefly, then paints it if nothing ends it', () => {
    const h = harness();
    h.chunk(PROMPT);
    h.flush();
    h.feed.sent('l', 'automation');
    expect(h.chunk('l\r\nA hall with a')).toBe('');
    vi.advanceTimersByTime(PARTIAL_DELAY_MS + 1);
    expect(h.released.map((e) => e.text)).toEqual(['A hall with a']);
    // Its second half then finishes the line rather than being cut off.
    expect(h.chunk(' door.\r\n')).toBe(' door.\r\n');
  });

  it('does not paint a held tail twice when its terminator arrives in time', () => {
    const h = harness();
    h.chunk(PROMPT);
    h.flush();
    h.feed.sent('l', 'automation');
    h.chunk('l\r\nA hall');
    expect(h.chunk(' with a door.\r\n')).toBe('');
    vi.advanceTimersByTime(PARTIAL_DELAY_MS + 1);
    expect(h.released).toEqual([]);
  });

  it('writes a command off when nothing ever acknowledges it', () => {
    let now = 1_000;
    const feed = new TerminalFeed(
      { isQuiet: () => true, isStatus: () => false, now: () => now },
      () => {}
    );
    feed.sent('rm', 'automation');
    expect(feed.quiet).toBe(true);
    now += ABANDON_MS + 1;
    expect(feed.quiet).toBe(false);
  });

  /*
   * A server does not always acknowledge: a menu answers with no prompt, and
   * a fixture may answer nothing at all. The echo of the quiet command is
   * the server saying it has moved on to it, whatever came before.
   */
  it('moves up to a command the server echoes, past one it never acknowledged', () => {
    const h = harness();
    h.chunk(PROMPT);
    h.flush();
    h.feed.sent('dance', 'user');
    h.feed.sent('rm', 'automation');
    expect(h.feed.quiet).toBe(false);
    expect(h.chunk('rm\r\n')).toBe('');
    expect(h.chunk('Location: 1,2147\r\n')).toBe('');
  });

  it('is quiet only for the words the file names', () => {
    const h = harness(['rm']);
    h.chunk(PROMPT);
    h.flush();
    h.feed.sent('who', 'automation');
    expect(h.chunk('who\r\nCurrent adventurers:\r\n')).toBe('who\r\nCurrent adventurers:\r\n');
  });
});

/*
 * The client re-reads a room with a bare Enter rather than `l`, because a look
 * announces itself to everybody standing there. A command with no first word
 * has nothing to key the quiet list on, so it answers to `enter` — otherwise
 * the one housekeeping read a player might actually want silenced would be the
 * one they could not name.
 */
describe('the room, re-read without telling the room', () => {
  it('answers to `enter` in the quiet list', () => {
    const h = harness([BARE_ENTER]);
    h.chunk(PROMPT);
    h.flush();
    // No echo comes back for a bare Enter — only its answer.
    h.feed.sent('', 'automation');
    expect(h.chunk('A hall.\r\nObvious exits: north\r\n')).toBe('');
    expect(h.chunk(PROMPT_REPAINT + PROMPT)).toBe(PROMPT_REPAINT + PROMPT);
  });

  it('is shown like anything else when nobody asked for it to be quiet', () => {
    const h = harness(['rm']);
    h.chunk(PROMPT);
    h.flush();
    h.feed.sent('', 'automation');
    expect(h.chunk('A hall.\r\n')).toBe('A hall.\r\n');
  });

  /* The player's own Enter is never withheld — only what automation sends is
     ever quiet, and `SessionManager` does not report an empty typed line. */
  it('never withholds one the player pressed', () => {
    const h = harness([BARE_ENTER]);
    h.chunk(PROMPT);
    h.flush();
    h.feed.sent('', 'user');
    expect(h.chunk('A hall.\r\n')).toBe('A hall.\r\n');
  });
});

describe('marks', () => {
  it('records where a marked line starts in the chunk', () => {
    const h = harness();
    h.feed.line('Town\r\n', 'newline', 'Town', 'room-name');
    h.feed.line('General Store\r\n', 'newline', 'General Store', 'room-name', {
      icon: 'shop',
      label: 'a shop'
    });
    const out = h.feed.take();
    expect(out.text).toBe('Town\r\nGeneral Store\r\n');
    expect(out.marks).toEqual([{ offset: 6, mark: { icon: 'shop', label: 'a shop' } }]);
  });
});
