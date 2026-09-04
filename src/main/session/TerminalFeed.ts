/**
 * What the terminal is shown, decided line by line.
 *
 * The terminal used to be fed raw chunks, ahead of and independent of the
 * parser, so that nothing downstream could ever delay a paint. That rule is
 * kept — and this is what it cost to keep it while also being able to
 * *withhold* a line: the terminal is now fed **framed lines**, each one
 * emitted in the same call that framed it, with the unterminated tail
 * forwarded as it arrives. The tokenizer keeps the terminator attached to the
 * line it ends, so concatenating what this emits reproduces the stream byte
 * for byte, in-place status repaints included. Paints are line-granular; a
 * line is painted the moment its terminator arrives, which is the same
 * moment it used to be painted, because the terminator and the line came in
 * the same chunk. See docs/game-behaviour.md and TODO.md, "hideable input and
 * output", for the design this implements.
 *
 * **Why a line can be withheld at all.** The client sends housekeeping on its
 * own behalf — `rm` on every arrival so the map knows where it is, the idle
 * `l` every forty-five seconds — and the answer to each is a screenful nobody
 * asked to read. The server answers commands in the order they were sent and
 * acknowledges each with a status line, so the feed keeps a FIFO of what was
 * sent and whether it was quiet: while the head of the queue is a quiet
 * command, its echo and its answer are withheld; the status line that
 * acknowledges it pops the queue and is always shown, because it is the
 * repaint the terminal's prompt row depends on.
 *
 * Three things a quiet window never withholds:
 *
 * - **Anything the server volunteered.** A monster walking in, somebody
 *   talking, an attack: those arrive in the middle of an answer because that
 *   is when they happened, and they are not the answer. Told apart by block
 *   type (`VOLUNTEERED`), which is why classification is on this path now.
 * - **The repaint marker.** A withheld line that ends in `ESC[79D ESC[K`
 *   still emits the marker, or the prompt row would never be erased and the
 *   next status line would be painted over the old one.
 * - **Anything already painted.** The unterminated tail is forwarded as it
 *   arrives outside a window and held for `PARTIAL_DELAY_MS` inside one; a
 *   line whose head was already forwarded is finished rather than cut off,
 *   because xterm has no "unprint".
 *
 * Only what automation sends is ever quiet. The player's own `l` is a thing
 * they asked to see.
 */
import { stripAnsi } from '../net/LineTokenizer';
import { PROMPT_REPAINT } from '../net/stream-quirks';
import type { BlockType } from '../../shared/blocks';
import type { LineTerminator, TerminalMark } from '../../shared/types';

/**
 * How long an unterminated tail is held inside a quiet window before it is
 * forwarded anyway.
 *
 * Inside a window the tail is most likely the start of a line that will be
 * withheld once its terminator arrives; forwarding it at once would paint the
 * first half of a line the second half then cannot take back. Outside a
 * window there is no hold at all — a prompt, which is the one line that never
 * gets a terminator, is painted the moment its bytes arrive, exactly as
 * before. This is the whole latency cost of the design, and it is paid only
 * while the client is talking to the server on its own behalf.
 */
export const PARTIAL_DELAY_MS = 40;

/**
 * How long a sent command waits for its acknowledgement before it is written
 * off.
 *
 * Short, because the failure it bounds is the console going dark: a quiet
 * command the server never acknowledges — a menu, a lagged link, a server
 * that has stopped answering — would otherwise withhold everything after it.
 * The realm answers a command in a round trip, so two seconds is ten times
 * the ordinary case and a small fraction of the evening.
 */
export const ABANDON_MS = 2_000;

/**
 * The word a bare Enter answers to in `terminal.quiet.commands`.
 *
 * The client re-reads the room by sending nothing but the terminator
 * (`REREAD_ROOM`), because `l` announces `<name> is looking around the room.`
 * to everybody present. A command with no first word cannot be named in the
 * quiet list by its first word, and a housekeeping read nobody can silence is
 * exactly the reachability problem the quiet list exists to solve — so it is
 * named by this instead. Not a spelling the realm has: nothing sends it, it is
 * only ever matched against.
 */
