/**
 * The server's own message table, read as templates (todo 109, 2026-09-13).
 *
 * GreaterMUD composes almost nothing: a spell landing, a monster's blow, a
 * room command's answer are rows of `Messages`, three lines each, with `%s`
 * for a name and `%d` for a figure (`GreaterMUD.Module/Message.cs` documents
 * the three lines per kind — caster, target, room for a cast). The table
 * ships as `resources/world/messages.csv` (`npm run build:messages`), and this
 * fits a line to the templates the way `ActionBook` fits an emote: whole,
 * anchored, indexed by a literal word so a line runs a handful of them.
 * The wire, learned per realm, outranks it; this fills what no frame reads.
 */
import { parseCsv } from './spell-messages';

export type MessageKind = 'spell' | 'cast' | 'verbs' | 'commands' | 'other';

export interface MessageRow {
  number: number;
  kind: MessageKind;
  lines: readonly [string, string, string];
}

/** One line of the table fitted to a line of the wire. */
export interface MessageHit {
  number: number;
  kind: MessageKind;
  /** Which of the three lines fitted: 1 the actor's, 2 the target's, 3 the room's. */
  role: 1 | 2 | 3;
  template: string;
  /** What the placeholders took, in the template's order. */
  fills: string[];
  /** Whether each fill was a `%d` figure. */
  numeric: boolean[];
}

const KINDS: ReadonlySet<string> = new Set(['spell', 'cast', 'verbs', 'commands', 'other']);

export function parseMessagesCsv(text: string): MessageRow[] {
  const records = parseCsv(text);
  const header = records[0];
  if (!header) return [];
  const column = (name: string): number => header.findIndex((cell) => cell.trim() === name);
  const at = {
    number: column('number'),
    kind: column('kind'),
    lines: [column('line1'), column('line2'), column('line3')]
  };
  if (at.number < 0 || at.kind < 0 || at.lines.some((index) => index < 0)) return [];
  const rows: MessageRow[] = [];
  for (const record of records.slice(1)) {
    const number = Number(record[at.number]);
    const kind = (record[at.kind] ?? '').trim();
    if (!Number.isInteger(number) || number <= 0 || !KINDS.has(kind)) continue;
    const lines = at.lines.map((index) => (record[index] ?? '').trim()) as [string, string, string];
    if (lines.every((line) => line.length === 0)) continue;
    rows.push({ number, kind: kind as MessageKind, lines });
  }
  return rows;
}

interface Template {
  number: number;
  kind: MessageKind;
  role: 1 | 2 | 3;
  template: string;
  pattern: RegExp;
  numeric: boolean[];
  /** Literal characters, so a tighter template outranks a looser one. */
  literal: number;
}

/**
 * The fewest literal characters a template may have and still be fitted: a
 * template of placeholders and a preposition (`%s %s %s`) fits every line and
 * says nothing about it. MudPlay's `MessageTemplateIndex` learned the same
 * bound the hard way (`The {source} {spellname}!` claimed a room spell).
 */
const MIN_LITERAL = 8;

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compile(row: MessageRow, role: 1 | 2 | 3, template: string): Template | null {
  const parts = template.split(/(%[sd])/);
  let source = '^';
  let literal = 0;
  const numeric: boolean[] = [];
  for (const part of parts) {
    if (part === '%s') {
      source += '(.+?)';
      numeric.push(false);
    } else if (part === '%d') {
      source += '(-?\\d+)';
      numeric.push(true);
    } else if (part.length > 0) {
      source += escape(part);
      literal += part.replace(/\s+/g, '').length;
    }
  }
  if (literal < MIN_LITERAL) return null;
  // `%d` is a figure, but the room's line prints it with `%s` (Message.cs); a
  // fill that is all digits reads as one either way — see `MessageBook.match`.
  return {
    number: row.number,
    kind: row.kind,
    role,
    template,
    pattern: new RegExp(`${source}$`),
    numeric,
    literal
  };
}

/** The longest literal word of a template, lower-cased: its index key. */
function keyOf(template: string): string | null {
  const words = template
    .replace(/%[sd]/g, ' ')
    .toLowerCase()
    .match(/[a-z']{3,}/g);
  if (!words) return null;
  return words.reduce((best, word) => (word.length > best.length ? word : best), '');
}

export class MessageBook {
  private readonly byWord = new Map<string, Template[]>();
  private count = 0;

  static fromRows(rows: readonly MessageRow[]): MessageBook {
    const book = new MessageBook();
    for (const row of rows) book.add(row);
    return book;
  }

  add(row: MessageRow): void {
    // A verb table and a text exit's words are not sentences the wire prints.
    if (row.kind === 'verbs' || row.kind === 'commands') return;
    row.lines.forEach((template, index) => {
      if (template.length === 0) return;
      const key = keyOf(template);
      if (key === null) return;
      const compiled = compile(row, (index + 1) as 1 | 2 | 3, template);
      if (compiled === null) return;
      const bucket = this.byWord.get(key) ?? [];
      bucket.push(compiled);
      this.byWord.set(key, bucket);
      this.count += 1;
    });
  }

  /** How many templates are fitted against a line. */
  get size(): number {
    return this.count;
  }

  /**
   * The template a whole line fits, the tightest first. Every word of the
   * line is looked up, so only templates sharing a literal word with it run;
   * among those that fit, the one with the most literal text wins, since a
   * template with fewer placeholders said more about the line.
   */
  match(text: string): MessageHit | null {
    const line = text.trim();
    if (line.length === 0) return null;
    const words = line.toLowerCase().match(/[a-z']{3,}/g);
    if (!words) return null;
    let best: { template: Template; fills: string[] } | null = null;
    const seen = new Set<string>();
    for (const word of words) {
      if (seen.has(word)) continue;
      seen.add(word);
      const bucket = this.byWord.get(word);
      if (!bucket) continue;
      for (const template of bucket) {
        if (best !== null && template.literal <= best.template.literal) continue;
        const found = template.pattern.exec(line);
        if (!found) continue;
        best = { template, fills: found.slice(1) };
      }
    }
    if (best === null) return null;
    const { template } = best;
    // A fill is what the server printed for a name or a figure, less the
    // template's own spacing — `your  party` fitted `%s party` with a bare space.
    const fills = best.fills.map((fill) => fill.trim());
    return {
      number: template.number,
      kind: template.kind,
      role: template.role,
      template: template.template,
      fills,
      numeric: fills.map((fill, index) => template.numeric[index] === true || /^-?\d+$/.test(fill))
    };
  }
}

export const NO_MESSAGES = new MessageBook();
