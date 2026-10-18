import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { askTable } from '../mobAsks';
import { readTextblocks } from '../navigation/textblock';
import { openRealm } from '../RealmSource';
import { number } from '../values';

/**
 * The wounded messenger's table (todo 01), against orohost's own data. Its
 * words and their blocks are `TBInfo` 316 as gmud.zip states it. Skips where
 * the archive is absent.
 */
const archive = path.resolve('mdb/gmud.zip');

describe.skipIf(!fs.existsSync(archive))('the ask tables in gmud.zip', () => {
  const source = openRealm(archive);
  const blocks = readTextblocks(source);
  const greetOf = (id: number): number | null =>
    number(source.table('Monsters')!.rows.find((row) => number(row['Number']) === id)!['GreetTXT']);
  const words = (id: number): string[] =>
    askTable(greetOf(id) ?? 0, blocks, { item: () => undefined, spell: () => undefined }).map(
      (ask) => ask.w
    );

  it("lists the wounded messenger's words, one per answer", () => {
    expect(words(243)).toEqual([
      'mission',
      "dragon's teeth",
      'chancellor annora',
      'monastery',
      'lord markus',
      'guildmaster',
      'accept',
      'travels'
    ]);
  });

  it('gives the gaunt one messenger one word and the plain messenger none', () => {
    expect(words(697)).toEqual(['nothing']);
    expect(greetOf(2782)).toBe(0);
  });
});
