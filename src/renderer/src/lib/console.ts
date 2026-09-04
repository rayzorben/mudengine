/**
 * What reaches the console, and in what order.
 *
 * Two things, and they are the same subject read twice. The console is the
 * server's surface and a **notice** is the one thing the client puts on it —
 * a coloured gutter bar in the stream itself rather than floating chrome,
 * because the app speaks the game's visual language. And a notice, a marked
 * room name and the server's own bytes all reach one terminal, which parses
 * them on its own schedule, so **who writes next** is a decision as delicate
 * as where a notice breaks its line.
 *
 * Both are here rather than inline in `TerminalView` for the reason
 * `clipboardIntent` is its own function: a decision buried in a callback that
 * needs a canvas to observe is a decision nothing can test.
 */

/** The gutter bar and the ink, in one place so a notice cannot be drawn twice. */
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const BAR = '│';

/**
 * One notice, as the bytes to write.
 *
 * **The leading newline is conditional and the trailing one is not**, and the
 * asymmetry is the whole of it.
 *
 * A notice must start on a line of its own. Most of the time the cursor is
 * sitting at the end of a prompt — `[HP=334/KAI=27]:` — and gluing a gutter bar
 * onto it would put the client's words inside the server's line. So it opens
 * with a break. But a notice also *ends* its own line, so the next notice
 * already has one, and an unconditional break there spends a blank row on it.
 * A loop starting raises three in a row (*looping*, *walking*, *started*) and
 * they came out double-spaced with the game's own text single-spaced around
 * them: the chrome shouting by accident of a line ending.
 *
 * The trailing break stays unconditional. It is what puts the **server's** next
 * byte on a fresh line, and the server is under no obligation to begin with
 * one — so it cannot be made to depend on what comes next, which is not known
 * yet and may be a room description arriving mid-fight.
 */
export function noticeSequence(message: string, atLineStart: boolean): string {
  const lead = atLineStart ? '' : '\r\n';
  return `${lead}${CYAN}${BAR}${RESET} ${CYAN}${message}${RESET}\r\n`;
}

/** The part of a terminal a writer drives: bytes in, and a word when they land. */
export interface ConsoleTarget {
  write(data: string, parsed?: () => void): void;
}

/** Everything written to one console, in the order it was asked for. */
export interface ConsoleWriter {
  /** Append text. `parsed` is called once the terminal has read it. */
  write(text: string, parsed?: () => void): void;
  /**
   * Run `act` at the one moment the buffer answers for what is on screen:
   * everything queued before it has been parsed and nothing after it has been
   * written yet. Whatever `act` writes goes **straight to the terminal**, not
   * back through the writer — a write queued from here would land behind
   * whatever arrived while the flush was in the air, which is the very thing
   * this exists to prevent.
   */
  settled(act: () => void): void;
}

/**
 * The one queue everything on the console goes through.
 *
 * xterm parses on a later task: `write` puts bytes in its own queue and
 * returns, and the callback is what says they have been read. Anything that
 * needs to know *where on the screen* a line landed — a marker for a room's
 * name, the cursor column a notice decides its leading break from — therefore
 * has to wait for that callback. While it waits, the next chunk off the socket
 * calls `write` again and goes into xterm's queue **ahead** of the line still
 * waiting to be written.
 *
 * That is what put a room's name inside the prompt above it. A room block is
 * cut into segments so its name can be marked; the prompt that followed it
 * arrived two milliseconds later — ten of forty-four room blocks in one
 * recorded session had a chunk that close behind them — and the name was
 * painted after the prompt instead of over it, with the glyph and the buttons
 * measured for a column the text no longer started at. It showed only while
 * the *client* was driving, because xterm parses the first write after a
 * keystroke synchronously: walking a route showed it and walking by hand did
 * not.
 *
 * So there is one writer and everything funnels through it — chunk segments,
 * notices, the font warning, the reset between two characters. Plain text
 * costs nothing: it is queued and written in the same turn. Only the two
 * things that must read the screen pay for a flush.
 */
export function consoleWriter(term: ConsoleTarget): ConsoleWriter {
  const queue: Array<(done: () => void) => void> = [];
  /** A task is in the air, so nothing behind it may be written yet. */
  let busy = false;

  const pump = (): void => {
    if (busy) return;
    busy = true;
    for (let task = queue.shift(); task; task = queue.shift()) {
      /*
       * A task that finishes in the same turn — which is all a plain write
       * does — is dequeued by this loop rather than by calling back into
       * `pump`, so a burst of a thousand chunks costs a thousand iterations
       * and not a thousand stack frames.
       */
      let handed = false;
      let inTurn = true;
      task(() => {
        if (handed) return;
        handed = true;
        if (inTurn) return;
        busy = false;
        pump();
      });
      inTurn = false;
      if (!handed) return;
    }
    busy = false;
  };

  const push = (task: (done: () => void) => void): void => {
    queue.push(task);
    pump();
  };

  return {
    write: (text, parsed) =>
      push((done) => {
        term.write(text, parsed);
        done();
      }),
    settled: (act) =>
      push((done) => {
        term.write('', () => {
          act();
          done();
        });
      })
  };
}