export const BARE_ENTER = 'enter';

/**
 * Block types the server volunteers rather than answers with.
 *
 * Shown inside a quiet window because they are not the answer to anything.
 * Kept narrow on purpose: a type left out is shown *outside* a window like
 * everything else, so the cost of omission is a volunteered line hidden for
 * the few hundred milliseconds a quiet command's answer takes — and the cost
 * of a wrong inclusion is an answer line leaking through every time.
 */
export const VOLUNTEERED: ReadonlySet<BlockType> = new Set<BlockType>([
  'mob-hits',
  'mob-misses',
  'mob-arrives-room',
  'user-hits',
  'user-misses',
  'combat-status',
  'attack-refused',
  'attack-ineffective',
  'user-gain-experience',
  'player-enters',
  'player-exits',
  'player-arrives-room',
  'player-leaves-room',
  'player-gets',
  'player-drops',
  'conversation-gossip',
  'conversation-broadcast',
  'conversation-gangpath',
  'conversation-telepath',
  'conversation-auction',
  'conversation-directed',
  'conversation-yell',
  'conversation-local',
  'heard-movement',
  'player-disconnects',
  'party-invited',
  'party-joined',
  'party-left',
  'party-rank-changed'
]);

export interface FeedSource {
  /** Whether a command word is one the client keeps quiet. */
  isQuiet(command: string): boolean;
  /** Recognises the status line in an unterminated tail, so the window can close early. */
  isStatus(plain: string): boolean;
  now(): number;
}

interface Sent {
  command: string;
  quiet: boolean;
  at: number;
}

/** One thing to paint, with the marks that decorate the lines in it. */
export interface Emitted {
  text: string;
  marks: Array<{ offset: number; mark: TerminalMark }>;
}

export class TerminalFeed {
  private queue: Sent[] = [];
  /** How much of the tokenizer's pending tail has already been emitted. */
  private forwarded = 0;
  /** Whether the last thing emitted left the cursor at the start of a row. */
  private atLineStart = true;
  /** The tail as last seen, so a delayed forward emits what is still pending. */
  private tail = '';
  private hold: NodeJS.Timeout | null = null;
  private out: Emitted = { text: '', marks: [] };
  /** The tail already closed the window, so the framed status line must not close it twice. */
  private acknowledged = false;
  /** Something was withheld since the last emit, so the next shown line needs its own row. */
  private swallowed = false;

  constructor(
    private readonly source: FeedSource,
    /** Called with whatever a delayed hold releases, outside any chunk. */
    private readonly release: (emitted: Emitted) => void
  ) {}

  /** A command went out. `user` commands are never quiet. */
  sent(command: string, from: 'user' | 'automation'): void {
    const typed = command.trim();
    // A bare Enter has no first word to key on, and it is the client's own
    // room read — so it answers to `BARE_ENTER` rather than to nothing.
    const word = typed.length === 0 ? BARE_ENTER : (typed.split(/\s+/)[0]?.toLowerCase() ?? '');
    const quiet = from === 'automation' && this.source.isQuiet(word);
    this.queue.push({ command, quiet, at: this.source.now() });
    this.expire();
  }

  /** Whether the line arriving now is the answer to a quiet command. */
  get quiet(): boolean {
    this.expire();
    return this.queue[0]?.quiet ?? false;
  }

