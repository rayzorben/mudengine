/**
 * The realm's own words for an effect beginning and ending on this character,
 * and the shape the client keeps them in.
 *
 * The server prints two kinds of line when a spell lands. The *frame* is
 * composed in its code and names the spell — `You cast bless on yourself!`,
 * `You invoke the way of the tiger.` — and `patterns.ts` matches those as
 * frames. The *message* is data: every duration spell carries a three-line
 * record in the server's message table, line 1 printed on expiry
 * (`The effects of way of the tiger wear off!`) and line 3 printed when the
 * effect lands and again on every `st` (`You feel ferocious!`). The realm
 * databases on hand do not ship that table — a Spells row carries only its
 * message *number* (`DescMsg`, ability 115) — so the sentences themselves
 * live in `resources/world/spell-messages.csv`, extracted from the server's
 * data and keyed by the spell's own name, which is what the buff list and
 * the blessing configuration already speak.
 *
 * **One sentence may belong to several spells.** `You feel lucky!` begins
 * bless, chant, weapon major bless, glass orb and dark blessing, because they
 * share message record 8539. A lookup therefore answers with every spell a
 * sentence could mean, in file order, and the caller decides — from the cast
 * it just saw, from the spellbook, or by keeping the whole set as candidates.
 * Refusing to pick is what keeps a chant from being written down as a bless.
 *
 * **Matched word by word, never as a substring.** The sentences are stored in
 * a trie keyed on whitespace-separated words, so a lookup walks one node per
 * word and the double space the message table carries in `The  feeling of
 * tranquility wears off.` is one word boundary rather than a spelling. A
 * sentence the table does not hold walks off the trie and answers null.
 *
 * `src/shared/` is dependency-free by rule, so this file reads nothing: the
 * loader that opens the shipped file is `src/main/world/SpellMessages.ts`,
 * and what the client *learns* — a start or stop the file lacks — is kept per
 * realm by `RealmLore` and consulted through {@link SpellLore}.
 */

export type SpellMessageKind = 'start' | 'stop';

/**
 * An effect the tables cannot name, held under the sentence that announces it.
 *
 * A monster's spell prints its own message and names nothing this client can
 * read, and no realm database on hand ships the message table to look one up
 * in — so *which spell* has no answer. *Which effect* does: the server prints
 * `DescMessage.Line3` when the spell lands (`Spell.cs:1233`, `:1360`) and
 * prints the same line again for every timed effect on the sheet
 * (`StatCommand.cs:50`), so the sentence is the effect's identity on the wire
 * and the sheet is the listing that maintains it.
 *
 * Marked, so no reader mistakes one for a spell's name: `spellNamed` will
 * never resolve it, a blessing configuration can never match it, and the card
 * that draws it can say what it is instead of printing a sentence as a noun.
 */
const UNNAMED_MARK = 'effect: ';

/** The key an unnameable effect is held under: its own sentence, marked. */
export function unnamedEffect(sentence: string): string {
  return `${UNNAMED_MARK}${sentence.trim()}`;
}

/** Whether a buff's `spell` is a sentence this client could not name. */
export function isUnnamedEffect(spell: string): boolean {
  return spell.trimStart().toLowerCase().startsWith(UNNAMED_MARK);
}

/** The sentence behind such a key, or null for an ordinary spell name. */
export function unnamedEffectSentence(spell: string): string | null {
  const text = spell.trimStart();
  if (!isUnnamedEffect(text)) return null;
  const sentence = text.slice(UNNAMED_MARK.length).trim();
  return sentence.length > 0 ? sentence : null;
}

/**
 * Whether the stat sheet has ever reprinted an effect's sentence.
 *
 * `no` is a finding, not an absence: a sheet was read while the sentence
 * would have been on it and did not carry it, so whatever printed that line
 * is not a *lasting* effect here — an instant spell, or a refusal wearing an
 * effect's grammar (`You are poisoned!` answering a `rest`). Either way there
 * is nothing for this client to hold, and nothing to spend another `st` on.
 */
export type EffectLasting = 'unknown' | 'yes' | 'no';

/** How sure this realm is that an effect inflicts a condition. */
export type CauseVerdict = 'suspected' | 'confirmed';

