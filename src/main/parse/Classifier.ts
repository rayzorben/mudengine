/**
 * Line → block.
 *
 * The rule from docs/legacy-assessment.md §5 that shapes everything here:
 * **grammar first, colour second.** Every test is against plain text; ANSI is
 * read only to adjust a confidence score. `megamind-client` decided a line was
 * a room title because its span was bright cyan, exits because green, entities
 * because magenta — which breaks on any server with a different scheme, and on
 * every theme a colour-blind player would choose.
 */
import { domainOf, type Block, type BlockType } from '../../shared/blocks';
import { commandOf } from '../../shared/commands';
import {
  answersTo,
  nameAtEnd,
  nameInMessage,
  nameLeading,
  type NameSources
} from '../../shared/mobs';
import { BATCH_RULES, RULES, STATUS_LINE, type BatchRule, type Rule } from './patterns';
import type { StreamLine } from '../../shared/types';
import type { SpellMessageHit } from '../../shared/spell-messages';
import type { ActionHit } from '../../shared/actions';
import type { MessageHit } from '../../shared/messages';
import { mobKey } from '../../shared/world';
import { tuning } from '../app/tuning';

/*
 * The patterns the per-line path evaluates, compiled once.
 *
 * A regex literal inside a function is compiled once by the engine but
 * *allocated* on every evaluation; measured 2026-09-04 (todo 01), an inline
 * literal `.test` costs about twice a hoisted one (60ns against 32ns) and a
 * `new RegExp` per call nine times (287ns). These run on every line the
 * server prints — `foregroundCodes` on all of them, `looksLikeRoomName` on
 * every line no other rule claimed — so they live here. A pattern evaluated
 * only inside a matched block's branch stays where it reads best.
 */
