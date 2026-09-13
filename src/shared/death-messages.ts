/**
 * How the realm's monsters die, in the server's own words.
 *
 * `Mob.cs` prints `mobType.DeathMessage.Line3` verbatim — free text per
 * monster type, the monster's name baked in — and composes only the fallback
 * for a monster with no message (`<name> falls to the ground dead.`, the one
 * pattern in `patterns.ts`). The message table is in none of the three realm
 * databases on hand, so the sentences live in `resources/world/death-messages.csv`,
 * one row per monster row (`Monsters.[Death Msg]` joined to `Messages.[Line 3]`
 * in `GreaterMUD.Database.Data.GMUDOfficial/00_Types/`; 1,042 monsters, 624
 * sentences) and keyed by the monster's name, which is the spelling the room
 * lists and the wire prints.
 *
 * **A sentence may be several monsters'.** The realm's builders reused message
 * records: `The dog yelps loudly, and dies.` is the wild dog's and the mangy
 * dog's, and 104 of the 624 sentences are shared that way. So a lookup answers
 * with every monster the table names for a sentence, in file order, and the
 * caller decides — from the room, or by keeping the whole set as candidates.
 * Refusing to pick is what keeps a mangy dog from being written down as a wild
 * one.
 *
 * `src/shared/` reads no file: `src/main/world/ShippedSentences.ts` opens it.
 * See `mudengine-wire`, *A monster's death sentence ships, and a shared one is
 * settled by the room*.
 */
import { parseCsv } from './spell-messages';
import { mobKey } from './world';

export interface DeathMessageRow {
  /** The monster's name in `mobKey` spelling. */
  mob: string;
  sentence: string;
}

/**
 * Reads the shipped CSV. Columns are found by header name so the file can grow
 * columns without moving these; a row missing either half names nothing.
 */
export function parseDeathMessagesCsv(text: string): DeathMessageRow[] {
  const records = parseCsv(text);
  const header = records[0];
  if (!header) return [];
  const column = (name: string): number => header.findIndex((cell) => cell.trim() === name);
  const mobAt = column('mob_name');
  const sentenceAt = column('sentence');
  if (mobAt < 0 || sentenceAt < 0) return [];

  const rows: DeathMessageRow[] = [];
  for (const record of records.slice(1)) {
    const mob = mobKey(record[mobAt] ?? '');
    const sentence = (record[sentenceAt] ?? '').trim();
    if (mob.length === 0 || sentence.length === 0) continue;
    rows.push({ mob, sentence });
  }
  return rows;
}

/** The sentences, held for the one question the parse path asks: whose death is this line. */
export class DeathBook {
  private readonly bySentence = new Map<string, string[]>();

  static fromRows(rows: readonly DeathMessageRow[]): DeathBook {
    const book = new DeathBook();
    for (const row of rows) book.add(row.mob, row.sentence);
    return book;
  }

  add(mob: string, sentence: string): void {
    const key = mobKey(mob);
    const text = sentence.trim();
    if (key.length === 0 || text.length === 0) return;
    const mobs = this.bySentence.get(text) ?? this.bySentence.set(text, []).get(text)!;
    if (!mobs.includes(key)) mobs.push(key);
  }

  /** Every monster the table says dies with this line, in file order; none where it is not one. */
  mobsOf(sentence: string): readonly string[] {
    return this.bySentence.get(sentence.trim()) ?? [];
  }

  /** How many distinct sentences the book holds. */
  get size(): number {
    return this.bySentence.size;
  }
}
