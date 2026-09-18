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
 *   because xterm has no "unprint". One more hold, and only with a status
 *   line the player designed (`ui.statline`): a tail that has opened like a
 *   prompt but not closed one waits the same `PARTIAL_DELAY_MS` outside a
 *   window too, so the prompt is drawn once, designed, rather than half raw.
 *   Past the delay it is drawn as it stands.
 *
 * Only what automation sends is ever quiet. The player's own `l` is a thing
 * they asked to see.
 */
import { stripAnsi } from '../net/LineTokenizer';
import { PROMPT_REPAINT } from '../net/stream-quirks';
import { tuning } from '../app/tuning';
import type { Block, BlockType } from '../../shared/blocks';
import type { BatchBlock } from '../parse/Classifier';
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

/** Compiled once: `sent` runs for every command that goes out. */
const SPACES = /\s+/;

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
  /**
   * The line the client draws in the prompt's place, or null to paint the
   * realm's own. `rendered` replaces the plain characters `[from, to)` of the
   * line, the escape sequences among them and the styling the server leaves
   * standing after them included ({@link afterStyling}); what lies before and
   * after — a leading newline, the echo, the terminator — is painted as sent.
   * Optional: the feed is also driven by tests that design nothing.
   */
  design?(plain: string): { rendered: string; from: number; to: number } | null;
  /** Whether a design is on, so a prompt still arriving is held for it. */
  designing?(): boolean;
  /**
   * Whether the client draws a block of this type itself (`ui.rewrites`), so
   * a listing's lines are withheld until it completes. Optional, like the
   * design: the feed is also driven by tests that rewrite nothing.
   */
  rewrites?(type: BlockType): boolean;
  /**
   * The client's own lines in a completed block's place — a whole listing or
   * one line — or null to paint the realm's own. What comes back ends every
   * line it draws, so whatever follows starts on a row of its own.
   */
  rewrite?(block: Block | BatchBlock): Emitted | null;
}

/**
 * What the classifier said about a framed line, as far as the feed needs it:
 * the line's own block, and which listing was being collected before and
 * after it. A listing opens on its header, and the feed withholds from there
 * while a rewrite wants it; it closes on the line that completes it, which
 * is when the rewrite is drawn — or ends without a block, in which case what
 * was withheld is painted as sent.
 */
export interface LineFacts {
  block: Block;
  batchWas: BlockType | null;
  batchNow: BlockType | null;
  closed?: BatchBlock;
}

/** One line withheld for a listing the client will draw itself. */
interface HeldLine {
  text: string;
  terminator: LineTerminator;
  mark?: TerminalMark;
  /** Volunteered by the server mid-listing: painted after the drawn listing, never lost. */
  volunteered: boolean;
}

/** A prompt that has begun but not finished: the tolerant pattern's own opening. */
const PROMPT_OPENING = /^\s*\[(?:HP|H)=/i;

/**
 * A prompt that has closed its bracket and had something written after it.
 *
 * `]` then a non-space character: the server finished the prompt and carried
 * straight on, which is what `tailAfterPrompt` reads on the framed line. The
 * bracket must be closed for this to fire, so `[HP=…,S= (Resting)` — where
 * the parenthesised state precedes the `]` that has not arrived — is not it.
 */
const PROMPT_PASSED = /\][^\s]|\]\s+\S/;

/**
 * Whether a tail has opened like a prompt *and is still being written*: the
 * shape the tolerant pattern begins with, whether or not the rest has
 * arrived. Shared with the idle flush, which must not frame half a prompt as
 * a line any more than the feed may paint half of one — the bearfather BBS
 * writes `[HP=…,S= (Resting)` and ` ]:` a tenth of a second apart
 * (`tuning.session.promptHoldMs`).
 *
 * **A prompt the server has already written past is not still arriving.** The
 * realm appends what it volunteers straight onto the prompt row with no
 * terminator between them (`[HP=127/MA=156]:Broadcast from Mist "dame"`,
 * captures/025 line 313), and that sentence is only framed by the idle flush.
 * Where the prompt is one `STATUS_LINE` accepts, the flush's own early return
 * already released it; where it is not — `[hp=` lower-cased, captures/076, 43
 * times — the buffer read as a prompt still opening and waited
 * `promptHoldMs`. Because `armIdleFlush` re-arms on every chunk, each further
 * byte from the realm pushed that deadline out again, so on a talkative realm
 * the broadcast reached the Talk card seconds late, or not until the room
 * went quiet. Once the bracket has closed and something follows it, there is
 * nothing left to wait for.
 */
export function promptOpened(plain: string): boolean {
  return PROMPT_OPENING.test(plain) && !PROMPT_PASSED.test(plain);
}
/** A prompt that has closed its bracket and not yet its colon. */
const PROMPT_UNCLOSED = /\]\s*$/;