/** What one realm has worked out about one sentence nothing could name. */
export interface LearnedEffect {
  /** The sentence the server printed when it landed — the effect's identity. */
  text: string;
  /** Epoch ms of the first sighting. */
  at: number;
  /** See {@link EffectLasting}. */
  lasting: EffectLasting;
  /**
   * What the effect is suspected or known to inflict, keyed by the condition
   * (`Afflictions`). Absent until something was deduced; a condition that
   * arrived without the effect up is deleted rather than downgraded, because
   * a suspicion the wire contradicted is not a weaker suspicion.
   */
  causes?: Record<string, CauseVerdict>;
}

/**
 * What a realm remembers about the effects it could not name.
 *
 * Separate from the two sentence books because it is a different kind of
 * fact: the books answer *what does this line mean*, and this answers *what
 * has this realm worked out about a line nothing means yet*. The parse path
 * holds it through {@link SpellLore} for the same reason it holds them —
 * it may not open a file, and a test wants neither.
 */
export interface EffectLedger {
  /** What is known about a sentence, or null when it is new here. */
  seen(text: string): LearnedEffect | null;
  /** Records the sheet's verdict on whether the sentence is a lasting effect. */
  lasting(text: string, lasting: Exclude<EffectLasting, 'unknown'>, at: number): void;
  /**
   * Records what the effect inflicts. `null` retracts: the condition arrived
   * while the effect was not up, so the effect is not what causes it.
   */
  causes(text: string, condition: string, verdict: CauseVerdict | null): void;
}

/**
 * The key one effect is held under: its sentence, whitespace-normalised and
 * lower-cased.
 *
 * Whitespace for the reason {@link SpellMessageBook}'s trie normalises it —
 * the message table carries a double space in `The  feeling of tranquility
 * wears off.` — and case because the *identity* travels as a spell key
 * (`unnamedEffect`), which is lower-cased wherever a spell name is. The
 * server's own spelling is kept alongside, in `LearnedEffect.text`, since
 * that is what is printed back and what the trie still matches on.
 */
export function effectKey(text: string): string {
  return wordsOf(text).join(' ').toLowerCase();
}

/** A ledger that remembers nothing. The zero-data client. */
export const NO_EFFECT_LEDGER: EffectLedger = {
  seen: () => null,
  lasting: () => {},
  causes: () => {}
};

/** One spell's two sentences, as the shipped file states them. */
export interface SpellMessageRow {
  /** The spell's name, as the realm's Spells table spells it. */
  spell: string;
  /** Printed when the effect lands, and on every `st` while it lasts. */
  start: string | null;
  /** Printed when the effect ends. */
  stop: string | null;
}

/**
 * Every spell a sentence could be the beginning or the end of.
 *
 * Both lists are present because one sentence can be both — `A dark, menacing
 * cloud appears, flooding the room!` opens and closes song of hopelessness —
 * and a reader that wants a verdict compares the two.
 */
export interface SpellMessageHit {
  /** Spells this sentence begins, lower-cased, in file order. */
  starts: readonly string[];
  /** Spells this sentence ends, lower-cased, in file order. */
  stops: readonly string[];
}

/** The lower-cased, trimmed key every spell name is stored under. */
export function spellKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The spells a block's `spells` group names, which travel `|`-separated
 * (`Classifier.asSpellMessage`): a group is a string, and a spell's name never
 * holds that character. One decoder for every reader — the tracker's hold and
 * buff cases and the walker's onset gate — so the format cannot drift between
 * them.
 */