const SGR = /\x1B\[([0-9;]*)m/g;
const SPACES = /\s+/;
const ANY_SPACE = /\s/;
const WORD_EDGE = /^[^A-Za-z0-9&]+|[^A-Za-z0-9.&]+$/g;
const TITLE_START = /^[A-Z0-9&]/;
const SENTENCE_MARKS = /[!?;:]/;
const TWO_COLUMN_GAPS = /(?:\S\s{2,}\S.*){2}/;
const PROSE_STOP = /(?<=[A-Za-z]{5})\.(?=\s|$)/;
const PRONOUN_LED = /^(You|He|She|It|They|We|I)\b/;
/**
 * The opening of a status line, which ends a batch and is never folded into
 * one. Case-insensitive throughout: the batch terminator already accepted
 * `[hp=` and the two fold guards did not, and one constant cannot disagree
 * with itself.
 */
const STATUS_LINE_START = /^\[(?:HP|H)=/i;
const ADDRESSED_COMMAND = /^([/>])\s*([A-Za-z][\w'-]*)\s+(\S.*)$/;
const CAPITALISED_FIRST_WORD = /^([A-Z][\w'-]*)\s/;
const ARTICLE = /^(?:The|A|An)$/;
const GRAMMAR_TARGET = /^(?:critically )?\w+ (?:the )?(?<target>[A-Za-z][\w' -]*)$/;
const POSSESSIVE_LED = /^(?:a|an|your|his|her|its|their) /i;
const CONNECTIVE = / (?:at|with|upon|on|into|through|from|and) /i;

/** SGR foreground codes present in a raw line, in order of appearance. */
export function foregroundCodes(raw: string): number[] {
  const codes: number[] = [];
  for (const match of raw.matchAll(SGR)) {
    for (const part of (match[1] ?? '').split(';')) {
      const value = Number.parseInt(part, 10);
      if (value >= 30 && value <= 37) codes.push(value);
      if (value >= 90 && value <= 97) codes.push(value - 60);
    }
  }
  return codes;
}

/**
 * Guards the loosest rule in the table.
 *
 * A room name has no marker — it is a title-cased phrase on its own line — so
 * without a plausibility check it swallows any short capitalised sentence the
 * game prints. Requiring the absence of sentence punctuation and a sane length
 * is what keeps `You gain 5 experience` and prose out.
 */
/**
 * Words a room name may leave in lower case.
 *
 * Title case is what separates a name from prose, and these are the words a
 * title legitimately does not capitalise.
 */
const TITLE_CONNECTORS = new Set([
  'of',
  'the',
  'a',
  'an',
  'and',
  'at',
  'by',
  'for',
  'in',
  'on',
  'to',
  'with',
  'from',
  'into',
  'under',
  'over',
  '&'
]);

/**
 * Title case, allowing the small words a title leaves alone.
 *
 * This is the discriminator that does the real work. `The city wall is to the
 * north` and `The Silver River` are the same shape to every other test in this
 * function; only capitalisation tells them apart, and it tells them apart
 * reliably because the game titles its rooms and writes its prose in sentences.
 */
function titleCased(text: string): boolean {
  for (const [index, raw] of text.split(SPACES).entries()) {
    const word = raw.replace(WORD_EDGE, '');
    if (word === '') continue;
    if (TITLE_START.test(word)) continue;
    if (index > 0 && TITLE_CONNECTORS.has(word.toLowerCase())) continue;
    return false;
  }
  return true;
}

/**
 * Whether a line that matched the room-name shape is plausibly a room name.
 *
 * Measured against the 3,789 distinct room names in the shipped realm data and
 * against the lines a live walk actually produces (`npm run probe:room`). The
 * previous rule — reject anything containing a full stop, and reject anything
 * beginning `The`, `A` or `An` — turned away **6.5% of every room in the game**,
 * including every street corner (`Intersection of Guild St. & River St.`) and
 * every room beginning `The`. This accepts 99.0% of them and adds no false
 * positive on that corpus.
 *
 * Losing a name is not cosmetic: the room block completes with nothing to look
 * up, so the client stops knowing where it is standing.
 */
export function looksLikeRoomName(text: string): boolean {
  const { roomNameMinChars, roomNameMaxChars } = tuning().parse;
  if (text.length < roomNameMinChars || text.length > roomNameMaxChars) return false;
  // Sentence punctuation a title never carries.
  if (SENTENCE_MARKS.test(text)) return false;
  /*
   * Two runs of spaces inside the line are *columns*, not a name. `Item
   * Quantity    Price` — the heading over a shop's stock — is title-cased and
   * unpunctuated and used to become the room, with every row under it read
   * as its description. Two rather than one, measured: four of the 3,790
   * names in the shipped realm carry a single doubled space (`Crumbling
   * Catacombs, West Stairwell`), and none carries two.
   */
  if (TWO_COLUMN_GAPS.test(text)) return false;
  /*
   * A full stop is allowed only where it abbreviates. `St.` and `Rd.` end a
   * short token; a sentence's full stop follows a whole word, so a stop after
   * five or more letters is prose.
   */
  if (PROSE_STOP.test(text)) return false;
  // Pronoun-led lines are prose, not titles. "You" is by far the commonest.
  // `The`, `A` and `An` are *not* here: they begin plenty of real rooms, and
  // title case already separates `The Silver River` from `The city wall is...`.
  if (PRONOUN_LED.test(text)) return false;
  return titleCased(text);
}

/**
 * Whether this line opens a listing whose lines can look like room names.
 *
 * The companion to `BatchRule.tailsLookLikeRooms`, for the one line that rule
 * cannot cover: a batch's header is classified before it is fed to the
 * collector, so while the header is being read there is no open batch to ask.
 * `abil` is the case — `Race` on a line of its own — and the columnar `who`
 * and the spellbook are covered for free.
 */
function opensRoomLikeListing(text: string): boolean {
  return BATCH_RULES.some((rule) => rule.tailsLookLikeRooms === true && rule.header.test(text));
}

/**
 * What the server printed after the prompt, on the same framed line.
 *
 * `LineTokenizer` frames on the status line's own `ESC[79D ESC[K` repaint, so
 * a line begins at a repaint and ends at the next one. The server does not
 * always put a repaint between the prompt it just painted and the sentence it
 * then wants to say — `You withdrew 20000 copper farthings.` arrives glued to
 * the prompt, where `You deposit 20000 copper farthings.` gets a repaint of
 * its own and a line to itself. `STATUS_LINE` has no end anchor, so
 * `status-line` claimed the whole line and the sentence was unreadable by any
 * rule, which is what kept the withdrawal unparsed for three phases.
 *
 * **Measured before it was written, over the 218 posted captures and every
 * session this client has recorded** (125,306 status lines): 8,608 carry a
 * tail, 2,167 of them distinct. On this client's own wire the split is stark —
 * 3,159 tails, of which 3,064 are the echo of a command it had just sent, and
 * the 95 that are not are the server talking: `You withdrew …`, `Your command
 * had no effect.`, `Item # not found!`, `Quiet mode set`, the `Current
 * Adventurers` heading of a `who`. In the posted captures, where the poster's
 * own client did the framing, a room name follows the prompt routinely
 * (`Crimson Passage`, 29 times) — which is the client losing its position, the
 * failure `looksLikeRoomName` exists to prevent, happening one layer earlier.
 *
 * Returned **verbatim**, leading whitespace and all. A rule that tolerates
 * indentation says so with `^\s*` already; trimming here would invent a shape
 * the server did not send and would let anchored rules match text that was not
 * at the start of anything.
 */
export function tailAfterPrompt(text: string): string | null {
  const match = STATUS_LINE.exec(text);
  if (!match) return null;
  const tail = text.slice(match.index + match[0].length);
  return tail.trim().length === 0 ? null : tail;
}

export interface BatchBlock extends Block {
  /** Rows for an `array` batch, or merged groups for an `object` batch. */
  rows: Array<Record<string, string>>;
}

/**
 * Stateful across lines, because multi-line blocks exist. One instance per
 * session; `reset()` between connections.
 */
/** The verdicts an emote can wear before the action table is asked. See `asAction`. */
const EMOTE_SHAPED: ReadonlySet<BlockType> = new Set<BlockType>([
  'unknown',
  'user-misses',
  'mob-misses',
  'player-misses'
]);

export class Classifier {
  private batch: {
    rule: BatchRule;
    lines: string[];
    startedAt: number;
    seq: number;
    /** What the header line itself captured — see `feedBatch`. */
    head: Record<string, string>;
  } | null = null;
  /**
   * The last command sent, whoever sent it.
   *
   * Two lines in this server's output can only be understood next to it: the
   * echo of the command itself, and `You say "<command>"` when the command was
   * not recognised. Both are otherwise indistinguishable from ordinary output —
   * a player typing `Rest` echoes a line that matches `room-name` exactly.
   */
  private lastCommand = '';
  /**
   * Every command sent and not yet seen echoed back, oldest first.
   *
   * **`lastCommand` above cannot serve for this, and that was a real defect
   * rather than a tidying opportunity.** The server echoes what it is given,
   * in order, and does not wait for one command to be answered before echoing
   * the next — a burst comes back as a run of bare lines, one per command:
   *
   *     [HP=120/MA=15]:rm
   *     aa big cave worm
   *     st
   *     i
   *
   * With one slot, only the **last** command of a burst could ever equal
   * `lastCommand`. Every other echo fell through to the rule table and was
   * typed as though the game had said it. Pasting a transcript into the
   * console therefore had the client read its own paste as the game: it
   * completed rooms out of the pasted room blocks and **learned an edge**
   * between two rooms the character had never walked between, which is a
   * permanent per-character file.
   *
   * This is the third time this codebase has met the same shape — the room
   * expectations and the look-target queue are both queues for the identical
   * reason, stated in each: *they go out faster than they are answered.* An
   * echo is no different, and the slot was written when a command was
   * something a person typed one at a time.
   *
   * Matched from the head and spliced rather than only compared against it, so
   * one echo the server never sent back cannot stall every echo behind it.
   * Bounded by `tuning.parse.maxPendingEchoes`.
   */
  private pendingEchoes: string[] = [];
  /**
   * The last addressed message sent — `/soul hi`, `>soul hi` — split into
   * sigil, the name as typed and the body.
   *
   * The receipt the server answers with (`--- Telepath Sent to Soul ---`)
   * confirms the send and names the resolved recipient, and nothing else: the
   * body is never echoed, so this slot is the only record of what was
   * actually said. One slot, the shape the attack-command binding takes and
   * for the same reason — where two addressed messages are in flight at once,
   * the earlier receipt goes unbound rather than bound to the wrong words.
   */
  private addressed: { sigil: '/' | '>'; name: string; body: string } | null = null;
  /**
   * A bare `search` is out and its answer has not arrived.
   *
   * The server prints `You notice … here.` for a look *and* for a search, so
   * nothing in the line says which — and the two are different facts, because
   * what a search turns up stays concealed and its coins refuse a bare `get`
   * (see `room-hidden-items`). The only discriminator is the command, which
   * makes this the same shape as `addressed` above and for the same reason.
   *
   * **Bare only.** `search <direction>` is a different question with its own
   * answers (`You found an exit to the east!`), and `Walker` sends one at every
   * `Hidden/Searchable` edge it is refused by — so arming on those would have
   * the next room's floor listing read as a discovery.
   *
   * Cleared by the first answer of either kind, never by a timer and never by
   * an intervening command: the server answers in order, so a `search` with an
   * `n` sent behind it is still answered first.
   */
  private searching = false;
  /**
   * True between a room name and the first line that is anything else.
   *
   * The description has no marker: it is simply the prose printed under the
   * name. Recognising it needs one line of memory, which is the same reason
   * the batch collector lives here — and it belongs here rather than in the
   * tracker, because blocks are the fact stream everything else reads. A room
   * description that only the tracker can see is not a fact anyone else can
   * subscribe to.
   */
  private inDescription = false;

  /**
   * Where the monster in a combat or arrival line gets its name.
   *
   * Three patterns in the table capture the whole run of words between `The`
   * and the end of the frame, because nothing in the grammar says where the
   * name stops and the realm's own attack text starts — see the note beside
   * `mob-hits` in `patterns.ts`. Splitting it needs two things this module
   * deliberately does not hold: what the room is known to contain, and the
   * realm's monster table.
   *
   * So it is injected, in the shape every other realm-data consumer here takes
   * (`classifyOccupant` does the same): a lookup, not a graph. A classifier
   * with none — the anonymous session, every unit test that does not pass one —
   * still produces the block, and simply leaves `attacker` out. That is the
   * honest degradation: everything downstream already treats a missing name as
   * "a blow landed and nothing knows what threw it".
   */
  constructor(
    private readonly names?: NameSources,
    /**
     * What a whole line means as a spell message — the realm's own sentence
     * for an effect landing or ending, from `resources/world/spell-messages.csv`
     * and what the wire has taught. A lookup rather than the table, as `names`
     * is, because what has been learned changes while the session runs.
     */
    private readonly spells?: (text: string) => SpellMessageHit | null,
    /**
     * Every monster a whole line is the death sentence of: what this realm's
     * wire has taught first, then the server's own table
     * (`src/shared/death-messages.ts`), which shares one sentence between
     * monsters often enough that the answer is a list. Empty where the line
     * is nobody's. A lookup for the reason `spells` is.
     */
    private readonly deaths?: (text: string) => readonly string[],
    /**
     * What a whole line means as an emote — the server's action table
     * (`src/shared/actions.ts`), fitted as templates. A lookup so a test can
     * hand in three rows and a session the shipped sixty-four.
     */
    private readonly actions?: (text: string) => ActionHit | null,
    /**
     * The server's own message table fitted whole (`src/shared/messages.ts`):
     * what a spell prints to its caster, its target and the room, and every
     * other sentence the realm composes from a row rather than in code. Last
     * of the lookups and open to `unknown` only, so it fills what no frame and
     * no other table read (todo 109).
     */
    private readonly messages?: (text: string) => MessageHit | null
  ) {}

  /** The type of the listing being collected, or null between listings. */
  get batchType(): BlockType | null {
    return this.batch?.rule.type ?? null;
  }

  /** Records an outbound command. Not cleared on use: two lines may need it. */
  observeCommand(command: string): void {
    this.lastCommand = command.trim();
    /*
     * And onto the queue, which is what the echo check actually reads. An
     * empty command is a bare Enter: it echoes nothing, so queueing it would
     * put a value in the queue that no line can ever match and push a real one
     * out of the back.
     */
    if (this.lastCommand.length > 0) {
      this.pendingEchoes.push(this.lastCommand);
      if (this.pendingEchoes.length > tuning().parse.maxPendingEchoes) {
        this.pendingEchoes.shift();
      }
    }
    /*
     * An addressed message fills the receipt slot; anything else leaves it.
     * An intervening command does not invalidate what the receipt will
     * confirm — the server answers in order, so the receipt for `/soul hi`
     * still means `/soul hi` after an `n` has gone out behind it — and a
     * refused send whose receipt never comes is overwritten by the next
     * addressed message rather than cleared by guesswork.
     */
    const address = ADDRESSED_COMMAND.exec(this.lastCommand);
    if (address) {
      this.addressed = {
        sigil: address[1] as '/' | '>',
        name: address[2]!,
        body: address[3]!.trim()
      };
    }

    // A bare `search`, in any of the realm's four spellings for it.
    if (commandOf(this.lastCommand) === 'Search' && !ANY_SPACE.test(this.lastCommand)) {
      this.searching = true;
    }
  }

  /**
   * Classifies one line.
   *
   * Returns the single-line block, plus a batch block on the line that
   * completes one. A batch does not suppress single-line classification: the
   * lines of a stat sheet are still individually meaningful.
   *
   * And plus the blocks the server printed **after** the prompt on the same
   * framed line — see `tailAfterPrompt`. That is one framed line carrying
   * several facts, so it produces several blocks with the same `seq`, in the
   * order the server wrote them: the prompt first, then its tail.
   *
   * The tail is peeled repeatedly, because a prompt's tail can be another
   * prompt: `[HP=191]:[HP=188]:You surprise smash Rend for 86 damage!` occurs
   * in the corpus (138 such lines, some with three prompts), and the two
   * prompts carry *different* health — so stopping at one would either lose
   * the blow or lose the newer reading of the bar it changed.
   */
  classify(line: StreamLine): { block: Block; batch?: BatchBlock; tails?: Block[] } {
    const text = line.plain;
    const block = this.classifyLine(line, text);
    let batch = this.feedBatch(line, text, block.type);

    /*
     * Each segment goes through the whole of `classifyLine` rather than a
     * subset: it is an ordinary line that happens to have arrived late, and it
     * needs the echo check, the description state and the batch collector
     * exactly as a line of its own would. The feeds are ordered left to right
     * because the prompt is a batch *terminator* — a listing still open when
     * this line arrives has to be closed by the prompt before what follows is
     * offered as the header of the next one. At most one batch can complete on
     * one line: completing needs an open batch, and only one is ever open.
     */
    const tails: Block[] = [];
    let rest = block.type === 'status-line' ? tailAfterPrompt(text) : null;
    while (rest !== null) {
      const next = this.classifyLine(line, rest);
      const found = this.feedBatch(line, rest, next.type);
      batch ??= found;
      tails.push(next);
      // `tailAfterPrompt` always returns a strictly shorter string, so this
      // terminates on any input.
      rest = next.type === 'status-line' ? tailAfterPrompt(rest) : null;
    }

    /*
     * A wrapped floor listing answering a `search` is the same retype
     * `answerSearch` gives the single-line one. The per-line blocks of a
     * record are `unknown`, so the slot is still armed when the record
     * closes; consumed here, where the listing actually is.
     */
    if (batch?.type === 'room-items' && this.searching) {
      this.searching = false;
      batch = { ...batch, type: 'room-hidden-items', domain: domainOf('room-hidden-items') };
    }

    return {
      block,
      ...(batch ? { batch } : {}),
      ...(tails.length > 0 ? { tails } : {})
    };
  }

  reset(): void {
    this.lastCommand = '';
    this.pendingEchoes = [];
    this.addressed = null;
    this.searching = false;
    this.inDescription = false;
    this.batch = null;
  }

  private classifyLine(line: StreamLine, text: string): Block {
    const block = this.answerSearch(
      line,
      text,
      this.asRealmMessage(
        line,
        text,
        this.asDeathSentence(
          line,
          text,
          this.asAction(line, text, this.asSpellMessage(line, text, this.matchLine(line, text)))
        )
      )
    );

    /*
     * Anything with a marker of its own ends the description: `Also here:`,
     * `You notice`, `Obvious exits:` and the status line all follow it. Closing
     * on the first recognised line keeps the description to the contiguous
     * prose it actually is, rather than "everything until further notice".
     */
    if (block.type === 'room-name') {
      this.inDescription = true;
      return block;
    }
    if (block.type !== 'unknown') {
      this.inDescription = false;
      return block;
    }
    if (!this.inDescription || text.trim().length === 0) return block;
    /*
     * A record the server wrapped is not prose, on any of its lines. Its
     * header ends the description exactly as the whole sentence does, and
     * its tail is read by the batch that closes on it — so both stay
     * `unknown` here rather than becoming scenery, which is where 65 wrapped
     * floor listings in one live run went (todo 03). The batch is fed after
     * this, so the header's own line asks the rule table; a continuation
     * finds the record already open.
     */
    if (this.batch?.rule.wraps === 'record' || opensRecord(text)) {
      this.inDescription = false;
      return block;
    }

    return this.build(line, 'room-description', {}, text, tuning().parse.baseConfidence);
  }

  private matchLine(line: StreamLine, text: string): Block {
    /*
     * The server echoes what we send. Checked ahead of the table rather than as
     * a pattern in it, because the thing that makes it an echo is not its shape
     * — it is that it equals a command this client sent. `Rest` typed at the
     * prompt echoes a line that matches `room-name` and passes
     * `looksLikeRoomName`, so without this the client would believe it had
     * walked into a room called Rest.
     *
     * Against the **queue** and not against the last command alone: see
     * `pendingEchoes`. The head is tried first because the server answers in
     * order, and anything skipped past is dropped with it — an echo that never
     * came back must not hold up every echo behind it, and a command still
     * sitting in the queue long after its turn is one more chance to eat a
     * real line that happens to read the same.
     */
    const echoed = this.pendingEchoes.indexOf(text);
    if (echoed !== -1) {
      this.pendingEchoes.splice(0, echoed + 1);
      return this.build(line, 'command-echo', {}, text, 1);
    }

    for (const rule of RULES) {
      const match = rule.pattern.exec(text);
      if (!match) continue;
      if (rule.type === 'room-name' && !looksLikeRoomName(text)) continue;
      /*
       * Not a room while a listing is being read. A gang name wrapped onto its
       * own line in a columnar `who` — `Khazarad`, the tail of `Dukes of` —
       * is title case and one word, which is exactly what a room name looks
       * like, and reading it as one moved the client's sense of location in
       * the middle of a roster. Only inside a listing that says its tails can
       * look like rooms (`BatchRule.tailsLookLikeRooms`): every other batch is
       * left alone, because a listing whose prompt the terminator does not
       * know runs to `maxLines`, and a room the character then walked into
       * would lose its name for as long as it stayed open — measured in the
       * corpus (captures/111, `Obsidian Tomb` inside an inventory).
       */
      /*
       * And not a room on the line that *opens* one either. `abil`'s listing
       * begins with the bare word `Race` — title case, one word, three
       * letters — so the guard above could never fire for it: the batch is
       * fed after the line has already been classified, and on the header
       * line there is no batch open yet. The client walked into a room called
       * `Race` and read the character's whole ability listing as its
       * description.
       */
      if (
        rule.type === 'room-name' &&
        (this.batch === null ? opensRoomLikeListing(text) : this.batch.rule.tailsLookLikeRooms)
      ) {
        continue;
      }
      // Only a `You say` of exactly what we just sent is a refused command.
      // Anything else is someone talking, and falls through to the rule below.
      if (
        rule.type === 'command-not-understood' &&
        (this.lastCommand.length === 0 || match.groups?.['message'] !== this.lastCommand)
      ) {
        continue;
      }

      let confidence = tuning().parse.baseConfidence;
      if (rule.expectColour) {
        const seen = foregroundCodes(line.text);
        const agrees = seen.some((code) => rule.expectColour?.includes(code));
        // No colour at all is not disagreement — plenty of servers send none.
        confidence =
          seen.length === 0
            ? tuning().parse.baseConfidence
            : agrees
              ? tuning().parse.colourAgrees
              : tuning().parse.colourDisagrees;
      }

      const groups = { ...(match.groups ?? {}) };
      /*
       * The name inside the frame, where anything can say what it is.
       *
       * Written into `attacker` rather than into a group of its own so that
       * `{attacker}` in a rule, `HangUp`'s PvP evidence and the tracker all go
       * on reading the one name they always read. `line` is kept beside it:
       * it is what the server actually said, and an unresolved one is the
       * only record of a monster nothing could name.
       */
      this.resolveNames(rule, groups);
      this.bindReceipt(rule.type, groups);

      return this.build(line, rule.type, groups, text, confidence);
    }

    return this.build(line, 'unknown', {}, text, 0);
  }

  /**
   * The spell message table's reading of a line, where the table has one.
   *
   * Only three verdicts are open to correction: `unknown`, because the table
   * knows sentences no frame does (`You are using pressure points!`, `You
   * slow down.`); and the two frame-matched types it refines, `spell-onset`
   * and `user-buff-expired`, which then carry *which* spells the sentence
   * belongs to rather than an effect word or a name to be resolved later.
   * Every other type stands — `You are blind!` is an affliction with its own
   * two-ended state machine, and the table calling it the start of `flash`
   * would be a second opinion on a settled fact. A sentence the table holds
   * as both a start and a stop cannot be read as either and is left as the
   * frames read it.
   *
   * The spells travel in `spells`, `|`-separated: a group is a string, and a
   * spell's name never holds that character.
   */
  private asSpellMessage(line: StreamLine, text: string, block: Block): Block {
    if (!this.spells) return block;
    if (
      block.type !== 'unknown' &&
      block.type !== 'spell-onset' &&
      block.type !== 'user-buff-expired'
    ) {
      return block;
    }
    const hit = this.spells(text);
    if (!hit) return block;
    const begins = hit.starts.length > 0;
    const ends = hit.stops.length > 0;
    if (begins === ends) return block;
    const confidence = Math.max(block.confidence, tuning().parse.baseConfidence);
    if (begins) {
      return this.build(
        line,
        'spell-onset',
        { ...block.groups, spells: hit.starts.join('|') },
        text,
        confidence
      );
    }
    return this.build(
      line,
      'user-buff-expired',
      {
        ...block.groups,
        spell: block.groups['spell'] ?? hit.stops[0],
        spells: hit.stops.join('|')
      },
      text,
      confidence
    );
  }

  /**
   * A whole line the realm's emote table fits is somebody's action.
   *
   * Open to `unknown`, after the spell table, and to the three miss frames
   * and no other: `<who> <verb> at <whom>!` is grammar, and an aimed emote is
   * exactly that grammar — `You giggle at Soul!` read as this character
   * missing a *player*, `Soul giggles loudly at you!` as a monster's swing
   * with `Soul` guessed for the attacker, `Galen winks at angry chimera!` as
   * a swing between two others that put both in the room (2026-09-12). The
   * table is the server's own sentence, fitted whole, so where it fits it
   * outranks the frame; a line it does not fit stands as the frame read it.
   * `player` is the actor and is left out where this character acted, which
   * is how the Talk card already tells `You say` from `Soul says`.
   */
  private asAction(line: StreamLine, text: string, block: Block): Block {
    if (!this.actions || !EMOTE_SHAPED.has(block.type)) return block;
    const hit = this.actions(text);
    if (hit === null) return block;
    return this.build(
      line,
      'conversation-action',
      {
        action: hit.action,
        player: hit.actor ?? undefined,
        target: hit.target ?? undefined,
        message: hit.message
      },
      text,
      tuning().parse.baseConfidence
    );
  }

  /**
   * A whole line the server's message table composes (todo 109). Open to
   * `unknown` only, and last: every frame and every other table has had its
   * say. A row about casting — a `spell`-linked row, or one whose lines say
   * *casts*, *sings* or *invokes* — is read as `spell-cast` in the frame's
   * own groups, by the line's role: the caster's line fills `spell` then
   * `target`, the target's line names the caster and lands on `you`, the
   * room's line names caster, spell and target; a `%d` is the `amount`
   * (`Message.cs` documents the order). Anything else is `realm-message`
   * with the row's number and role, so the line is explained and attributed
   * without a guess at what it means.
   */
  private asRealmMessage(line: StreamLine, text: string, block: Block): Block {
    if (!this.messages || block.type !== 'unknown') return block;
    /*
     * Not a line the prompt is glued to: a template that opens with `%s` would
     * take the prompt into its first name (`[HP=67]:Towser swings…`), and the
     * tail after the prompt is classified on its own (`tailAfterPrompt`).
     */
    if (STATUS_LINE_START.test(text)) return block;
    const hit = this.messages(text);
    if (hit === null) return block;
    const confidence = tuning().parse.baseConfidence;
    const names = hit.fills.filter((fill, index) => hit.numeric[index] !== true && fill.length > 0);
    const figure = hit.fills.find((_, index) => hit.numeric[index] === true);
    const castShaped = hit.kind === 'spell' || hit.kind === 'cast';
    if (castShaped && /\b(casts?|sings?|invokes?|cast)\b/.test(hit.template) && names.length > 0) {
      const groups: Record<string, string> = {};
      if (hit.role === 1) {
        groups['caster'] = 'You';
        groups['spell'] = names[0]!;
        if (names[1] !== undefined) groups['target'] = names[1];
      } else if (hit.role === 2) {
        groups['caster'] = names[0]!;
        if (names[1] !== undefined) groups['spell'] = names[1];
        groups['target'] = 'you';
      } else {
        groups['caster'] = names[0]!;
        if (names[1] !== undefined) groups['spell'] = names[1];
        if (names[2] !== undefined) groups['target'] = names[2];
      }
      if (figure !== undefined) groups['amount'] = figure;
      if (groups['spell'] === undefined) {
        return this.build(line, 'realm-message', this.messageGroups(hit), text, confidence);
      }
      groups['message'] = String(hit.number);
      return this.build(line, 'spell-cast', groups, text, confidence);
    }
    return this.build(line, 'realm-message', this.messageGroups(hit), text, confidence);
  }

  private messageGroups(hit: MessageHit): Record<string, string> {
    return {
      message: String(hit.number),
      role: String(hit.role),
      kind: hit.kind,
      ...(hit.fills.length > 0 ? { fills: hit.fills.join('|') } : {})
    };
  }

  /**
   * A whole line the realm knows as a death sentence is one monster dying.
   *
   * Only `unknown` is open to it: the sentence is free text per monster type
   * (`MobType.DeathMessage.Line3`) and matched whole, so a line any frame or
   * the spell table already read stands. The lookup answers with every monster
   * the sentence belongs to, and **the room settles which** (2026-09-12): the
   * server's table shares `The dog yelps loudly, and dies.` between the wild
   * dog and the mangy dog, and prints `The kobold falls to the ground with a
   * shriek!` for a monster the room listed as `thin kobold`, so the occupants
   * are asked which of them answers to a candidate — `answersTo`: exactly, or
   * with one leading word dropped where the realm knows the shorter name and
   * not the longer, so `kobold thief` never dies on the kobold's line. One
   * answer is `mob`, in the room's own
   * spelling, which is the spelling `FightTracker.diedNamed` removes by; a
   * candidate nobody in the room answers to is still `mob` when it is the
   * only one; several left standing are kept as `mobs`, `|`-separated, and
   * named by nothing — refused rather than guessed, and the experience line
   * that follows this character's own kill can still say which
   * (`CharacterTracker.deathSentenceBefore`).
   */
  private asDeathSentence(line: StreamLine, text: string, block: Block): Block {
    if (!this.deaths || block.type !== 'unknown') return block;
    const candidates = this.deaths(text);
    if (candidates.length === 0) return block;
    const here = this.answeringTo(candidates);
    const confidence = tuning().parse.baseConfidence;
    if (here.length === 1) {
      return this.build(line, 'mob-dies', { mob: here[0] }, text, confidence);
    }
    if (here.length === 0 && candidates.length === 1) {
      return this.build(line, 'mob-dies', { mob: candidates[0] }, text, confidence);
    }
    const left = here.length > 0 ? here : candidates;
    return this.build(line, 'mob-dies', { mobs: left.join('|') }, text, confidence);
  }

  /**
   * The occupants answering to any of `candidates` (in `mobKey` spelling),
   * exactly or with the modifier the server hung on the name — `thin kobold`
   * answers to `kobold` — each once, in the room's own spelling.
   */
  private answeringTo(candidates: readonly string[]): string[] {
    const found: string[] = [];
    const known = (name: string): boolean => this.names?.mob(name) !== undefined;
    for (const who of this.names?.present() ?? []) {
      const name = who.trim();
      if (name.length === 0 || found.includes(name)) continue;
      const spelling = mobKey(name);
      if (candidates.some((candidate) => answersTo(spelling, candidate, known))) found.push(name);
    }
    return found;
  }

  /**
   * Fills in who and what a combat line names, from the room and the realm.
   *
   * Three patterns capture the whole run of words inside the frame, because
   * nothing in the grammar says where a name stops and the realm's own attack
   * text starts — see the note beside `mob-hits` in `patterns.ts`. Which end
   * of `line` the name sits on is the rule's `resolve`: a monster's blow names
   * itself first, this character's names its target last, and a blow between
   * two other parties names both. Where neither source can say, the group is
   * left out — except that a rule may say its leading word is a name by
   * grammar (`nameFallback`), which is how a hidden player's opening blow gets
   * an attacker before any listing has shown them.
   */
  private resolveNames(rule: Rule, groups: Record<string, string | undefined>): void {
    const middle = groups['line'];
    const first = groups['first'];
    delete groups['first'];
    if (middle === undefined) return;
    const mode = rule.resolve ?? 'attacker';

    if (mode === 'target') {
      const named = this.names ? nameAtEnd(middle, this.names) : null;
      if (named !== null) groups['target'] = named;
      else if (rule.nameFallback) {
        const byGrammar = targetByGrammar(middle);
        if (byGrammar !== null) groups['target'] = byGrammar;
      }
      return;
    }

    if (mode === 'attacker') {
      const named = this.names ? nameInMessage(middle, this.names) : null;
      if (named !== null) groups['attacker'] = named;
      else if (rule.nameFallback && first !== undefined && !ARTICLE.test(first)) {
        // A name by grammar alone. `Acid burns you for 1 damage!` has the
        // same shape as `Rend chops you for 9 damage!`, so the tracker holds
        // this to the roster and the room before it becomes an attacker.
        //
        // **Never an article** (todo 30, 2026-09-12), which the `both` branch
        // below has always refused and this one did not: `The short half-ogre
        // bodyguard swings at you with their battle-hammer!` named `The` as
        // the attacker, and auto-combat then sent `aa The short half-ogre
        // bodyguard` — four times, each answered `Your command had no
        // effect.` The room lists the monster without its article, so the
        // name is there to be had; taking the first capitalised word is the
        // fallback for when it is *not*, and `The` is never a name.
        groups['attacker'] = first;
        groups['guessed'] = 'attacker';
      }
      return;
    }

    // both: the attacker leads, the target trails, and the realm's table is
    // consulted only for the target — see `nameLeading`.
    let rest = middle;
    const leading = this.names ? nameLeading(middle, this.names) : null;
    if (leading !== null) {
      groups['attacker'] = leading;
      rest = middle.slice(leading.length);
    } else if (rule.nameFallback) {
      const word = CAPITALISED_FIRST_WORD.exec(middle);
      if (word && !ARTICLE.test(word[1] ?? '')) {
        groups['attacker'] = word[1];
        rest = middle.slice(word[0].length);
      }
    }
    const named = this.names ? nameAtEnd(rest, this.names) : null;
    if (named !== null) groups['target'] = named;
    else if (rule.nameFallback) {
      const byGrammar = targetByGrammar(rest);
      if (byGrammar !== null) groups['target'] = byGrammar;
    }
  }

  /**
   * Attaches what this character said to the receipt confirming it was said.
   *
   * `--- Telepath Sent to Soul ---` and `--- Message Directed to Soul ---`
   * name the resolved recipient and nothing else — the body is never echoed —
   * so the Talk card could only show the framing of a message this character
   * sent, never the message. The command that provoked the receipt is the one
   * record of the words, and it is bound here because blocks are the fact
   * stream every consumer reads: a body only the sender's composer knew would
   * be invisible to a telepath typed at the console or sent by `Remotes`.
   *
   * The recipient must extend the name as typed, because the server resolves
   * a target by prefix — `/brack hi` is answered `to Brackle` — and each
   * sigil answers only its own receipt. Where nothing matches, `sent` is
   * absent rather than guessed: a wrong body on a receipt is the client
   * misquoting its own player.
   *
   * Deliberately a group of its own (`sent`), never `message`. Three
   * consumers — the player registry's sighting, `Remotes` and the tracker's
   * remote vitals — recognise the receipt as this character's own outbound
   * half by `message` being absent, and a receipt carrying one would file
   * this character's own words as the *recipient* speaking: an `@health`
   * answer sent by telepath would be read back as the recipient's vitals.
   */
  private bindReceipt(type: BlockType, groups: Record<string, string | undefined>): void {
    if (this.addressed === null) return;
    if (type !== 'conversation-telepath' && type !== 'conversation-directed') return;
    // An incoming line on the same channel carries a message; a receipt cannot.
    if (groups['message'] !== undefined) return;
    const to = groups['player'];
    if (to === undefined) return;
    if (this.addressed.sigil !== (type === 'conversation-telepath' ? '/' : '>')) return;
    if (!to.toLowerCase().startsWith(this.addressed.name.toLowerCase())) return;
    groups['sent'] = this.addressed.body;
    this.addressed = null;
  }

  /**
   * A floor listing that is really a search's answer, retyped.
   *
   * Both answers to a bare `search` land here: a listing consumes the slot and
   * comes back as `room-hidden-items`, and `Your search revealed nothing.`
   * consumes it and is left exactly as it was. Consuming on the refusal too is
   * what stops the slot outliving its own question and turning the *next*
   * room's floor into a discovery.
   */
  private answerSearch(line: StreamLine, text: string, block: Block): Block {
    if (!this.searching) return block;
    /*
     * Every other way the question can end, so the slot cannot outlive it.
     *
     * `Your search revealed nothing.` is the empty listing. The other two are
     * the server refusing to look at all, read out of `Player.TrySearch`: a
     * room too dark to see (`room-light`) and a blind character
     * (`room-unseen`).
     */
    if (
      block.type === 'user-search-failed' ||
      block.type === 'room-light' ||
      block.type === 'room-unseen' ||
      /*
       * And a room, which is the backstop for an answer nothing here
       * recognises — the failure this was found by. `You may not search while
       * attacking!` is a **third** refusal (`Player.TrySearch` again) and it
       * has no pattern, so it classified as `unknown` and left the slot armed;
       * it is in the corpus twice, both times immediately after a bare `sea`
       * (`captures/006:265` and `captures/008:413`). The next room the
       * character walked into then had its **open** floor retyped as a
       * discovery — which loses it altogether, because the `room-items` case
       * is what writes the draft, and had `AutoLoot` asking for coins lying in
       * the open by a count that would take one pile and leave the rest.
       *
       * A room's name arrives before its `You notice`, so this catches it
       * exactly. The cost is the reverse order — a `n` and a `sea` typed in
       * one breath, where the room answers first and clears a slot the search
       * has not used yet — and that is the cheap direction: a hidden find
       * drawn as an open one, corrected by the next look. Enumerating the
       * refusals is what makes that window rare; the room bound is what makes
       * the *expensive* failure impossible, including for refusals nobody has
       * captured yet.
       */
      block.type === 'room-name'
    ) {
      this.searching = false;
      return block;
    }
    if (block.type !== 'room-items') return block;
    this.searching = false;
    return this.build(line, 'room-hidden-items', block.groups, text, block.confidence);
  }

  private build(
    line: StreamLine,
    type: BlockType,
    groups: Record<string, string | undefined>,
    text: string,
    confidence: number
  ): Block {
    // Optional groups come through as undefined; drop them so consumers can use
    // `in` and `??` without tripping over keys that exist but hold nothing.
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(groups)) {
      if (value !== undefined) clean[key] = value;
    }

    return {
      seq: line.seq,
      at: line.at,
      type,
      domain: domainOf(type),
      groups: clean,
      text,
      confidence
    };
  }

  /**
   * Accumulates multi-line blocks, returning one when it completes.
   *
   * `type` is what the rule table made of this same line, which only a
   * `wraps: 'record'` batch reads: a line the table claimed is one the record
   * cannot continue through.
   */
  private feedBatch(line: StreamLine, text: string, type: BlockType): BatchBlock | undefined {
    if (!this.batch) {
      const rule = BATCH_RULES.find((candidate) => candidate.header.test(text));
      if (!rule) return undefined;
      // A record already whole on its header line was read by the single-line
      // rule; there is nothing to join.
      if (rule.wraps === 'record' && rule.qualifiers.some((q) => q.test(text))) return undefined;
      /*
       * The header's own captures are kept.
       *
       * An `array` batch used to publish `groups: {}` and throw them away, so a
       * header that states a fact about the whole listing — `Valor members (2)`
       * names the gang its rows belong to, and how many rows it sent — was
       * parsed and discarded. The rows alone cannot say either: a member row
       * names a person, not the gang. That is the shape this project calls a
       * fact the wire produced and nobody kept.
       */
      const heading = rule.header.exec(text)?.groups;
      const head: Record<string, string> = {};
      if (heading) {
        for (const [key, value] of Object.entries(heading)) {
          if (value !== undefined) head[key] = value;
        }
      }
      this.batch = { rule, lines: [text], startedAt: line.at, seq: line.seq, head };
      return undefined;
    }

    this.batch.lines.push(text);
    const { rule, lines } = this.batch;

    /*
     * A batch ends at the status line, or when it runs out of room.
     *
     * The status line is the unambiguous terminator — the server has moved on —
     * and it is matched **case-insensitively**, which the exported
     * `STATUS_LINE` is not: two MajorMUD realms in the corpus print `[hp=`
     * (captures/076, 43 times), and a batch that did not stop there ran to its
     * cap and swallowed the room, the coins and the occupants that followed a
     * `who`. Only the terminator is loosened; what a status line *means* is
     * still `STATUS_LINE`'s to say.
     *
     * **Two spellings of one fact, and this is the exemption with its date on
     * it.** On those realms the batch now closes correctly and the very line
     * that closed it is still not read as a status line, so they get framing
     * without vitals. Loosening `STATUS_LINE` itself is a *wire* change — it
     * decides what health the client believes — and the captures that would
     * settle it are scrubbed (`[hp=xxx/XXX`, digits replaced), so no capture
     * on disk shows a real lower-cased prompt with numbers in it. Held until
     * one does, or until `bbs.bearfather.net` is observed pre-login printing
     * one; a framing terminator that is wrong costs a swallowed room, and a
     * vitals pattern that is wrong costs a character.
     *
     * The cap is the backstop behind that, and for a `who` it is a tuning key
     * rather than a number here: the length of that listing is the realm's
     * population. See `BatchRule.maxLines`.
     */
    const cap = rule.maxLines === 'roster' ? tuning().parse.rosterLines : rule.maxLines;
    if (rule.wraps === 'record') {
      /*
       * A record closes on its own terminator, not the prompt's: the joined
       * sentence satisfying a qualifier is the whole block, and it has to be
       * handed on before `Obvious exits:` completes the room it belongs to.
       * Anything else that ends it — the table reading this line as something
       * of its own, the prompt, the cap — ends it with nothing: the lines were
       * each offered to the table on their own already.
       */
      const whole = foldWraps(rule, lines).some((joined) =>
        rule.qualifiers.some((qualifier) => qualifier.test(joined))
      );
      if (!whole) {
        const ended = type !== 'unknown' || lines.length >= cap || STATUS_LINE_START.test(text);
        if (ended) this.batch = null;
        return undefined;
      }
    } else {
      const done = lines.length >= cap || STATUS_LINE_START.test(text);
      if (!done) return undefined;
    }

    const rows: Array<Record<string, string>> = [];
    const merged: Record<string, string> = {};

    for (const candidate of foldWraps(rule, lines)) {
      for (const qualifier of rule.qualifiers) {
        const match = qualifier.exec(candidate);
        if (!match?.groups) continue;
        const groups: Record<string, string> = {};
        for (const [key, value] of Object.entries(match.groups)) {
          if (value !== undefined) groups[key] = value;
        }
        if (Object.keys(groups).length === 0) continue;
        if (rule.shape === 'array') rows.push(groups);
        else Object.assign(merged, groups);
      }
    }

    const seq = this.batch.seq;
    const at = this.batch.startedAt;
    const head = this.batch.head;
    this.batch = null;

    if (rule.shape === 'object' && Object.keys(merged).length === 0) return undefined;
    if (rule.shape === 'array' && rows.length === 0) return undefined;

    return {
      seq,
      at,
      type: rule.type,
      domain: domainOf(rule.type),
      // An `object` batch's own qualifiers win over the header where both name
      // a field: the header is the coarser statement of the two.
      groups: rule.shape === 'object' ? { ...head, ...merged } : head,
      rows: rule.shape === 'object' ? [merged] : rows,
      text: lines.join('\n'),
      confidence: tuning().parse.baseConfidence
    };
  }
}

/**
 * The target of a plain melee blow, by grammar alone, when nothing has listed it.
 *
 * `You slash the orc rogue` is one verb and a name, and a monster the room has
 * not listed and the realm does not know — a derivative's, or one met before
 * the room printed — still has to be a target, or this character is fighting
 * nothing. What is refused is exactly the shape that produced the 424 phantom
 * targets: a spell or a throw, which puts an article or a preposition between
 * the verb and the name (`fire an acid jet at Thrag`, `hurl your chakram at
 * giant crab`). Those name nothing here and wait for the room to say.
 */
function targetByGrammar(middle: string): string | null {
  const match = GRAMMAR_TARGET.exec(middle.trim());
  const target = match?.groups?.['target'];
  if (!target) return null;
  if (POSSESSIVE_LED.test(target)) return null;
  if (CONNECTIVE.test(` ${target} `)) return null;
  // A monster's name is at most four words (`captain of the guard`); a spell's
  // effect text is a sentence, and a sentence is not a target.
  if (target.split(SPACES).length > 4) return null;
  return target;
}

/**
 * Whether this line opens a record the server may have wrapped — the header
 * of a `wraps: 'record'` batch rule. Asked by `classifyLine` before the batch
 * is fed, so the header itself is kept out of the room description.
 */
function opensRecord(text: string): boolean {
  return BATCH_RULES.some((rule) => rule.wraps === 'record' && rule.header.test(text));
}

/**
 * Rejoins the lines the server folded, for a rule that says its block wraps.
 *
 * The server formats to a width of its own choosing and puts a real CRLF at the
 * fold, so a long inventory arrives as two lines of which only the first
 * announces itself. A line matching no qualifier, in a block that wraps, is the
 * tail of the one above it — joined with a single space, because the fold ate
 * one: `padded gloves` + `(Hands)` is what was sent, and gluing them without it
 * produces an item nobody carries.
 *
 * Two lines are never folded. A line before anything has matched has nothing to
 * continue, and the status line is the *terminator* — appending it would put
 * `[HP=34]:` on the end of whichever field happened to come last.
 */
function foldWraps(rule: BatchRule, lines: string[]): string[] {
  if (rule.wraps === 'assemble') return assembleWraps(rule, lines);
  // One sentence, folded at word boundaries: a single space is what each fold ate.
  if (rule.wraps === 'record') {
    return [
      lines
        .map((piece) => piece.trim())
        .filter((piece) => piece.length > 0)
        .join(' ')
    ];
  }
  if (rule.wraps !== true) return lines;

  const folded: string[] = [];
  let open = false;
  for (const line of lines) {
    const starts = rule.qualifiers.some((qualifier) => qualifier.test(line));
    if (!starts && open && line.length > 0 && !STATUS_LINE_START.test(line)) {
      folded[folded.length - 1] = `${folded[folded.length - 1]} ${line}`;
      continue;
    }
    folded.push(line);
    open = starts;
  }
  return folded;
}

/**
 * Joins fragments until they make a row, for a block whose rows may be folded
 * anywhere — including before the part that would have qualified them.
 *
 * A row is *open* until the joined text matches a qualifier, and *closed* once
 * it does; the next fragment starts a new row. The header is never joined to,
 * and neither is the status line that ends the block. A fragment that never
 * completes a row stays on its own line and matches nothing, which is the same
 * loss as before this existed and never a false row.
 */
function assembleWraps(rule: BatchRule, lines: string[]): string[] {
  const matches = (text: string): boolean => rule.qualifiers.some((q) => q.test(text));
  const out: string[] = [];
  let open = false;
  for (const [index, line] of lines.entries()) {
    if (index === 0 || line.trim().length === 0 || STATUS_LINE_START.test(line)) {
      out.push(line);
      open = false;
      continue;
    }
    if (open) {
      const joined = `${out[out.length - 1]} ${line.trim()}`;
      out[out.length - 1] = joined;
      open = !matches(joined);
      continue;
    }
    out.push(line);
    open = !matches(line);
  }
  return out;
}
