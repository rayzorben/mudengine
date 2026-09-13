/**
 * The realm's emotes — `giggle`, `bow`, `hug Soul` — in the server's own words.
 *
 * `ActionFigure.PerformAction` composes nothing: every sentence an action
 * prints is a cell of the server's `Actions` table, one column per audience,
 * with `%s` standing for the people and things in it and `%p` for the actor's
 * pronoun. No realm database on hand carries the table, so the rows live in
 * `resources/world/actions.csv`, extracted from the server's official data
 * (`GreaterMUD.Database.Data.GMUDOfficial/00_Types/Actions.sql`, 64 rows) —
 * the same 64 words Paradigm's `action list` prints.
 *
 * Matched as templates rather than as patterns: each cell is split at its
 * placeholders into literals, and a line fits when the literals stand in order
 * with something in every gap — one word where a name goes, `his` or `her`
 * where a pronoun does, anything at all where a target or an item does. No
 * regular expression is built from the data (`compiled-patterns.test.ts`).
 *
 * `src/shared/` reads no file: `src/main/world/ShippedSentences.ts` opens it.
 * See `mudengine-wire`, *The realm's emotes are data, and they go in the Talk
 * card as local*.
 */
import { parseCsv } from './spell-messages';

/**
 * The eleven audiences, in the server's column order. `single` is a bare
 * action; `user`, `monster`, `inventory` and `floor_item` are what it was aimed
 * at; `to_user` is what the actor sees, `to_other_user` what the person acted
 * on sees, `to_room` what everybody else does.
 */
export const ACTION_AUDIENCES = [
  'single_to_user',
  'single_to_room',
  'user_to_user',
  'user_to_other_user',
  'user_to_room',
  'monster_to_user',
  'monster_to_room',
  'inventory_to_user',
  'inventory_to_room',
  'floor_item_to_user',
  'floor_item_to_room'
] as const;

export type ActionAudience = (typeof ACTION_AUDIENCES)[number];

export interface ActionRow {
  action: string;
  /** The template per audience; absent where the realm prints nothing. */
  templates: Partial<Record<ActionAudience, string>>;
}

/** What a line turned out to be, once a template fit it. */
export interface ActionHit {
  /** The action's word, as `action list` prints it. */
  action: string;
  /**
   * Who did it, in the server's spelling — or `null` where this character did:
   * every `_to_user` form is addressed to the actor, and `user_to_other_user`
   * names the actor and addresses this character.
   */
  actor: string | null;
  /**
   * Who or what it was aimed at, or `null` for a bare action and for the form
   * addressed to the target (`%s giggles loudly at you!`).
   */
  target: string | null;
  /**
   * The sentence without its leading actor — `giggle loudly!` off `You giggle
   * loudly!`, `giggles loudly!` off `Soul giggles loudly!` — which is what a
   * card draws beside the name it already prints.
   */
  message: string;
}

/**
 * What fills a gap. An actor is one word (a player's name); a pronoun is the
 * server's `his`/`her`; a target is whatever the server put there — a monster's
 * two words, an item's four — bounded by the literal after it.
 */
type Slot = 'actor' | 'pronoun' | 'target';

interface Template {
  action: string;
  audience: ActionAudience;
  /** `slots.length + 1` literals; a gap sits between each adjacent pair. */
  parts: string[];
  slots: Slot[];
}

/**
 * Which `%s` is who, per audience, read off `PerformAction`: a `_to_room` or
 * `_to_other_user` form puts the actor first (`ReplaceFirst(…, Name)`), the
 * inventory room form the actor's pronoun second, and everything after is the
 * target; a `_to_user` form is addressed to the actor and names only the target.
 */
function slotFor(audience: ActionAudience, placeholder: string, index: number): Slot {
  if (placeholder === '%p') return 'pronoun';
  if (audience.endsWith('_to_user')) return 'target';
  if (index === 0) return 'actor';
  if (audience === 'inventory_to_room' && index === 1) return 'pronoun';
  return 'target';
}

function compile(action: string, audience: ActionAudience, template: string): Template | null {
  const parts: string[] = [];
  const slots: Slot[] = [];
  let literal = '';
  let index = 0;
  for (let i = 0; i < template.length; i += 1) {
    const ch = template[i]!;
    const next = template[i + 1];
    if (ch === '%' && (next === 's' || next === 'p')) {
      // Two placeholders with nothing between them cannot be told apart; no
      // shipped cell has that, and one that did would be refused rather than
      // read either way.
      if (slots.length > 0 && literal.length === 0) return null;
      parts.push(literal);
      literal = '';
      slots.push(slotFor(audience, `%${next}`, index));
      index += 1;
      i += 1;
      continue;
    }
    literal += ch;
  }
  parts.push(literal);
  return { action, audience, parts, slots };
}

const isNameChar = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57);

