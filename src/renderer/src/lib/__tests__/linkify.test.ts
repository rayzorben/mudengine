import { describe, expect, it } from 'vitest';

import { linkAt, linkify } from '../linkify';

const hrefs = (text: string): string[] =>
  linkify(text)
    .map((part) => part.href)
    .filter((href): href is string => href !== undefined);

describe('finding a web address in what somebody said', () => {
  it('finds one on its own', () => {
    expect(hrefs('https://example.com')).toEqual(['https://example.com']);
  });

  it('finds one in a sentence, and keeps the rest as text', () => {
    const parts = linkify('see https://example.com/x for the map');
    expect(parts.map((part) => part.text).join('')).toBe('see https://example.com/x for the map');
    expect(hrefs('see https://example.com/x for the map')).toEqual(['https://example.com/x']);
  });

  /*
   * "see https://example.com." is a sentence with a full stop, not an address
   * with a dot on the end. Same for the comma, the bracket and the rest of the
   * punctuation a person ends a clause with.
   */
  it('leaves the punctuation that ended the sentence out of the address', () => {
    expect(hrefs('go to https://example.com.')).toEqual(['https://example.com']);
    expect(hrefs('(https://example.com)')).toEqual(['https://example.com']);
    expect(hrefs('https://example.com, then north')).toEqual(['https://example.com']);
  });

  it('finds more than one', () => {
    expect(hrefs('https://a.test and https://b.test')).toEqual([
      'https://a.test',
      'https://b.test'
    ]);
  });

  /*
   * Narrow on purpose. `www.` with no scheme is a guess about what somebody
   * meant, and every other scheme a URL can carry is a thing to hand the
   * operating system only when the person typing it is the person running the
   * client — this text was typed by somebody else on a MUD. Main refuses those
   * schemes too; this is the first of two gates.
   */
  it('finds nothing in text that is not a web address', () => {
    expect(hrefs('www.example.com')).toEqual([]);
    expect(hrefs('file:///etc/passwd')).toEqual([]);
    expect(hrefs('smb://share/x')).toEqual([]);
    expect(hrefs('javascript:alert(1)')).toEqual([]);
    expect(hrefs('gos anyone selling a rope?')).toEqual([]);
  });

  /* The caller renders the result without a special case, so it is never empty. */
  it('returns the line itself when there is nothing in it', () => {
    expect(linkify('nothing here')).toEqual([{ text: 'nothing here' }]);
    expect(linkify('')).toEqual([{ text: '' }]);
  });

  /*
   * The parts always rejoin into exactly what was said. A linkifier that lost a
   * character would be silently rewriting other people's messages.
   */
  it('never loses or adds a character', () => {
    for (const said of [
      'https://example.com',
      'a https://example.com b',
      'https://a.test/x?y=1&z=2 ok',
      '((https://example.com))',
      'no links at all'
    ]) {
      expect(
        linkify(said)
          .map((part) => part.text)
          .join('')
      ).toBe(said);
    }
  });
});

describe('linkAt', () => {
  const line = 'see https://example.com/x for the map';

  it('answers the address a column lands inside', () => {
    expect(linkAt(line, 4)).toBe('https://example.com/x');
    expect(linkAt(line, 24)).toBe('https://example.com/x');
  });

  it('answers null either side of it, and past the end of the line', () => {
    expect(linkAt(line, 3)).toBeNull();
    expect(linkAt(line, 25)).toBeNull();
    expect(linkAt(line, 500)).toBeNull();
    expect(linkAt('nothing to click here', 3)).toBeNull();
  });

  /* Two on one line, which is what a console line of gossip looks like. */
  it('answers the one under the pointer when a line carries two', () => {
    const two = 'a http://one.example/p b http://two.example/q c';
    expect(linkAt(two, 2)).toBe('http://one.example/p');
    expect(linkAt(two, 25)).toBe('http://two.example/q');
    expect(linkAt(two, 23)).toBeNull();
  });
});
