import { describe, expect, it } from 'vitest';

import { aliasRefusal, expandAlias, normalizeAliases, refusedAliases } from '../aliases';

describe('an alias in the Talk box', () => {
  const aliases = normalizeAliases({ kk: 'pu kobold', RET: ' 2d,6s;rest ' });

  it('expands a word alone, and puts what followed it after the line', () => {
    expect(expandAlias('kk', aliases)).toBe('pu kobold');
    expect(expandAlias('  KK  ', aliases)).toBe('pu kobold');
    expect(expandAlias('ret', aliases)).toBe('2d,6s;rest');
    expect(expandAlias('kk thief', aliases)).toBe('pu kobold thief');
  });

  it('leaves a line that opens on no alias, and speech, alone', () => {
    // Positive control first: the same word does expand off a channel.
    expect(expandAlias('kk', aliases)).not.toBeNull();
    expect(expandAlias('gos kk', aliases)).toBeNull();
    expect(expandAlias('look', aliases)).toBeNull();
    expect(expandAlias('kkk', aliases)).toBeNull();
    expect(expandAlias('', aliases)).toBeNull();
    // A word the prototype chain spells is not an alias.
    expect(expandAlias('constructor', aliases)).toBeNull();
  });

  it('expands once, so two aliases naming each other cannot loop', () => {
    const both = normalizeAliases({ zz: 'zy', zy: 'zz' });
    expect(expandAlias('zz', both)).toBe('zy');
  });
});

describe('the aliases a file states', () => {
  it('keeps word-to-line entries, lower case and trimmed', () => {
    expect(normalizeAliases({ Kk: ' pu kobold ' })).toEqual({ kk: 'pu kobold' });
  });

  it('drops what cannot load, and says why', () => {
    expect(aliasRefusal('two words', 'n')).toBe('word');
    expect(aliasRefusal('9s', 'n')).toBe('word');
    expect(aliasRefusal('kk', '  ')).toBe('empty');
    // The realm's own words are never taken over.
    expect(aliasRefusal('l', 'look')).toBe('command');
    expect(aliasRefusal('gos', 'say hi')).toBe('command');
    expect(aliasRefusal('kk', 'pu kobold')).toBeNull();
    expect(normalizeAliases({ l: 'look', kk: '', n: 'x', ok: { a: 'x' } })).toEqual({});
    // A list is a macro, one command a line (todo 134).
    expect(normalizeAliases({ ok: ['x', 'y'] })).toEqual({ ok: 'x\ny' });
    // YAML reads `ok: 3` as a number; it is the line 3.
    expect(normalizeAliases({ ok: 3 })).toEqual({ ok: '3' });
  });

  it('lists what does not load, leaving out a drop', () => {
    expect(refusedAliases({ kk: 'pu kobold', l: 'look', gone: '', 'two words': 'n' })).toEqual([
      { name: 'l', text: 'look', refusal: 'command' },
      { name: 'two words', text: 'n', refusal: 'word' }
    ]);
    // Two rows on one word in any case: neither loads.
    expect(normalizeAliases({ kk: 'pu kobold', KK: 'grin', ok: 'nod' })).toEqual({ ok: 'nod' });
    expect(refusedAliases({ kk: 'a', KK: 'b' }).map((entry) => entry.refusal)).toEqual([
      'twice',
      'twice'
    ]);
    // A word in the prototype chain is no realm command.
    expect(aliasRefusal('constructor', 'look')).toBeNull();
  });

  it('reads anything but a map as none', () => {
    expect(normalizeAliases(undefined)).toEqual({});
    expect(normalizeAliases(['kk'])).toEqual({});
    expect(normalizeAliases('kk: pu')).toEqual({});
  });
});
