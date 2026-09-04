import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { parseSpellMessagesCsv, SpellMessageBook, spellLoreOf, wordsOf } from '../spell-messages';

const SHIPPED = path.resolve('resources/world/spell-messages.csv');

const csv = [
  'spell_id,spell_name,start,stop,desc_msg_id',
  '14,bless,You feel lucky!,The effects of bless wear off!,8539',
  '23,chant,You feel lucky!,The effects of bless wear off!,8539',
  '298,way of the bear,"You feel strong, but clumsy!",The way of the bear wears off.,590',
  '337,pool,You feel tranquil and soothed!,The  feeling of tranquility wears off.,771',
  '1022,song of hopelessness,"A dark, menacing cloud appears, flooding the room!","A dark, menacing cloud appears, flooding the room!",3477',
  '118,incense,,The effects of the incense wear off.,8608',
  '1312,,You are stunned!,You are no longer stunned.,57',
  '332,sunbolt wand,,,,"You point the gnarled wand at %s, and utter ""Shirzak!"""'
].join('\n');

describe('reading the shipped table', () => {
  it('reads quoted fields, drops a nameless row and keeps an absent half absent', () => {
    const rows = parseSpellMessagesCsv(csv);
    expect(rows.map((row) => row.spell)).toEqual([
      'bless',
      'chant',
      'way of the bear',
      'pool',
      'song of hopelessness',
      'incense',
      'sunbolt wand'
    ]);
    expect(rows[2]).toEqual({
      spell: 'way of the bear',
      start: 'You feel strong, but clumsy!',
      stop: 'The way of the bear wears off.'
    });
    expect(rows[5]).toEqual({
      spell: 'incense',
      start: null,
      stop: 'The effects of the incense wear off.'
    });
    expect(rows[6]).toEqual({ spell: 'sunbolt wand', start: null, stop: null });
  });

  it('finds the columns by name, so the file may grow columns', () => {
    const rows = parseSpellMessagesCsv('start,spell_name,stop\nYou glow.,glow,You dim.\n');
    expect(rows).toEqual([{ spell: 'glow', start: 'You glow.', stop: 'You dim.' }]);
    expect(parseSpellMessagesCsv('a,b\n1,2\n')).toEqual([]);
  });
});

describe('the word trie', () => {
  const book = SpellMessageBook.fromRows(parseSpellMessagesCsv(csv));

  it('answers every spell a sentence begins, in file order', () => {
    expect(book.match('You feel lucky!')).toEqual({ starts: ['bless', 'chant'], stops: [] });
    expect(book.match('The effects of bless wear off!')).toEqual({
      starts: [],
      stops: ['bless', 'chant']
    });
  });

  it('is keyed on words, so the table’s own double space is one boundary', () => {
    expect(book.match('The feeling of tranquility wears off.')?.stops).toEqual(['pool']);
    expect(book.match('  The   feeling of tranquility wears off. ')?.stops).toEqual(['pool']);
    expect(book.stopOf('pool')).toBe('The feeling of tranquility wears off.');
  });

  it('holds a sentence that is both a start and a stop as both', () => {
    expect(book.match('A dark, menacing cloud appears, flooding the room!')).toEqual({
      starts: ['song of hopelessness'],
      stops: ['song of hopelessness']
    });
  });

  it('answers null for a sentence it has never seen, and for a prefix of one', () => {
    expect(book.match('You feel')).toBeNull();
    expect(book.match('You feel lucky! Really.')).toBeNull();
    expect(book.match('')).toBeNull();
    expect(book.match('Sylvio nods.')).toBeNull();
  });

  it('answers each spell’s own sentences case-insensitively by name', () => {
    expect(book.startOf('Way Of The Bear')).toBe('You feel strong, but clumsy!');
    expect(book.startOf('incense')).toBeNull();
    expect(book.stopOf('incense')).toBe('The effects of the incense wear off.');
    expect(book.startOf('nothing')).toBeNull();
  });

  it('keeps the first statement for a spell and lets remove make room for another', () => {
    const own = new SpellMessageBook();
    expect(own.add('glow', 'start', 'You glow.')).toBe(true);
    expect(own.add('glow', 'start', 'You shine.')).toBe(false);
    expect(own.match('You glow.')?.starts).toEqual(['glow']);
    expect(own.size).toBe(1);
    expect(own.remove('glow', 'start')).toBe(true);
    expect(own.match('You glow.')).toBeNull();
    expect(own.size).toBe(0);
    expect(own.remove('glow', 'start')).toBe(false);
    expect(own.add('glow', 'start', 'You shine.')).toBe(true);
    expect(own.spells()).toEqual(['glow']);
  });

  it('tokenises on whitespace only', () => {
    expect(wordsOf(' You  feel\tlucky! ')).toEqual(['You', 'feel', 'lucky!']);
  });
});

