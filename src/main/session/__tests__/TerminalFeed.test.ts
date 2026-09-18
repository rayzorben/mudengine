import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ABANDON_MS,
  afterStyling,
  BARE_ENTER,
  PARTIAL_DELAY_MS,
  rawIndexOf,
  TerminalFeed,
  type Emitted,
  type FeedSource,
  type LineFacts
} from '../TerminalFeed';
import type { BatchBlock } from '../../parse/Classifier';
import type { Block } from '../../../shared/blocks';
import type { LineTerminator } from '../../../shared/types';
import { LineTokenizer, plainText } from '../../net/LineTokenizer';
import { PROMPT_REPAINT } from '../../net/stream-quirks';
import { STATUS_LINE } from '../../parse/patterns';
import type { BlockType } from '../../../shared/blocks';
import { DEFAULT_INTERNAL } from '../../../shared/internal';

const PROMPT_HOLD_MS = DEFAULT_INTERNAL.tuning.session.promptHoldMs;

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
  if (/^You gain \d+ experience\./.test(plain)) return 'user-gain-experience';
  return null;
}

/** Drives a feed the way `SessionManager` does: frame, classify, emit, tail. */
function harness(
  quiet: string[] = ['rm', 'l'],
  design?: FeedSource['design'],
  rewriting?: Pick<FeedSource, 'rewrites' | 'rewrite'>,
  facts: (plain: string, type: BlockType | null) => LineFacts | undefined = () => undefined
) {
  const released: Emitted[] = [];
  const tokenizer = new LineTokenizer();
  const feed = new TerminalFeed(
    {
      isQuiet: (word) => quiet.includes(word),
      isStatus: (plain) => STATUS_LINE.test(plain),
      now: () => Date.now(),
      // A design given is a design on: the two are one setting in the client.
      ...(design ? { design, designing: () => true } : {}),
      ...(rewriting ?? {})
    },
    (emitted) => released.push(emitted)
  );
  const painted: string[] = [];
  const publish = (framed: { text: string; terminator: LineTerminator }): void => {
    const plain = plainText(framed);
    const type = typeOf(plain);
    feed.line(framed.text, framed.terminator, plain, type, undefined, facts(plain, type));
  };
  const chunk = (text: string): string => {
    // As `SessionManager`'s data handler does, before the packet's lines.
    feed.arrived();
    for (const framed of tokenizer.push(text)) publish(framed);
    feed.partial(tokenizer.buffered);
    const out = feed.take();
    painted.push(out.text);
    return out.text;
  };
  const flush = (): string => {
    for (const framed of tokenizer.flush()) publish(framed);
    const out = feed.take();
    painted.push(out.text);
    return out.text;
  };
  return { feed, tokenizer, facts, chunk, flush, released, painted, shown: () => painted.join('') };
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

  /*
   * Sent in reply to a line, between it and the status line behind it in the
   * same packet: that status line was written before the `rm` existed, so it
   * cannot close the `rm`'s window. It did, and the `rm`'s own answer, next
   * on the wire, was painted (the smoke's *the console was never shown it*).
   */
  it('is not answered by the packet it was sent in the middle of', () => {
    let h: ReturnType<typeof harness> | null = null;
    h = harness(['rm', 'l'], undefined, undefined, (plain) => {
      if (/no exit/.test(plain)) h?.feed.sent('rm', 'automation');
      return undefined;
    });
    h.chunk(PROMPT);
    h.flush();
    const refused = 'There is no exit in that direction!\r\n' + PROMPT + '\r\n';
    // Everything in the packet was written before the `rm`, so all of it shows.
    expect(h.chunk(refused)).toBe(refused);
    expect(h.chunk('rm\r\nLocation: 1,2147\r\n\r\n')).toBe('');
    expect(h.chunk(PROMPT_REPAINT + PROMPT)).toBe(PROMPT_REPAINT + PROMPT);
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

/*
 * The client's own status line in the prompt's place (`ui.statline`): drawn
 * at the moment the prompt arrives, over exactly the prompt's bytes, with the
 * lead, the echo and the terminator painted as sent — and never twice, which
 * is what the hold on a half-arrived prompt is for.
 */
describe('a status line the client draws itself', () => {
  const DRAWN = '\x1b[0;1mHP 34/?\x1b[0m';
  const designer: FeedSource['design'] = (plain) => {
    const from = plain.length - plain.trimStart().length;
    const match = STATUS_LINE.exec(plain.slice(from));
    return match ? { rendered: DRAWN, from, to: from + match[0].length } : null;
  };

  it("paints its own line in the prompt's place, and the echo after it as sent", () => {
    const h = harness(['rm'], designer);
    // The newline before is kept, the prompt's own colour and text replaced —
    // the reset the server prints after it among them, because the state the
    // row ends in is the drawn line's.
    expect(h.chunk('\r\n' + PROMPT)).toBe('\r\n' + DRAWN);
    expect(h.chunk('n')).toBe('n');
    expect(h.flush()).toBe('');
  });

  it('draws a prompt that arrives whole with its terminator', () => {
    const h = harness(['rm'], designer);
    expect(h.chunk(PROMPT + PROMPT_REPAINT)).toBe(DRAWN + PROMPT_REPAINT);
  });

  /*
   * A template ending `…]: {cyan}` asks for what is typed next to be cyan, and
   * both realm families print `ESC[0m` a byte after the colon — GreaterMUD
   * (`orohost`, 2026-09-11) and Paradigm (`paramud`, same day) alike. Kept, it
   * landed on the design's ending and the echo came back in the default ink,
   * which is how the tag was reported as doing nothing.
   */
  it('leaves the colour a design ends in standing over the echo', () => {
    const ending = '\x1b[0;1mHP 34/?\x1b[0;36m';
    const h = harness(['rm'], (plain) => {
      const match = STATUS_LINE.exec(plain);
      return match ? { rendered: ending, from: 0, to: match[0].length } : null;
    });
    expect(h.chunk('\x1b[0;36m[HP=34/MA=12]:\x1b[0m')).toBe(ending);
    expect(h.chunk('n')).toBe('n');
  });

  it('holds a prompt split across two chunks and draws it once', () => {
    const h = harness(['rm'], designer);
    expect(h.chunk('\x1b[1;32m[HP=3')).toBe('');
    expect(h.chunk('4/MA=12]:\x1b[0m')).toBe(DRAWN);
    expect(h.released).toEqual([]);
  });

  it('paints a half-prompt as sent once the hold runs out, and finishes it raw', () => {
    const h = harness(['rm'], designer);
    expect(h.chunk('[HP=3')).toBe('');
    // The quiet window's short hold is not this hold: a prompt still opening
    // waits the measured span before the client gives up on the rest of it.
    vi.advanceTimersByTime(PARTIAL_DELAY_MS + 1);
    expect(h.released).toEqual([]);
    vi.advanceTimersByTime(PROMPT_HOLD_MS);
    expect(h.released.map((e) => e.text)).toEqual(['[HP=3']);
    expect(h.chunk('4/MA=12]:')).toBe('4/MA=12]:');
  });

  it('holds a prompt the server writes in two pieces a tenth of a second apart', () => {
    /*
     * The bearfather BBS's own shape (captures of 2026-09-09, 504 prompts):
     * everything up to `(Resting)` in one write, ` ]:` in the next, the two
     * 88–686ms apart. Painted raw at the forty-millisecond hold, every resting
     * prompt on that realm showed the realm's line in place of the design.
     */
    const h = harness(['rm'], designer);
    const first = '\x1b[0;36m[HP=40/40,MA=7/8,Exp=0,Need=2500,$=0,S= (Resting)';
    expect(h.chunk(first)).toBe('');
    vi.advanceTimersByTime(123);
    expect(h.released).toEqual([]);
    expect(h.chunk(' ]:')).toBe(DRAWN);
    expect(h.released).toEqual([]);
  });

  it('gives a prompt still opening the long wait inside a quiet window too', () => {
    const h = harness(['rm'], designer);
    h.chunk(PROMPT);
    h.flush();
    h.feed.sent('rm', 'automation');
    expect(h.chunk('rm\r\nLocation: 1,2147\r\n')).toBe('');
    expect(h.chunk(PROMPT_REPAINT + '\x1b[1;32m[HP=3')).toBe(PROMPT_REPAINT);
    vi.advanceTimersByTime(PARTIAL_DELAY_MS + 1);
    expect(h.released).toEqual([]);
    expect(h.chunk('4/MA=12]:\x1b[0m')).toBe(DRAWN);
  });

  it('holds a prompt cut between its bracket and its colon, and draws it once the colon lands', () => {
    const h = harness(['rm'], designer);
    expect(h.chunk('[HP=34/MA=12]')).toBe('');
    expect(h.chunk(':')).toBe(DRAWN);
    expect(h.released).toEqual([]);
  });

  it('draws a prompt the server leaves without a colon once the hold runs out', () => {
    const h = harness(['rm'], designer);
    expect(h.chunk('[HP=34/MA=12]')).toBe('');
    vi.advanceTimersByTime(PARTIAL_DELAY_MS + 1);
    expect(h.released.map((e) => e.text)).toEqual([DRAWN]);
    expect(h.chunk('n')).toBe('n');
  });

  it("paints the realm's line where the design declines", () => {
    const h = harness(['rm'], () => null);
    expect(h.chunk(PROMPT)).toBe(PROMPT);
  });

  it('still closes a quiet window on a drawn prompt', () => {
    const h = harness(['rm'], designer);
    h.chunk(PROMPT);
    h.flush();
    h.feed.sent('rm', 'automation');
    expect(h.chunk('rm\r\nLocation: 1,2147\r\n')).toBe('');
    expect(h.chunk(PROMPT_REPAINT + PROMPT)).toBe(PROMPT_REPAINT + DRAWN);
    expect(h.chunk('\r\nSomeone walks in.\r\n')).toBe('\r\nSomeone walks in.\r\n');
  });

  it('finds a plain character past the escapes the plain text lost', () => {
    const text = '\x1b[1;32m[HP=34]:\x1b[0m';
    expect(rawIndexOf(text, 0)).toBe(0);
    expect(rawIndexOf(text, 8)).toBe('\x1b[1;32m[HP=34]:'.length);
    expect(rawIndexOf(text, 99)).toBe(text.length);
  });

  it('steps past the styling after a prompt and stops at everything else', () => {
    // Every SGR in a run, and nothing that moves the cursor or ends the row.
    expect(afterStyling('\x1b[0m\x1b[1;32mn', 0)).toBe('\x1b[0m\x1b[1;32m'.length);
    expect(afterStyling('\x1b[0m' + PROMPT_REPAINT, 0)).toBe('\x1b[0m'.length);
    expect(afterStyling('n\x1b[0m', 0)).toBe(0);
    expect(afterStyling('', 0)).toBe(0);
  });
});

/*
 * A listing the client draws itself (`ui.rewrites`): withheld from its
 * header, drawn whole at the line that completes it, painted as sent where
 * the design declines or the server never finishes.
 */
describe('a listing the client draws itself', () => {
  const HEADER = 'You are carrying rope and grapple, 6 torch.\r\n';
  const KEYS = 'You have no keys.\r\n';
  const LOAD = 'Encumbrance: 100/4128 - None [2%]\r\n';
  const DRAWN_PACK = '\x1b[0mrope and grapple\x1b[0m\r\n\x1b[0m6 torch\x1b[0m\r\n';

  /**
   * The classifier's batch collector, as far as the feed sees it: a pack
   * listing opens on its header and closes on the status line; an
   * experience line is one block of its own.
   */
  function listing(
    rewrite: FeedSource['rewrite'],
    wants: (type: BlockType) => boolean = (type) => type === 'user-inventory'
  ) {
    let open: BlockType | null = null;
    let lines: string[] = [];
    const facts = (plain: string, type: BlockType | null): LineFacts => {
      const was = open;
      let closed: BatchBlock | undefined;
      if (open === null && /^You are carrying/.test(plain)) {
        open = 'user-inventory';
        lines = [plain];
      } else if (open !== null) {
        lines.push(plain);
        if (STATUS_LINE.test(plain.trimStart())) {
          closed = {
            seq: 1,
            at: 0,
            type: open,
            domain: 'session',
            groups: { items: 'rope and grapple, 6 torch' },
            rows: [{ items: 'rope and grapple, 6 torch' }],
            text: lines.join('\n'),
            terminator: 'newline',
            confidence: 1
          };
          open = null;
        }
      }
      const block: Block = {
        seq: 1,
        at: 0,
        type: type ?? 'unknown',
        domain: 'session',
        terminator: 'newline',
        groups: {},
        text: plain,
        confidence: 1
      };
      return { block, batchWas: was, batchNow: open, ...(closed ? { closed } : {}) };
    };
    const h = harness(['rm'], undefined, { rewrites: wants, rewrite }, facts);
    return h;
  }
  const drawPack: FeedSource['rewrite'] = (block) =>
    block.type === 'user-inventory'
      ? { text: DRAWN_PACK, marks: [{ offset: 0, mark: { label: 'x', inline: [] } }] }
      : null;

  it('withholds the listing from its header and draws it whole at the prompt', () => {
    const h = listing(drawPack);
    expect(h.chunk('i\r\n')).toBe('i\r\n');
    expect(h.chunk(HEADER + KEYS + LOAD)).toBe('');
    expect(h.chunk(PROMPT)).toBe('');
    // The idle flush frames the prompt, which completes the listing.
    expect(h.flush()).toBe(DRAWN_PACK + PROMPT);
    expect(h.released).toEqual([]);
  });

  it("keys the drawing's marks to where it lands in the chunk", () => {
    const h = listing(drawPack);
    h.chunk('i\r\n' + HEADER + KEYS + LOAD + PROMPT);
    h.feed.take();
    for (const framed of h.tokenizer.flush()) {
      h.feed.line(
        framed.text,
        framed.terminator,
        plainText(framed),
        'status-line',
        undefined,
        h.facts(plainText(framed), 'status-line')
      );
    }
    const out = h.feed.take();
    expect(out.text.startsWith(DRAWN_PACK)).toBe(true);
    expect(out.marks).toEqual([{ offset: 0, mark: { label: 'x', inline: [] } }]);
  });

  it("paints the realm's lines, in order, where the design declines", () => {
    const h = listing(() => null);
    expect(h.chunk(HEADER + KEYS + LOAD + PROMPT)).toBe('');
    expect(h.flush()).toBe(HEADER + KEYS + LOAD + PROMPT);
  });

  it('paints what was withheld once the server stalls past the bound', () => {
    const h = listing(drawPack);
    expect(h.chunk(HEADER + KEYS)).toBe('');
    vi.advanceTimersByTime(DEFAULT_INTERNAL.tuning.session.rewriteHoldMs + 1);
    expect(h.released.map((e) => e.text)).toEqual([HEADER + KEYS]);
    // The rest arrives raw: the listing was not drawn and is not drawn late.
    expect(h.chunk(LOAD + PROMPT)).toBe(LOAD + PROMPT);
    expect(h.flush()).toBe('');
  });

  it('keeps a line the server volunteered mid-listing, after the drawing', () => {
    const h = listing(drawPack);
    const bite = 'A rat bites you for 3 damage!\r\n';
    expect(h.chunk(HEADER + bite + KEYS + LOAD + PROMPT)).toBe('');
    expect(h.flush()).toBe(DRAWN_PACK + bite + PROMPT);
  });

  it('leaves a listing whose header was already painted as it was sent', () => {
    const h = listing(drawPack);
    // The header's head goes out as an unterminated tail before it is framed.
    expect(h.chunk('You are carr')).toBe('You are carr');
    expect(h.chunk('ying rope and grapple, 6 torch.\r\n' + KEYS)).toBe(
      'ying rope and grapple, 6 torch.\r\n' + KEYS
    );
    expect(h.chunk(LOAD + PROMPT)).toBe(LOAD + PROMPT);
  });

  it('draws one line in place of one block', () => {
    const h = listing(
      (block) =>
        block.type === 'user-gain-experience' ? { text: '+25 exp\r\n', marks: [] } : null,
      (type) => type === 'user-gain-experience'
    );
    expect(h.chunk('You gain 25 experience.\r\n')).toBe('+25 exp\r\n');
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