export function splitSpells(group: string | undefined): string[] {
  if (group === undefined) return [];
  return group
    .split('|')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** Compiled once: `wordsOf` runs on every line the classifier could not type. */
const SPACES = /\s+/;

/** The words of a sentence, which is what the trie is keyed on. */
export function wordsOf(sentence: string): string[] {
  return sentence
    .trim()
    .split(SPACES)
    .filter((word) => word.length > 0);
}

/**
 * Reads the shipped CSV.
 *
 * RFC 4180 quoting — a field may be quoted, a quoted field may hold commas and
 * newlines, and a doubled quote is a literal one — because the message table
 * has all three (`"You feel strong, but clumsy!"`, `"…utter ""Shirzak!"""`).
 * Columns are found by header name so the file can grow columns without
 * moving these. A row with no spell name is dropped: it names nothing the
 * buff list could hold.
 */
export function parseSpellMessagesCsv(text: string): SpellMessageRow[] {
  const records = parseCsv(text);
  const header = records[0];
  if (!header) return [];
  const column = (name: string): number => header.findIndex((cell) => cell.trim() === name);
  const spellAt = column('spell_name');
  const startAt = column('start');
  const stopAt = column('stop');
  if (spellAt < 0 || startAt < 0 || stopAt < 0) return [];

  const rows: SpellMessageRow[] = [];
  for (const record of records.slice(1)) {
    const spell = (record[spellAt] ?? '').trim();
    if (spell.length === 0) continue;
    const start = (record[startAt] ?? '').trim();
    const stop = (record[stopAt] ?? '').trim();
    rows.push({
      spell,
      start: start.length > 0 ? start : null,
      stop: stop.length > 0 ? stop : null
    });
  }
  return rows;
}

/**
 * RFC 4180, as above, for every shipped table: `actions.csv` and
 * `death-messages.csv` are read with it too.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      field = '';
      records.push(record);
      record = [];
    } else {
      field += ch;
    }
    i += 1;
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  // A blank line is no record.
  return records.filter((cells) => cells.some((cell) => cell.trim().length > 0));
}

interface TrieNode {
  next: Map<string, TrieNode>;
  starts: Set<string>;
  stops: Set<string>;
}

const node = (): TrieNode => ({ next: new Map(), starts: new Set(), stops: new Set() });

/**
 * The sentences, held for the two questions the parse path asks: *what does
 * this line mean*, walked word by word, and *what does this spell say when it
 * begins or ends*, answered from a map beside the trie so the tracker can
 * tell a buff whose ending it would recognise from one it would not.
 */
export class SpellMessageBook {
  private readonly root = node();
  private readonly startBy = new Map<string, string>();
  private readonly stopBy = new Map<string, string>();
  private sentences = 0;

  static fromRows(rows: readonly SpellMessageRow[]): SpellMessageBook {
    const book = new SpellMessageBook();
    for (const row of rows) {
      if (row.start !== null) book.add(row.spell, 'start', row.start);
      if (row.stop !== null) book.add(row.spell, 'stop', row.stop);
    }
    return book;
  }

  /** How many distinct sentences the trie holds. */
  get size(): number {
    return this.sentences;
  }

  /** Every spell with at least one sentence recorded. */
  spells(): string[] {
    return [...new Set([...this.startBy.keys(), ...this.stopBy.keys()])];
  }

  /**
   * Records a sentence for a spell. False when the spell already had one of
   * that kind — the first statement stands, and a caller that wants to
   * replace it says so with `remove` first.
   */
  add(spell: string, kind: SpellMessageKind, sentence: string): boolean {
    const key = spellKey(spell);
    const words = wordsOf(sentence);
    if (key.length === 0 || words.length === 0) return false;
    const by = kind === 'start' ? this.startBy : this.stopBy;
    if (by.has(key)) return false;

    let cursor = this.root;
    for (const word of words) {
      let next = cursor.next.get(word);
      if (!next) {
        next = node();
        cursor.next.set(word, next);
      }
      cursor = next;
    }
    if (cursor.starts.size === 0 && cursor.stops.size === 0) this.sentences += 1;
    (kind === 'start' ? cursor.starts : cursor.stops).add(key);
    by.set(key, words.join(' '));
    return true;
  }

  /** Forgets a spell's sentence of one kind. False when there was none. */
  remove(spell: string, kind: SpellMessageKind): boolean {
    const key = spellKey(spell);
    const by = kind === 'start' ? this.startBy : this.stopBy;
    const sentence = by.get(key);
    if (sentence === undefined) return false;
    by.delete(key);
    const leaf = this.walk(wordsOf(sentence));
    if (leaf) {
      (kind === 'start' ? leaf.starts : leaf.stops).delete(key);
      if (leaf.starts.size === 0 && leaf.stops.size === 0) this.sentences -= 1;
    }
    return true;
  }

  /** What a sentence means, or null when the trie has never seen it. */
  match(sentence: string): SpellMessageHit | null {
    const leaf = this.walk(wordsOf(sentence));
    if (!leaf || (leaf.starts.size === 0 && leaf.stops.size === 0)) return null;
    return { starts: [...leaf.starts], stops: [...leaf.stops] };
  }

  /** The sentence this spell prints when it lands, whitespace-normalised. */
  startOf(spell: string): string | null {
    return this.startBy.get(spellKey(spell)) ?? null;
  }

  /** The sentence this spell prints when it ends, whitespace-normalised. */
  stopOf(spell: string): string | null {
    return this.stopBy.get(spellKey(spell)) ?? null;
  }

  private walk(words: readonly string[]): TrieNode | null {
    let cursor: TrieNode | undefined = this.root;
    for (const word of words) {
      cursor = cursor.next.get(word);
      if (!cursor) return null;
    }
    return cursor === this.root ? null : cursor;
  }
}

/**
 * What the tracker asks about spell messages: the shipped words and the
 * learned ones together, and the two ways it teaches.
 *
 * An interface for the reason `MobLore` is one — the parse path may not open
 * a file, and a test wants neither the shipped table nor the learned store.
 */
export interface SpellLore {
  /** What a line means, from the shipped table and what this realm taught. */
  match(text: string): SpellMessageHit | null;
  /** The sentence a spell prints when it lands, from either source. */
  startOf(spell: string): string | null;
  /** The sentence a spell prints when it ends, from either source. */
  stopOf(spell: string): string | null;
  /**
   * A sentence seen on the wire that the table lacks, bound to a spell by the
   * cast it followed or the listing that ended it. Ignored where the shipped
   * table already speaks for that spell: the realm's word outranks a guess.
   */
  learn(spell: string, kind: SpellMessageKind, text: string, at: number): void;
  /** A learned sentence the wire has since contradicted. */
  unlearn(spell: string, kind: SpellMessageKind): void;
  /** What this realm has worked out about the effects it cannot name. */
  readonly effects: EffectLedger;
}

/** A lore that knows no sentence and learns none. The zero-data client. */
export const NO_SPELL_LORE: SpellLore = {
  match: () => null,
  startOf: () => null,
  stopOf: () => null,
  learn: () => {},
  unlearn: () => {},
  effects: NO_EFFECT_LEDGER
};

/**
 * Two books read as one, the shipped one first.
 *
 * `learn` writes to the second only when the first has nothing for that spell
 * and kind, and never a sentence the first already holds for anything — such
 * a line would have matched, so a cast it followed was not what printed it.
 * The hooks are for the owner of the learned book to persist and to say so.
 */
export function spellLoreOf(
  shipped: SpellMessageBook,
  learned: SpellMessageBook,
  hooks: {
    learned?(spell: string, kind: SpellMessageKind, text: string, at: number): void;
    unlearned?(spell: string, kind: SpellMessageKind): void;
    /** Where an unnameable effect's findings are kept. See {@link EffectLedger}. */
    effects?: EffectLedger;
  } = {}
): SpellLore {
  const merge = (a: SpellMessageHit | null, b: SpellMessageHit | null): SpellMessageHit | null => {
    if (!a) return b;
    if (!b) return a;
    return {
      starts: [...new Set([...a.starts, ...b.starts])],
      stops: [...new Set([...a.stops, ...b.stops])]
    };
  };
  return {
    match: (text) => merge(shipped.match(text), learned.match(text)),
    startOf: (spell) => shipped.startOf(spell) ?? learned.startOf(spell),
    stopOf: (spell) => shipped.stopOf(spell) ?? learned.stopOf(spell),
    learn: (spell, kind, text, at) => {
      const known = kind === 'start' ? shipped.startOf(spell) : shipped.stopOf(spell);
      if (known !== null || shipped.match(text) !== null) return;
      if (learned.add(spell, kind, text)) hooks.learned?.(spell, kind, text, at);
    },
    unlearn: (spell, kind) => {
      if (learned.remove(spell, kind)) hooks.unlearned?.(spell, kind);
    },
    effects: hooks.effects ?? NO_EFFECT_LEDGER
  };
}
