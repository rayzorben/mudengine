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
import { nameAtEnd, nameInMessage, nameLeading, type NameSources } from '../../shared/mobs';
import { BATCH_RULES, RULES, STATUS_LINE, type BatchRule, type Rule } from './patterns';
import type { StreamLine } from '../../shared/types';
import { tuning } from '../app/tuning';

/** SGR foreground codes present in a raw line, in order of appearance. */
export function foregroundCodes(raw: string): number[] {
  const codes: number[] = [];
  for (const match of raw.matchAll(/\x1B\[([0-9;]*)m/g)) {
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
  for (const [index, raw] of text.split(/\s+/).entries()) {
    const word = raw.replace(/^[^A-Za-z0-9&]+|[^A-Za-z0-9.&]+$/g, '');
    if (word === '') continue;
    if (/^[A-Z0-9&]/.test(word)) continue;
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
  if (/[!?;:]/.test(text)) return false;
  /*
   * Two runs of spaces inside the line are *columns*, not a name. `Item
   * Quantity    Price` — the heading over a shop's stock — is title-cased and
   * unpunctuated and used to become the room, with every row under it read
   * as its description. Two rather than one, measured: four of the 3,790
   * names in the shipped realm carry a single doubled space (`Crumbling
   * Catacombs, West Stairwell`), and none carries two.
   */
  if (/(?:\S\s{2,}\S.*){2}/.test(text)) return false;
  /*
   * A full stop is allowed only where it abbreviates. `St.` and `Rd.` end a
   * short token; a sentence's full stop follows a whole word, so a stop after
   * five or more letters is prose.
   */
  if (/(?<=[A-Za-z]{5})\.(?=\s|$)/.test(text)) return false;
  // Pronoun-led lines are prose, not titles. "You" is by far the commonest.
  // `The`, `A` and `An` are *not* here: they begin plenty of real rooms, and
  // title case already separates `The Silver River` from `The city wall is...`.
  if (/^(You|He|She|It|They|We|I)\b/.test(text)) return false;
  return titleCased(text);
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
  constructor(private readonly names?: NameSources) {}

  /** Records an outbound command. Not cleared on use: two lines may need it. */
  observeCommand(command: string): void {
    this.lastCommand = command.trim();
    /*
     * An addressed message fills the receipt slot; anything else leaves it.
     * An intervening command does not invalidate what the receipt will
     * confirm — the server answers in order, so the receipt for `/soul hi`
     * still means `/soul hi` after an `n` has gone out behind it — and a
     * refused send whose receipt never comes is overwritten by the next
     * addressed message rather than cleared by guesswork.
     */
    const address = /^([/>])\s*([A-Za-z][\w'-]*)\s+(\S.*)$/.exec(this.lastCommand);
    if (address) {
      this.addressed = {
        sigil: address[1] as '/' | '>',
        name: address[2]!,
        body: address[3]!.trim()
      };
    }

    // A bare `search`, in any of the realm's four spellings for it.
    if (commandOf(this.lastCommand) === 'Search' && !/\s/.test(this.lastCommand)) {
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
    let batch = this.feedBatch(line, text);

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
      const found = this.feedBatch(line, rest);
      batch ??= found;
      tails.push(next);
      // `tailAfterPrompt` always returns a strictly shorter string, so this
      // terminates on any input.
      rest = next.type === 'status-line' ? tailAfterPrompt(rest) : null;
    }

    return {
      block,
      ...(batch ? { batch } : {}),
      ...(tails.length > 0 ? { tails } : {})
    };
  }

  reset(): void {
    this.lastCommand = '';
    this.addressed = null;
    this.searching = false;
    this.inDescription = false;
    this.batch = null;
  }

  private classifyLine(line: StreamLine, text: string): Block {
    const block = this.answerSearch(line, text, this.matchLine(line, text));

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

    return this.build(line, 'room-description', {}, text, tuning().parse.baseConfidence);
  }

  private matchLine(line: StreamLine, text: string): Block {
    /*
     * The server echoes what we send. Checked ahead of the table rather than as
     * a pattern in it, because the thing that makes it an echo is not its shape
     * — it is that it equals the command just sent. `Rest` typed at the prompt
     * echoes a line that matches `room-name` and passes `looksLikeRoomName`, so
     * without this the client would believe it had walked into a room called
     * Rest.
     */
    if (this.lastCommand.length > 0 && text === this.lastCommand) {
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
      if (rule.type === 'room-name' && this.batch?.rule.tailsLookLikeRooms === true) continue;
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
      else if (rule.nameFallback && first !== undefined) {
        // A name by grammar alone. `Acid burns you for 1 damage!` has the
        // same shape as `Rend chops you for 9 damage!`, so the tracker holds
        // this to the roster and the room before it becomes an attacker.
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
      const word = /^([A-Z][\w'-]*)\s/.exec(middle);
      if (word && !/^(?:The|A|An)$/.test(word[1] ?? '')) {
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

  /** Accumulates multi-line blocks, returning one when it completes. */
  private feedBatch(line: StreamLine, text: string): BatchBlock | undefined {
    if (!this.batch) {
      const rule = BATCH_RULES.find((candidate) => candidate.header.test(text));
      if (!rule) return undefined;
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
    const done = lines.length >= cap || /^\[(?:hp|h)=/i.test(text);
    if (!done) return undefined;

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
  const match = /^(?:critically )?\w+ (?:the )?(?<target>[A-Za-z][\w' -]*)$/.exec(middle.trim());
  const target = match?.groups?.['target'];
  if (!target) return null;
  if (/^(?:a|an|your|his|her|its|their) /i.test(target)) return null;
  if (/ (?:at|with|upon|on|into|through|from|and) /i.test(` ${target} `)) return null;
  // A monster's name is at most four words (`captain of the guard`); a spell's
  // effect text is a sentence, and a sentence is not a target.
  if (target.split(/\s+/).length > 4) return null;
  return target;
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
  if (rule.wraps !== true) return lines;

  const folded: string[] = [];
  let open = false;
  for (const line of lines) {
    const starts = rule.qualifiers.some((qualifier) => qualifier.test(line));
    if (!starts && open && line.length > 0 && !/^\[(?:HP|H)=/.test(line)) {
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
    if (index === 0 || line.trim().length === 0 || /^\[(?:HP|H)=/.test(line)) {
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