  /**
   * A framed line arrived. Decides what of it the terminal sees and appends
   * it to the current chunk's output.
   */
  line(
    text: string,
    terminator: LineTerminator,
    plain: string,
    type: BlockType | null,
    mark?: TerminalMark
  ): void {
    this.cancelHold();
    const already = this.forwarded;
    this.forwarded = 0;
    this.tail = '';

    /*
     * The echo is the server saying which command it is on. A command in
     * the FIFO ahead of the one echoed was answered without a status line —
     * or never answered — and either way is not what the lines that follow
     * belong to, so the queue moves up to the echoed command. Without this a
     * command the server did not acknowledge sat at the head until it was
     * written off, and the quiet command behind it was shown in full.
     */
    if (type === 'command-echo') {
      const index = this.queue.findIndex((sent) => sent.command.trim() === plain.trim());
      if (index > 0) this.queue.splice(0, index);
    }

    // The acknowledgement: pops the command it answers, and is always shown.
    if (type === 'status-line') {
      if (!this.acknowledged) this.queue.shift();
      this.acknowledged = false;
      this.emit(text.slice(already), terminator, mark);
      return;
    }
    this.acknowledged = false;

    const withhold = this.quiet && already === 0 && (type === null || !VOLUNTEERED.has(type));
    if (!withhold) {
      /*
       * A volunteered line landing after withheld ones would otherwise be
       * glued to the prompt the withheld echo's newline was meant to end.
       */
      if (
        this.swallowed &&
        !this.atLineStart &&
        already === 0 &&
        plain.length > 0 &&
        terminator !== 'repaint'
      ) {
        this.out.text += '\r\n';
        this.atLineStart = true;
      }
      this.emit(text.slice(already), terminator, mark);
      return;
    }

    this.swallowed = true;
    // Withheld — but the repaint marker is the prompt row being erased, and
    // the terminal must still see that or the next status line paints over
    // the old one.
    if (terminator === 'repaint' && text.endsWith(PROMPT_REPAINT)) {
      this.out.text += PROMPT_REPAINT;
      this.atLineStart = true;
    }
  }

  /**
   * The unterminated tail as it stands after a chunk. Forwarded now outside
   * a quiet window; held briefly inside one.
   */
  partial(pending: string): void {
    this.tail = pending;
    if (pending.length <= this.forwarded) return;

    /*
     * The status line closes the window the moment it is recognisable,
     * rather than when the idle flush frames it 150ms later: the next
     * command's echo can arrive in that gap, and it must not be attributed
     * to the command already answered.
     */
    const plain = stripAnsi(pending);
    const status = this.source.isStatus(plain.trimStart());
    if (this.quiet && status) {
      this.queue.shift();
      this.acknowledged = true;
    }

    // A status line is always shown, whatever it acknowledged and whatever
    // is queued behind it: it is the prompt row.
    if (!this.quiet || status) {
      this.cancelHold();
      this.forwardTail();
      return;
    }
    if (this.hold) return;
    this.hold = setTimeout(() => {
      this.hold = null;
      if (this.tail.length <= this.forwarded) return;
      // Still unterminated after the hold: paint it, because a prompt is a
      // line that ends by the server going quiet.
      const before = this.out;
      this.out = { text: '', marks: [] };
      this.forwardTail();
      const released = this.out;
      this.out = before;
      if (released.text.length > 0) this.release(released);
    }, PARTIAL_DELAY_MS);
    this.hold.unref?.();
  }

  /** Everything emitted since the last take, for one push to the terminal. */
  take(): Emitted {
    const taken = this.out;
    this.out = { text: '', marks: [] };
    return taken;
  }

  /** A new connection: nothing sent, nothing pending. */
  reset(): void {
    this.cancelHold();
    this.queue = [];
    this.forwarded = 0;
    this.atLineStart = true;
    this.tail = '';
    this.out = { text: '', marks: [] };
    this.acknowledged = false;
    this.swallowed = false;
  }

  dispose(): void {
    this.cancelHold();
  }

  private forwardTail(): void {
    const fresh = this.tail.slice(this.forwarded);
    if (fresh.length === 0) return;
    this.out.text += fresh;
    this.forwarded = this.tail.length;
    this.atLineStart = false;
  }

  private emit(text: string, terminator: LineTerminator, mark?: TerminalMark): void {
    if (text.length === 0) return;
    this.swallowed = false;
    if (mark) this.out.marks.push({ offset: this.out.text.length, mark });
    this.out.text += text;
    this.atLineStart = terminator !== 'flush' || text.endsWith('\n');
  }

  private expire(): void {
    const now = this.source.now();
    while (this.queue.length > 0 && now - this.queue[0]!.at > ABANDON_MS) this.queue.shift();
  }

  private cancelHold(): void {
    if (!this.hold) return;
    clearTimeout(this.hold);
    this.hold = null;
  }
}
