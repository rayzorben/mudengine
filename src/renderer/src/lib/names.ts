import type { WorldNames } from '@shared/world';
import { tuning } from './tuning';

export type NameKind = 'item' | 'mob' | 'spell' | 'player' | 'gang' | 'race' | 'class' | 'room';

/** A recognised name in a row of console text, by character column. */
export interface NameHit {
  name: string;
  kind: NameKind;
  /** Zero-based column of the first character. */
  start: number;
  /** Zero-based column one past the last. */
  end: number;
}

/** A place in a run of console rows: which row, and the column within it. */
export interface Cell {
  /** Index into the rows handed to `findAcross`. */
  line: number;
  /** Zero-based column. */
  col: number;
}

/**
 * One console row as handed to `findAcross`.
 *
 * `continues` is xterm's `isWrapped`: this row is the rest of the row above,
 * broken by the pane at a cell rather than by the server at a word, so the
 * two join with nothing between them and the text of the row above must keep
 * its trailing spaces — the space at the fold is a real cell there.
 */
export interface Row {
  text: string;
  continues: boolean;
}

/**
 * A recognised name that may begin on one row and end on the next.
 *
 * `end.col` is one past the last character, as in `NameHit`. `text` is what
 * was printed, in its own casing, with a fold collapsed to the space the
 * name has there — the string a lookup is asked for.
 */
export interface SpanHit {
  name: string;
  kind: NameKind;
  text: string;
  start: Cell;
  end: Cell;
}

/** A sentence cut into what is a name and what is around it, in order. */
export type NamedRun = { text: string; hit: null } | { text: string; hit: NameHit };

/**
 * A row of text as runs, so a card can draw the names in it as controls and
 * the rest as text. Pure over `find`, which already refuses part of a word
 * and prefers the longest name at a position; this only fills the gaps.
 */
export function runsOf(text: string, hits: readonly NameHit[]): NamedRun[] {
  const runs: NamedRun[] = [];
  let at = 0;
  for (const hit of hits) {
    if (hit.start > at) runs.push({ text: text.slice(at, hit.start), hit: null });
    runs.push({ text: text.slice(hit.start, hit.end), hit });
    at = hit.end;
  }
  if (at < text.length) runs.push({ text: text.slice(at), hit: null });
  return runs;
}

/** What a hard line break becomes when rows are joined: not a word character, so no word crosses it. */
const FOLD = '\n';

/**
 * Every name the realm knows, indexed for finding in a line of text.
 *
 * Built once per session from `WorldNames` and asked about the row under the
 * pointer, so a hover costs a few map lookups and no round trip. Names are
 * matched whole — `rat` is not `giant rat`, and `giant rat` is preferred over
 * `rat` when both would match — which is the least-stripping rule
 * `classifyOccupant` follows for the same reason: the longer name is the
 * more specific claim.
 */
export class NameIndex {
  private readonly kinds = new Map<string, NameKind>();
  /**
   * The people this character knows — the registry and the roster — kept
   * apart from the realm's names because they change while the realm's do
   * not, and because they **outrank** them: the shipped realm has a monster
   * called `nathaniel` and Nathaniel is a character on the test realm, and
   * the rule everywhere else is that a name the roster gave is a player, full
   * stop. Lower-cased, like every key here.
   */
  private players = new Set<string>();
  /** The people in the realm now — the ones that outrank a realm name. */
  private present = new Set<string>();
  /**
   * The gangs this character has heard of.
   *
   * A gang is an entity like a person or an item, and it is printed in the one
   * listing that establishes it — a `who` row's gang column — where it was the
   * only recognisable thing on the line that could not be clicked.
   *
   * Ranked **below a player and above the realm's own names**, which is the
   * tier a gang belongs in for the reason each neighbour is where it is. A
   * person standing in the realm is the most specific claim anything can make
   * about a word. A gang is a name somebody typed once when they founded it, so
   * it can collide with an item or a monster exactly as a player name can; but
   * unlike a player it is not *present*, so it must not take the realm's word
   * away wherever it happens to be printed... except that a gang the roster is
   * naming right now is as live as the people in it. The compromise the
   * evidence supports: a gang outranks the realm only where the realm has no
   * name for the word, which is the same tier a merely-*known* player sits in.
   */
  private gangs = new Set<string>();
  /** Bumped when the people change, so a memo over a search can key on it. */
  private revision = 0;

