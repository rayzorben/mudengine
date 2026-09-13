import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { DeathBook, parseDeathMessagesCsv } from '../death-messages';

const SHIPPED = path.resolve('resources/world/death-messages.csv');

const csv = [
  'mob_id,mob_name,death_msg_id,sentence',
  '6,orc rogue,39,The orc rogue collapses with a grunt.',
  '404,kobold,1515,The kobold falls to the ground with a shriek!',
  '17,wild dog,8352,"The dog yelps loudly, and dies."',
  '18,mangy dog,8352,"The dog yelps loudly, and dies."',
  '19,Mangy Dog,8352,"The dog yelps loudly, and dies."',
  '20,,8352,"The dog yelps loudly, and dies."',
  '21,nobody,0,'
].join('\n');

describe('reading the death table', () => {
  it('keys each row on the monster’s name in mobKey spelling and drops a half-empty row', () => {
    const rows = parseDeathMessagesCsv(csv);
    expect(rows).toHaveLength(5);
    expect(rows[4]).toEqual({ mob: 'mangy dog', sentence: 'The dog yelps loudly, and dies.' });
  });
});

describe('whose death a line is', () => {
  const book = DeathBook.fromRows(parseDeathMessagesCsv(csv));

  it('answers one monster for its own sentence', () => {
    expect(book.mobsOf('The orc rogue collapses with a grunt.')).toEqual(['orc rogue']);
    expect(book.mobsOf('  The kobold falls to the ground with a shriek!  ')).toEqual(['kobold']);
  });

  it('answers every monster sharing a sentence, once each, in file order', () => {
    expect(book.mobsOf('The dog yelps loudly, and dies.')).toEqual(['wild dog', 'mangy dog']);
  });

  it('answers nobody for a line it does not hold', () => {
    expect(book.mobsOf('The orc rogue falls to the ground dead.')).toEqual([]);
    expect(book.size).toBe(3);
  });
});

/*
 * The shipped file: `Monsters.[Death Msg]` joined to `Messages.[Line 3]` in
 * the server's official data, one row per monster row. Held against the file
 * because the file is the fact — the three sentences below were on the live
 * wire on 2026-09-12 and each cost a stat sheet.
 */
describe('the shipped death table', () => {
  const book = DeathBook.fromRows(parseDeathMessagesCsv(fs.readFileSync(SHIPPED, 'utf8')));

  it('names the monster the live wire could not learn, and the shared sentence’s two', () => {
    expect(book.mobsOf('The orc rogue collapses with a grunt.')).toEqual(['orc rogue']);
    expect(book.mobsOf('The kobold falls to the ground with a shriek!')).toEqual(['kobold']);
    expect(book.mobsOf('The dog yelps loudly, and dies.')).toEqual(['wild dog', 'mangy dog']);
  });

  it('holds the whole table', () => {
    expect(book.size).toBe(624);
  });
});
