import { describe, expect, it } from 'vitest';
import { asUiDict, flattenDict, makeT, rendersFrom, templateParts } from '../i18n';

describe('asUiDict', () => {
  it('accepts nested sections whose leaves are strings', () => {
    const dict = asUiDict({ cards: { room: { title: 'Room' } }, app: { title: 'mudengine' } });
    expect(dict).toEqual({ cards: { room: { title: 'Room' } }, app: { title: 'mudengine' } });
  });

  it('refuses the whole dictionary when any leaf is not a string', () => {
    expect(asUiDict({ cards: { count: 3 } })).toBeNull();
    expect(asUiDict({ cards: { list: ['a', 'b'] } })).toBeNull();
    expect(asUiDict({ cards: { title: null } })).toBeNull();
  });

  it('refuses a value that is not a dictionary at all', () => {
    expect(asUiDict(null)).toBeNull();
    expect(asUiDict('Room')).toBeNull();
    expect(asUiDict(['Room'])).toBeNull();
    expect(asUiDict(7)).toBeNull();
  });
});

describe('flattenDict', () => {
  it('turns nesting into dot paths', () => {
    const flat = flattenDict({ cards: { room: { title: 'Room', exits: 'Exits' } }, ok: 'OK' });
    expect(flat.get('cards.room.title')).toBe('Room');
    expect(flat.get('cards.room.exits')).toBe('Exits');
    expect(flat.get('ok')).toBe('OK');
    expect(flat.size).toBe(3);
  });
});

describe('makeT', () => {
  const dict = {
    plain: 'Show all',
    greet: 'Hello, {name}',
    both: '{shown} of {total}',
    twice: '{name} and {name} again'
  };

  it('returns the text for a key', () => {
    const t = makeT(dict, () => {});
    expect(t('plain')).toBe('Show all');
  });

  it('fills placeholders from params, numbers included', () => {
    const t = makeT(dict, () => {});
    expect(t('greet', { name: 'Vex' })).toBe('Hello, Vex');
    expect(t('both', { shown: 12, total: 40 })).toBe('12 of 40');
    expect(t('twice', { name: 'once' })).toBe('once and once again');
  });

  it('returns the key itself for a missing key, and reports it once', () => {
    const problems: string[] = [];
    const t = makeT(dict, (p) => problems.push(p));
    expect(t('cards.room.missing')).toBe('cards.room.missing');
    expect(t('cards.room.missing')).toBe('cards.room.missing');
    expect(problems).toEqual(["no copy for key 'cards.room.missing'"]);
  });

  it('leaves a placeholder visible when no value was given, and reports it', () => {
    const problems: string[] = [];
    const t = makeT(dict, (p) => problems.push(p));
    expect(t('both', { shown: 12 })).toBe('12 of {total}');
    expect(problems).toEqual(["no value for {total} in 'both'"]);
  });

  it('leaves text without placeholders alone when params arrive anyway', () => {
    const t = makeT(dict, () => {});
    expect(t('plain', { name: 'unused' })).toBe('Show all');
  });
});

describe('rendersFrom', () => {
  it('recognises a sentence whatever fills its placeholders, and nothing else', () => {
    const template = 'nothing came back after {command}';
    expect(rendersFrom(template, 'nothing came back after se')).toBe(true);
    expect(rendersFrom(template, 'nothing came back after ')).toBe(true);
    expect(rendersFrom(template, 'something came back after se')).toBe(false);
    expect(rendersFrom('{who} waits at {where}.', 'Soul waits at the gate.')).toBe(true);
    expect(rendersFrom('{who} waits at {where}.', 'Soul waits at the gate')).toBe(false);
  });

  it('holds a placeholder-free sentence to the whole of the text', () => {
    expect(rendersFrom('a fight started', 'a fight started')).toBe(true);
    expect(rendersFrom('a fight started', 'a fight started!')).toBe(false);
  });

  it('keeps each literal run in order and clear of the ending', () => {
    expect(rendersFrom('{a} to {b} to', 'x to y to')).toBe(true);
    // The middle run may not borrow the characters the ending needs.
    expect(rendersFrom('{a} to {b} to', 'x to')).toBe(false);
    expect(rendersFrom('from {a} via {b} to {c}', 'from x to y via z')).toBe(false);
  });

  it('cuts at the placeholders the way makeT fills them', () => {
    expect(templateParts('{a} and {b}!')).toEqual(['', 'a', ' and ', 'b', '!']);
  });
});