  constructor(names: WorldNames) {
    /*
     * Rooms first, so everything else outranks them. A room's name is the one
     * kind assembled out of ordinary words — `Silver Street`, `Guild Hall`,
     * `The Crimson Cave` — and where one collides with a monster or an item
     * the thing standing in front of you is the better answer. It is also the
     * largest table by far, and being overwritten is cheaper than being
     * checked for.
     */
    for (const name of names.rooms) this.add(name, 'room');
    // Items before monsters before spells, so a name in two tables keeps the
    // kind a card would answer with first — the same order `lookup` ranks.
    for (const name of names.spells) this.add(name, 'spell');
    for (const name of names.mobs) this.add(name, 'mob');
    for (const name of names.items) this.add(name, 'item');
    /*
     * Races and classes last, so they outrank all three: they are two closed
     * vocabularies of thirteen and fifteen words, and where one collides with
     * an item or a monster the realm's own character sheet is the better
     * answer. `Ranger`, `Druid` and `Mystic` are classes before they are
     * anything else on this realm, and `Human` is a race before it is a
     * monster called one.
     */
    for (const name of names.races) this.add(name, 'race');
    for (const name of names.classes) this.add(name, 'class');
  }

  get size(): number {
    return this.kinds.size;
  }

  /**
   * Replaces the people the console recognises. Case-insensitive, and under
   * the same floor as the realm's names: a character called `Bo` or `Rat`
   * would turn every `bo` and `rat` the server prints into a link to a
   * person — and, because a player outranks a realm name, take the realm's
   * `rat` away in the same row. The floor costs a very short name its link,
   * which is the trade `add` already makes for `net` and `sign`.
   *
   * **Only somebody in the realm now outranks a realm name.** `present` is
   * the online half of `known`; a name that is only known — offline, or seen
   * once by another character months ago, since the registry is the realm's
   * whole record — yields to the realm's word and links as a person only
   * where the realm has none. Without that tier a player once called `Lynx`
   * would take the realm's lynx away in every console on the realm, for good.
   */
  setPlayers(known: readonly string[], present: readonly string[] = known): void {
    const keys = (names: readonly string[]): Set<string> =>
      new Set(names.map((name) => name.trim().toLowerCase()).filter((key) => worthLinking(key)));
    this.players = keys(known);
    this.present = keys(present);
    this.revision += 1;
  }

  /**
   * Replaces the gangs the console recognises.
   *
   * Under the same floor as everything else: a gang called `Bo` would turn
   * every `bo` the server prints into a link, and the floor costs a very short
   * name its link exactly as it does for `net` and `sign`.
   */
  setGangs(gangs: readonly string[]): void {
    this.gangs = new Set(
      gangs.map((name) => name.trim().toLowerCase()).filter((key) => worthLinking(key))
    );
    this.revision += 1;
  }

  /** Which people and gangs this index knows, as a number that moves when they do. */
  get version(): number {
    return this.revision;
  }

  private kindOf(candidate: string): NameKind | undefined {
    if (this.present.has(candidate)) return 'player';
    const realm = this.kinds.get(candidate);
    if (realm !== undefined) return realm;
    if (this.players.has(candidate)) return 'player';
    return this.gangs.has(candidate) ? 'gang' : undefined;
  }

  /**
   * Every recognised name in a row, left to right, non-overlapping, longest
   * first at each position.
   */
  find(row: string): NameHit[] {
    const hits: NameHit[] = [];
    const words = tokenize(row);
    // Read once per row: this runs per word of every line the console prints.
    const maxWords = tuning().maxNameWords;
    let at = 0;
    while (at < words.length) {
      let taken = 0;
      for (let span = Math.min(maxWords, words.length - at); span >= 1; span -= 1) {
        const first = words[at]!;
        const last = words[at + span - 1]!;
        const candidate = row.slice(first.start, last.end).toLowerCase();
        const kind = this.kindOf(candidate);
        if (kind === undefined) continue;
        hits.push({ name: candidate, kind, start: first.start, end: last.end });
        taken = span;
        break;
      }
      at += Math.max(1, taken);
    }
    return hits;
  }

