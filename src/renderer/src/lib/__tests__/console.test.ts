import { describe, expect, it } from 'vitest';

import { consoleWriter, noticeSequence, type ConsoleTarget } from '../console';

/*
 * A notice used to open with an unconditional `\r\n`. That is right after a
 * prompt and wrong after another notice, and a loop starting raises three in a
 * row — so the client's own words came out double-spaced with the game's text
 * single-spaced around them.
 */
describe('a notice in the stream', () => {
  it('breaks the line first when the cursor is mid-line', () => {
    expect(noticeSequence('Walking 73 steps.', false)).toBe(
      '\r\n\x1b[36m│\x1b[0m \x1b[36mWalking 73 steps.\x1b[0m\r\n'
    );
  });

  it('does not, when a line has already ended', () => {
    expect(noticeSequence('Walking 73 steps.', true)).toBe(
      '\x1b[36m│\x1b[0m \x1b[36mWalking 73 steps.\x1b[0m\r\n'
    );
  });

  /*
   * The trailing break is what puts the *server's* next byte on a fresh line,
   * and the server is under no obligation to begin with one — so it cannot be
   * made conditional on something not known yet.
   */
  it('always ends its own line, so the server starts on a fresh one', () => {
    expect(noticeSequence('x', true).endsWith('\r\n')).toBe(true);
    expect(noticeSequence('x', false).endsWith('\r\n')).toBe(true);
  });

  /* Three in a row, which is what a loop starting raises, joined the way the
     terminal joins them: one row each and no blank between. */
  it('runs three notices onto three adjacent rows', () => {
    const written =
      noticeSequence('Looping Goblin caves: 10 stops.', false) +
      noticeSequence('Walking 73 steps to Huge Cave, Refuse Pit.', true) +
      noticeSequence('Started Goblin caves, and kept it.', true);
    // Strip the colour, count the rows: three, and the only leading break is
    // the one that got off the prompt.
    const rows = written.replace(/\x1b\[\d+m/g, '').split('\r\n');
    expect(rows).toEqual([
      '',
      '│ Looping Goblin caves: 10 stops.',
      '│ Walking 73 steps to Huge Cave, Refuse Pit.',
      '│ Started Goblin caves, and kept it.',
      ''
    ]);
  });

  /* The message is the server's-language part and is never touched. */
  it('writes the message through unaltered', () => {
    expect(noticeSequence('  spaced  ', true)).toContain('  spaced  ');
  });
});

/**
 * A terminal that parses on a later turn, which is the whole of what makes the
 * writer necessary. `write` records the bytes and queues the work; nothing
 * reaches the screen — and no callback fires — until `parse` runs, so a test
 * can put a chunk in the air and ask what happens to what arrives behind it.
 */
function fakeConsole(): {
  target: ConsoleTarget;
  written: string[];
  atLineStart: boolean;
  parse(): void;
} {
  const written: string[] = [];
  const pending: Array<() => void> = [];
  let screen = '';
  return {
    target: {
      write(data, parsed) {
        written.push(data);
        pending.push(() => {
          screen += data;
          parsed?.();
        });
      }
    },
    written,
    get atLineStart() {
      return screen === '' || screen.endsWith('\n');
    },
    /* Anything queued *while* parsing is parsed too: xterm drains its own
       queue, and a test that stopped at the first round would never see the
       write a flush's callback made. */
    parse() {
      for (let next = pending.shift(); next; next = pending.shift()) next();
    }
  };
}

describe('the one queue everything on the console goes through', () => {
  it('writes plain text straight through, in order and in the same turn', () => {
    const term = fakeConsole();
    const writer = consoleWriter(term.target);

    writer.write('one');
    writer.write('two');
    writer.write('three');

    expect(term.written).toEqual(['one', 'two', 'three']);
  });

  /*
   * The room name that landed inside the prompt above it. A marked line has to
   * wait for the parser before its marker can be taken, and the prompt that
   * followed it arrived two milliseconds later — ten of forty-four room blocks
   * in one recorded session had a chunk that close behind them. Written
   * straight to the terminal it overtook the line still waiting.
   */
  it('holds everything behind a flush that has not landed yet', () => {
    const term = fakeConsole();
    const writer = consoleWriter(term.target);

    writer.settled(() => term.target.write('Huge Cave, Refuse Pit'));
    writer.write('[HP=334/KAI=27]: ');

    // Only the flush's own empty write has gone out; the prompt is still held.
    expect(term.written).toEqual(['']);
    term.parse();
    expect(term.written).toEqual(['', 'Huge Cave, Refuse Pit', '[HP=334/KAI=27]: ']);
  });

  it('runs a settled act only once everything asked for before it has been parsed', () => {
    const term = fakeConsole();
    const writer = consoleWriter(term.target);
    let ran = false;

    writer.write('before');
    writer.settled(() => {
      ran = true;
    });

    expect(ran).toBe(false);
    term.parse();
    expect(ran).toBe(true);
  });

  /*
   * Three notices raised in one turn — which is what a loop starting does —
   * each deciding its leading break from the cursor. Without the queue all
   * three read the cursor as it stood after the prompt, so all three would
   * open with a break and two of them would be wrong.
   */
  it('lets each of three notices in one turn read the screen the previous one left', () => {
    const term = fakeConsole();
    const writer = consoleWriter(term.target);
    const reads: boolean[] = [];

    writer.write('[HP=334/KAI=27]: ');
    for (const message of ['Looping Goblin caves.', 'Walking 73 steps.', 'Started.']) {
      writer.settled(() => {
        const atLineStart = term.atLineStart;
        reads.push(atLineStart);
        term.target.write(noticeSequence(message, atLineStart));
      });
    }
    term.parse();

    expect(reads).toEqual([false, true, true]);
  });

  /*
   * A burst is a loop, not a stack. Fifty thousand chunks is more frames than
   * the runtime has if each finished write calls back into the pump — and a
   * burst is exactly what arrives when a character walks into a city.
   */
  it('writes a burst without a frame per chunk', () => {
    const term = fakeConsole();
    const writer = consoleWriter(term.target);

    for (let i = 0; i < 50_000; i += 1) writer.write(`chunk ${i}`);

    expect(term.written).toHaveLength(50_000);
    expect(term.written[49_999]).toBe('chunk 49999');
  });
});