/** The sequences `stripAnsi` removes, matched in place. */
const ESCAPE = /\x1B\[[0-9;?]*[\x40-\x7E]|\x1B[\x30-\x7E]/y;

/**
 * Where the `count`th plain character of `text` begins, stepping over the
 * escape sequences the plain text has lost — before any escape that follows
 * the character just counted, which is where a design's replacement ends and
 * {@link afterStyling} decides what of it goes with the prompt.
 */
export function rawIndexOf(text: string, count: number): number {
  let seen = 0;
  let at = 0;
  while (at < text.length) {
    if (seen === count) return at;
    ESCAPE.lastIndex = at;
    const escape = ESCAPE.exec(text);
    if (escape) {
      at += escape[0].length;
      continue;
    }
    at += 1;
    seen += 1;
  }
  return text.length;
}

/** A colour or attribute, the one sequence a drawn prompt's ending outlives. */
const STYLING = /\x1B\[[0-9;]*m/y;

/**
 * Past the styling the server prints at `at`.
 *
 * The state left standing when a prompt ends is what paints the echo, so on a
 * row the client draws it belongs to the design: a template ending `…]: {cyan}`
 * is asking for what is typed next to be cyan, and both realm families print
 * `ESC[0m` a byte after the colon, which would put it straight back. The drawn
 * line always ends in an SGR of its own — the ending's, or the reset a
 * template with no ending produces — so there is nothing to decide here and no
 * flag to get wrong. Only SGR: a cursor move, an erase and the terminator are
 * the row's own and are painted as sent.
 */
export function afterStyling(text: string, at: number): number {
  let past = at;
  for (;;) {
    STYLING.lastIndex = past;
    const styling = STYLING.exec(text);
    if (!styling) return past;
    past += styling[0].length;
  }
}

interface Sent {
  command: string;
  quiet: boolean;
  at: number;
  /** How many packets had arrived when it was sent: see `arrived`. */
  after: number;
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
  /** How long the armed hold was given, so a longer wait can replace a shorter one. */
  private holdFor = 0;
  private out: Emitted = { text: '', marks: [] };
  /** The tail already closed the window, so the framed status line must not close it twice. */
  private acknowledged = false;
  /** Something was withheld since the last emit, so the next shown line needs its own row. */
  private swallowed = false;
  /** The listing being withheld for a rewrite, its lines so far, and the clock that gives up on it. */
  private held: { type: BlockType; lines: HeldLine[]; timer: NodeJS.Timeout | null } | null = null;
  /** Packets read so far, counted as each one starts: see `arrived`. */
  private received = 0;

  constructor(
    private readonly source: FeedSource,
    /** Called with whatever a delayed hold releases, outside any chunk. */
    private readonly release: (emitted: Emitted) => void
  ) {}

  /**
   * A packet has arrived and its lines are about to be fed.
   *
   * Nothing in a packet can answer a command sent while it was being read: the
   * server wrote it first. An automated `rm` sent in reply to a refusal went
   * out between that line and the status line behind it in the same packet,
   * the status line closed the `rm`'s window, and the `rm`'s own answer came
   * next and was painted. A command is answered only by packets that arrive
   * after it (`answerable`).
   */
  arrived(): void {
    this.received += 1;
  }

  /** A command went out. `user` commands are never quiet. */
  sent(command: string, from: 'user' | 'automation'): void {
    const typed = command.trim();
    // A bare Enter has no first word to key on, and it is the client's own
    // room read — so it answers to `BARE_ENTER` rather than to nothing.
    const word = typed.length === 0 ? BARE_ENTER : (typed.split(SPACES)[0]?.toLowerCase() ?? '');
    const quiet = from === 'automation' && this.source.isQuiet(word);
    this.queue.push({ command, quiet, at: this.source.now(), after: this.received });
    this.expire();
  }

  /** Whether a quiet command's window is open: the next packet's lines answer it. */
  get quiet(): boolean {
    this.expire();
    return this.queue[0]?.quiet ?? false;
  }

  /** Whether the line being read now is the answer to a quiet command. */
  private get answeringQuiet(): boolean {
    return this.quiet && this.answerable();
  }

  /** Whether what is being read now could answer the head: it arrived after the head was sent. */
  private answerable(): boolean {
    const head = this.queue[0];
    return head !== undefined && this.received > head.after;
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
    mark?: TerminalMark,
    facts?: LineFacts
  ): void {
    this.cancelHold();
    const already = this.forwarded;
    this.forwarded = 0;
    this.tail = '';

    /*
     * A listing the client draws itself. Its lines are withheld from the
     * header on and drawn at once when it completes — a table cannot be
     * drawn a row at a time, and xterm has no unprint — so the line that
     * completes it releases the drawing first and is then painted as itself,
     * which for a listing ended by the prompt is the designed prompt row.
     * A listing that ends without a block, or one the design declines, is
     * painted as it was sent, in order.
     */
    if (this.held !== null) {
      // A line the classifier faulted on has no facts; it is still inside
      // the listing, and painting it ahead of the drawing would reorder it.
      const done =
        facts !== undefined &&
        (facts.closed !== undefined ||
          facts.batchNow === null ||
          facts.batchNow !== this.held.type);
      if (!done) {
        this.held.lines.push({
          text,
          terminator,
          ...(mark ? { mark } : {}),
          volunteered: type !== null && VOLUNTEERED.has(type)
        });
        return;
      }
      const drawn =
        facts?.closed !== undefined && facts.closed.type === this.held.type
          ? (this.source.rewrite?.(facts.closed) ?? null)
          : null;
      this.releaseHeld(drawn);
    }

    /*
     * The echo is the server saying which command it is on. A command in
     * the FIFO ahead of the one echoed was answered without a status line —
     * or never answered — and either way is not what the lines that follow
     * belong to, so the queue moves up to the echoed command. Without this a
     * command the server did not acknowledge sat at the head until it was
     * written off, and the quiet command behind it was shown in full.
     */
    if (type === 'command-echo') {
      const index = this.queue.findIndex(
        (sent) => this.received > sent.after && sent.command.trim() === plain.trim()
      );
      if (index > 0) this.queue.splice(0, index);
    }

    // The acknowledgement: pops the command it answers, and is always shown —
    // as the client's own line where one is designed and none of it has been
    // painted yet, which is the prompt arriving whole with its terminator.
    if (type === 'status-line') {
      if (!this.acknowledged && this.answerable()) this.queue.shift();
      this.acknowledged = false;
      const drawn = already === 0 ? this.designed(text, plain) : null;
      this.emit(drawn ?? text.slice(already), terminator, mark);
      return;
    }
    this.acknowledged = false;

    const withhold =
      this.answeringQuiet && already === 0 && (type === null || !VOLUNTEERED.has(type));
    if (!withhold && already === 0 && facts !== undefined && this.source.rewrites !== undefined) {
      /*
       * The header of a listing the client will draw: withheld from here,
       * with the clock that gives up on a listing the server never ends.
       * Only while none of it has been painted — a header whose head went
       * out as a tail before it was framed is a listing painted as sent.
       */
      const opens =
        facts.batchWas === null && facts.batchNow !== null && this.source.rewrites(facts.batchNow);
      if (opens && facts.batchNow !== null) {
        this.held = {
          type: facts.batchNow,
          lines: [{ text, terminator, ...(mark ? { mark } : {}), volunteered: false }],
          timer: null
        };
        this.armHeldTimer();
        return;
      }
      // One line the client draws in the realm's place: the experience line.
      if (facts.batchNow === null && type !== null && this.source.rewrites(type)) {
        const drawn = this.source.rewrite?.(facts.block) ?? null;
        if (drawn !== null) {
          this.emitDrawn(drawn);
          // The repaint marker still erases the prompt row it ended.
          if (terminator === 'repaint' && text.endsWith(PROMPT_REPAINT)) {
            this.out.text += PROMPT_REPAINT;
          }
          return;
        }
      }
    }
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
    if (this.answeringQuiet && status) {
      this.queue.shift();
      this.acknowledged = true;
    }

    // A listing being withheld holds its tail too: the prompt that ends it
    // is drawn after the listing, once the idle flush frames it as a line.
    if (this.held !== null) return;

    /*
     * A prompt that has opened and not closed is still being written. Only
     * while a design is on does that matter to the feed: painted raw, the
     * half-prompt cannot be taken back and the design is lost for that
     * prompt. The wait is the measured one (`promptHoldMs`, the bearfather
     * BBS's second write lands a tenth of a second after its first), not the
     * quiet window's forty milliseconds, which was written for a chunk cut by
     * the network rather than a prompt the server writes in two pieces.
     */
    const opening =
      this.forwarded === 0 &&
      this.source.designing?.() === true &&
      !status &&
      PROMPT_OPENING.test(plain);

    // A status line is always shown, whatever it acknowledged and whatever
    // is queued behind it: it is the prompt row.
    if (!this.answeringQuiet || status) {
      this.cancelHold();
      /*
       * The client's own line in the prompt's place — only while nothing of
       * this tail has been painted, since xterm has no unprint. A tail that
       * has opened like a prompt without finishing one is held for it, so a
       * prompt split across two chunks is drawn once, designed, rather than
       * half raw and then not at all. Held past the delay, it is painted as
       * sent: a design is presentation, and presentation never delays the
       * prompt for long.
       */
      if (this.forwarded === 0 && this.source.designing?.() === true) {
        /*
         * A prompt whose colon has not arrived is still arriving: the tolerant
         * pattern accepts `]` without one, and a chunk cut between the two
         * would draw the line and then paint a stray `:` after it. Held for
         * the short while a network cut needs; drawn at the hold's end if
         * nothing more comes.
         */
        if (status && !PROMPT_UNCLOSED.test(plain)) {
          if (this.drawDesigned(pending, plain)) return;
        } else if (status) {
          this.armHold(PARTIAL_DELAY_MS);
          return;
        } else if (opening) {
          this.armHold(tuning().session.promptHoldMs);
          return;
        }
      }
      this.forwardTail();
      return;
    }
    // Inside a window the hold runs from the tail's first sight and is not
    // restarted — unless what has arrived since is a prompt still opening,
    // which needs the longer wait whatever the window gave it.
    const wanted = opening ? tuning().session.promptHoldMs : PARTIAL_DELAY_MS;
    if (this.hold && this.holdFor >= wanted) return;
    this.cancelHold();
    this.armHold(wanted);
  }

  /**
   * Paint the tail as it stands once `delay` has passed with nothing ending
   * it — designed, where it is a whole prompt the client draws and none of
   * it has been painted, else as sent.
   */
  private armHold(delay: number): void {
    this.holdFor = delay;
    this.hold = setTimeout(() => {
      this.hold = null;
      if (this.tail.length <= this.forwarded) return;
      // Still unterminated after the hold: paint it, because a prompt is a
      // line that ends by the server going quiet.
      const before = this.out;
      this.out = { text: '', marks: [] };
      const plain = stripAnsi(this.tail);
      const drawn =
        this.forwarded === 0 &&
        this.source.designing?.() === true &&
        this.source.isStatus(plain.trimStart()) &&
        this.drawDesigned(this.tail, plain);
      if (!drawn) this.forwardTail();
      const released = this.out;
      this.out = before;
      if (released.text.length > 0) this.release(released);
    }, delay);
    this.hold.unref?.();
  }

  /** The whole tail, drawn as the client's line; false where the design declined. */
  private drawDesigned(pending: string, plain: string): boolean {
    const drawn = this.designed(pending, plain);
    if (drawn === null) return false;
    this.out.text += drawn;
    this.forwarded = pending.length;
    this.atLineStart = false;
    return true;
  }

  /** The prompt at the head of `text`, drawn by the client, or null to paint the realm's own. */
  private designed(text: string, plain: string): string | null {
    const design = this.source.design?.(plain);
    if (!design) return null;
    const from = rawIndexOf(text, design.from);
    const to = afterStyling(text, rawIndexOf(text, design.to));
    return text.slice(0, from) + design.rendered + text.slice(to);
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
    this.dropHeld();
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
    this.dropHeld();
  }

  /**
   * What was withheld for a listing, painted: the client's drawing where the
   * design produced one and the realm's lines otherwise, then any line the
   * server volunteered in the middle of it, which happened during the
   * listing and is never lost to the drawing.
   */
  private releaseHeld(drawn: Emitted | null): void {
    const held = this.held;
    if (held === null) return;
    this.dropHeld();
    if (drawn === null) {
      for (const line of held.lines) this.emit(line.text, line.terminator, line.mark);
      return;
    }
    this.emitDrawn(drawn);
    for (const line of held.lines) {
      if (line.volunteered) this.emit(line.text, line.terminator, line.mark);
    }
  }

  /** The client's own lines, with their marks re-keyed to where they land in the chunk. */
  private emitDrawn(drawn: Emitted): void {
    if (drawn.text.length === 0) return;
    this.swallowed = false;
    for (const { offset, mark } of drawn.marks) {
      this.out.marks.push({ offset: this.out.text.length + offset, mark });
    }
    this.out.text += drawn.text;
    this.atLineStart = drawn.text.endsWith('\n');
  }

  /**
   * A listing the server never ended is painted as sent once `rewriteHoldMs`
   * has passed — outside any chunk, like a held tail — and the tail with it.
   */
  private armHeldTimer(): void {
    if (this.held === null) return;
    this.held.timer = setTimeout(() => {
      if (this.held === null) return;
      this.held.timer = null;
      const before = this.out;
      this.out = { text: '', marks: [] };
      this.releaseHeld(null);
      this.forwardTail();
      const released = this.out;
      this.out = before;
      if (released.text.length > 0) this.release(released);
    }, tuning().session.rewriteHoldMs);
    this.held.timer.unref?.();
  }

  private dropHeld(): void {
    if (this.held?.timer) clearTimeout(this.held.timer);
    this.held = null;
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
    this.holdFor = 0;
  }
}