describe('the shipped and the learned book read as one', () => {
  it('merges hits, prefers the shipped sentence, and learns only where the shipped table is silent', () => {
    const shipped = SpellMessageBook.fromRows(parseSpellMessagesCsv(csv));
    const learned = new SpellMessageBook();
    const taught: string[] = [];
    const lore = spellLoreOf(shipped, learned, {
      learned: (spell, kind, text) => taught.push(`${kind} ${spell}: ${text}`),
      unlearned: (spell, kind) => taught.push(`forgot ${kind} ${spell}`)
    });

    // The shipped table already speaks for bless: nothing is learned.
    lore.learn('bless', 'start', 'You feel blessed.', 1);
    expect(taught).toEqual([]);
    // A sentence the shipped table holds for anything is not learned for something else.
    lore.learn('strange glow', 'start', 'You feel lucky!', 1);
    expect(taught).toEqual([]);

    lore.learn('strange glow', 'start', 'You shimmer with a strange light.', 1);
    lore.learn('strange glow', 'start', 'You shimmer again.', 2);
    expect(taught).toEqual(['start strange glow: You shimmer with a strange light.']);
    expect(lore.startOf('strange glow')).toBe('You shimmer with a strange light.');
    expect(lore.match('You shimmer with a strange light.')).toEqual({
      starts: ['strange glow'],
      stops: []
    });
    expect(lore.match('You feel lucky!')?.starts).toEqual(['bless', 'chant']);

    lore.unlearn('strange glow', 'start');
    lore.unlearn('strange glow', 'start');
    expect(taught).toEqual([
      'start strange glow: You shimmer with a strange light.',
      'forgot start strange glow'
    ]);
    expect(lore.startOf('strange glow')).toBeNull();
  });
});

/*
 * The file that ships. Every duration spell the server's message table names
 * is in it, so a client may only ever be silent about a spell the server
 * itself has no sentence for.
 */
describe('resources/world/spell-messages.csv', () => {
  const rows = parseSpellMessagesCsv(fs.readFileSync(SHIPPED, 'utf8'));
  const book = SpellMessageBook.fromRows(rows);

  it('holds the table', () => {
    expect(rows.length).toBeGreaterThan(500);
    expect(book.size).toBeGreaterThan(400);
  });

  it('names the kai powers from the 2026-09-04 transcript', () => {
    expect(book.startOf('way of the tiger')).toBe('You feel ferocious!');
    expect(book.stopOf('way of the tiger')).toBe('The effects of way of the tiger wear off!');
    expect(book.match('You are using pressure points!')?.starts).toEqual(['pressure points']);
    expect(book.match('You stop using pressure points.')?.stops).toEqual(['pressure points']);
  });

  it('carries the shared message records as several spells', () => {
    expect(book.match('You feel lucky!')?.starts).toEqual([
      'bless',
      'chant',
      'weapon major bless',
      'glass orb',
      'dark blessing'
    ]);
    expect(book.match('You slow down.')?.stops).toContain('speed');
    expect(book.match('You slow down.')?.stops).toContain('way of the mantis');
  });

  it('holds no sentence with a placeholder in it', () => {
    for (const row of rows) {
      expect(row.start ?? '').not.toContain('%s');
      expect(row.stop ?? '').not.toContain('%s');
    }
  });
});