  /**
   * The same search over consecutive rows, plus any name broken across a
   * row boundary.
   *
   * Two things fold a line. The server folds some of its listings at a word
   * boundary and sends a hard break — the carried listing seen live on
   * 2026-08-28 arrived as `silk` at the end of one row and `trousers` at the
   * start of the next (docs/game-behaviour.md records that room text is
   * *not* folded, so this is per listing, not a width to assume). A pane
   * narrower than a line wraps the rest client-side, at the cell, with no
   * space at all. Read one row at a time, neither half is a name, and the
   * item that folded was the one item that could not be clicked.
   *
   * Each row is read on its own first and those hits stand: they are what
   * the row said before its neighbours were consulted, and a name that
   * straddles a boundary is added only where it overlaps none of them —
   * otherwise `small` ending one row and `shield of light` opening the next
   * would be read as `small shield`, taking away a name that was clickable
   * before. A hard break is joined as a space and only that marker is
   * collapsed, so a candidate within a row is still compared verbatim and
   * column padding never bridges two words. A straddle is accepted only when
   * the two halves are adjacent bare words: `silk.` above `trousers` stays
   * two words, as it should.
   */
  findAcross(rows: Row[]): SpanHit[] {
    const starts: number[] = [];
    let joined = '';
    rows.forEach((row, line) => {
      if (line > 0) joined += row.continues ? '' : FOLD;
      starts.push(joined.length);
      joined += row.text;
    });
    const locate = (at: number): Cell => {
      let line = 0;
      while (line + 1 < starts.length && starts[line + 1]! <= at) line += 1;
      return { line, col: at - starts[line]! };
    };
    const hitAt = (from: number, to: number): SpanHit | undefined => {
      const printed = joined.slice(from, to).replace(FOLD, ' ');
      const kind = this.kindOf(printed.toLowerCase());
      if (kind === undefined) return undefined;
      return {
        name: printed.toLowerCase(),
        kind,
        text: printed,
        start: locate(from),
        end: locate(to)
      };
    };

    // Offsets into `joined`, so a straddle can be checked against them.
    const taken: Word[] = [];
    const hits: SpanHit[] = [];
    rows.forEach((row, line) => {
      for (const hit of this.find(row.text)) {
        const from = starts[line]! + hit.start;
        taken.push({ start: from, end: starts[line]! + hit.end });
        hits.push({
          ...hit,
          text: row.text.slice(hit.start, hit.end),
          start: locate(from),
          end: locate(from + hit.end - hit.start)
        });
      }
    });

    const words = tokenize(joined);
    for (let line = 1; line < rows.length; line += 1) {
      const boundary = starts[line]!;
      let best: SpanHit | undefined;
      let bestWords = 0;
      // Read once per row, as above.
      const maxWords = tuning().maxNameWords;
      for (let at = 0; at < words.length && words[at]!.start < boundary; at += 1) {
        for (let span = Math.min(maxWords, words.length - at); span > bestWords; span -= 1) {
          const first = words[at]!;
          const last = words[at + span - 1]!;
          if (last.end <= boundary) break;
          if (taken.some((w) => w.start < last.end && first.start < w.end)) continue;
          const hit = hitAt(first.start, last.end);
          if (hit === undefined) continue;
          best = hit;
          bestWords = span;
          break;
        }
      }
      if (best !== undefined) hits.push(best);
    }

    return hits.sort((a, b) => a.start.line - b.start.line || a.start.col - b.start.col);
  }

  private add(name: string, kind: NameKind): void {
    const key = name.trim().toLowerCase();
    // One-word names that are also ordinary words — `sign`, `net`, `fist` —
    // would turn prose into a field of links. A name has to be at least this
    // long or more than one word to be worth underlining on sight.
    if (!worthLinking(key)) return;
    /*
     * A room has to be **more than one word**, whatever its length. The four-
     * character floor above is about names that are *short*; a room's problem
     * is names that are ordinary — 66 of the realm's 3,779 are a single common
     * noun (`street`, `bridge`, `alley`, `stairs`, `kitchen`), and `street`
     * alone appears 289 times in the capture corpus, nearly always inside a
     * longer name. Linked as a bare word it would underline prose and split
     * `Silver Street` across two hits. The realm's own `rooms` list is already
     * filtered this way; this keeps the rule true whatever feeds the index.
     */
    if (kind === 'room' && !key.includes(' ')) return;
    this.kinds.set(key, kind);
  }
}

interface Word {
  start: number;
  end: number;
}

/** Runs of letters, digits, apostrophes and hyphens, by column. */
function tokenize(row: string): Word[] {
  const words: Word[] = [];
  const pattern = /[A-Za-z0-9][A-Za-z0-9'\-]*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(row)) !== null) {
    words.push({ start: match.index, end: match.index + match[0].length });
  }
  return words;
}

/**
 * Whether a name is worth underlining on sight. One-word names that are also
 * ordinary words — `sign`, `net`, `fist` — would turn prose into a field of
 * links, so a name has to be at least four characters or more than one word.
 * Stated once, for the realm's names and the people's alike.
 */
function worthLinking(key: string): boolean {
  return key.length > 0 && (key.length >= 4 || key.includes(' '));
}