/** The fills, in slot order, or `null` where the line does not fit the template. */
function fit(text: string, template: Template): string[] | null {
  const { parts, slots } = template;
  const fills: string[] = [];
  let pos = 0;
  for (let k = 0; k < slots.length; k += 1) {
    const literal = parts[k]!;
    if (!text.startsWith(literal, pos)) return null;
    pos += literal.length;
    const after = parts[k + 1]!;
    let end = -1;
    switch (slots[k]!) {
      case 'actor':
        end = pos;
        while (end < text.length && isNameChar(text.charCodeAt(end))) end += 1;
        break;
      case 'pronoun':
        if (!text.startsWith('his', pos) && !text.startsWith('her', pos)) return null;
        end = pos + 3;
        break;
      case 'target':
        // The closing literal is matched at the end, so a target may hold
        // its text; a literal between two gaps is matched at its first sight.
        end =
          k === slots.length - 1
            ? text.endsWith(after)
              ? text.length - after.length
              : -1
            : text.indexOf(after, pos);
        break;
    }
    if (end <= pos) return null;
    fills.push(text.slice(pos, end));
    pos = end;
  }
  const closing = parts[slots.length]!;
  return text.startsWith(closing, pos) && pos + closing.length === text.length ? fills : null;
}

const firstWord = (text: string): string => {
  const trimmed = text.trimStart();
  const space = trimmed.indexOf(' ');
  return space < 0 ? trimmed : trimmed.slice(0, space);
};

/**
 * Reads the shipped CSV. Columns are found by header name so the file can grow
 * columns without moving these; a row with no action word names nothing.
 */
export function parseActionsCsv(text: string): ActionRow[] {
  const records = parseCsv(text);
  const header = records[0];
  if (!header) return [];
  const column = (name: string): number => header.findIndex((cell) => cell.trim() === name);
  const actionAt = column('action');
  if (actionAt < 0) return [];
  const columns = ACTION_AUDIENCES.map((audience) => [audience, column(audience)] as const);

  const rows: ActionRow[] = [];
  for (const record of records.slice(1)) {
    const action = (record[actionAt] ?? '').trim();
    if (action.length === 0) continue;
    const templates: Partial<Record<ActionAudience, string>> = {};
    for (const [audience, at] of columns) {
      if (at < 0) continue;
      const template = (record[at] ?? '').trim();
      if (template.length > 0) templates[audience] = template;
    }
    rows.push({ action, templates });
  }
  return rows;
}

/**
 * The templates, indexed by the one word every fit has to agree on: the first
 * word where a template opens with a literal (`You`), the word after the
 * actor where it opens with a name (`giggles`). A line is tried against the
 * templates behind its first word and then those behind its second, and the
 * first fit in file order answers — two audiences printing the same words
 * (`You hug %s.` to a player and to a monster) are one sentence to the reader.
 */
export class ActionBook {
  private readonly byLead = new Map<string, Template[]>();
  private readonly bySecond = new Map<string, Template[]>();
  private readonly words = new Set<string>();

  static fromRows(rows: readonly ActionRow[]): ActionBook {
    const book = new ActionBook();
    for (const row of rows) {
      for (const audience of ACTION_AUDIENCES) {
        const template = row.templates[audience];
        if (template !== undefined) book.add(row.action, audience, template);
      }
    }
    return book;
  }

  /** Adds one template; `false` where it cannot be read as one. */
  add(action: string, audience: ActionAudience, template: string): boolean {
    const compiled = compile(action, audience, template);
    if (compiled === null) return false;
    const lead = compiled.parts[0]!;
    if (lead.length > 0) {
      const key = firstWord(lead);
      (this.byLead.get(key) ?? this.byLead.set(key, []).get(key)!).push(compiled);
    } else if (compiled.slots[0] === 'actor') {
      const key = firstWord(compiled.parts[1]!);
      (this.bySecond.get(key) ?? this.bySecond.set(key, []).get(key)!).push(compiled);
    } else {
      // A template opening on a target or a pronoun anchors on nothing a
      // line can be indexed by; none ships, and one would be refused.
      return false;
    }
    this.words.add(action);
    return true;
  }

  /** Every action word the book holds, in file order. */
  actions(): string[] {
    return [...this.words];
  }

  get size(): number {
    return this.words.size;
  }

  match(text: string): ActionHit | null {
    const line = text.trim();
    if (line.length === 0) return null;
    const first = firstWord(line);
    const hit = this.tryEach(line, this.byLead.get(first));
    if (hit !== null) return hit;
    const second = firstWord(line.slice(first.length));
    return this.tryEach(line, this.bySecond.get(second));
  }

  private tryEach(line: string, templates: Template[] | undefined): ActionHit | null {
    if (!templates) return null;
    for (const template of templates) {
      const fills = fit(line, template);
      if (fills === null) continue;
      let actor: string | null = null;
      let target: string | null = null;
      for (const [k, slot] of template.slots.entries()) {
        if (slot === 'actor') actor = fills[k]!;
        else if (slot === 'target' && target === null) target = fills[k]!;
      }
      // Off the first word either way: the literal `You` or the actor's name.
      const message = line.slice(firstWord(line).length).trimStart();
      return { action: template.action, actor, target, message };
    }
    return null;
  }
}
