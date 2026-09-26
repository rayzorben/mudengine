import { describe, expect, it } from 'vitest';

import {
  ANY,
  copyOf,
  isCopy,
  literalsOf,
  notesOf,
  phrase,
  phraseOfAny,
  sentence
} from '../copyMatch';
import { t } from '../i18n';

/*
 * The helpers every wording-free expectation is built on, held against the
 * dictionary's own rendering (`t`) rather than against English: a key with
 * two placeholders and one with none.
 */
const COUNT = 'table.narrowedCount';
const PLAIN = 'table.showAll';

describe('copy as a pattern', () => {
  it('throws on a key the dictionary lacks, so a negative check cannot pass vacuously', () => {
    expect(() => copyOf('no.such.key')).toThrow(/no\.such\.key/);
    expect(() => phrase('no.such.key')).toThrow();
    expect(() => notesOf([], 'no.such.key')).toThrow();
  });

  it('fills what it is told and leaves the rest open, or to `fill`', () => {
    const rendered = t(COUNT, { shown: 3, total: 40 });
    expect(sentence(COUNT).test(rendered)).toBe(true);
    expect(sentence(COUNT, { shown: 3 }).test(rendered)).toBe(true);
    expect(sentence(COUNT, { shown: 4 }).test(rendered)).toBe(false);
    expect(sentence(COUNT, { shown: 3 }, { fill: '\\d+' }).test(rendered)).toBe(true);
    expect(sentence(COUNT, {}, { fill: '\\d+' }).test(t(COUNT, { shown: 'x', total: 40 }))).toBe(
      false
    );
  });

  it('opens an `ANY` inside a value it was given', () => {
    const rendered = t(COUNT, { shown: 'three apples', total: 40 });
    expect(sentence(COUNT, { shown: `three ${ANY}` }).test(rendered)).toBe(true);
  });

  it('finds a phrase inside a longer text, and a sentence only as the whole of one', () => {
    const inside = `before ${t(PLAIN)} after`;
    expect(phrase(PLAIN).test(inside)).toBe(true);
    expect(sentence(PLAIN).test(inside)).toBe(false);
    expect(phraseOfAny([COUNT, PLAIN]).test(inside)).toBe(true);
    expect(notesOf([inside, t(PLAIN)], PLAIN)).toEqual([t(PLAIN)]);
  });

  it('reads a page text as the copy, surrounding space and casing aside', () => {
    expect(isCopy(t(PLAIN), PLAIN)).toBe(true);
    expect(isCopy(`  ${t(PLAIN).toUpperCase()}  `, PLAIN)).toBe(true);
    expect(isCopy(`${t(PLAIN)}.`, PLAIN)).toBe(false);
    expect(isCopy(null, PLAIN)).toBe(false);
  });

  it('cuts the copy at its placeholders into its own words', () => {
    expect(literalsOf(COUNT).join('{}')).toBe(t(COUNT, { shown: '{}', total: '{}' }));
  });
});
