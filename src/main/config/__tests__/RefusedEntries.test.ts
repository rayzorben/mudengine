import { describe, expect, it } from 'vitest';

import { notesOf } from '../../app/copyMatch';
import { RefusedEntries } from '../RefusedEntries';

// An alias or a key the options file states and the client does not load (todo 74).
describe('the entries the options file states and does not load', () => {
  const file = {
    automation: { aliases: { kk: 'pu kobold', l: 'look', gone: '' } },
    keys: { Numpad8: 'n', 'Ctrl+KeyK': 'look' }
  };

  it('are said once each, and the loaded ones and a drop are not', () => {
    const said = new RefusedEntries().fresh(file);
    expect(notesOf(said, 'app.config.refusedAlias')).toHaveLength(1);
    expect(notesOf(said, 'app.config.refusedKey')).toHaveLength(1);
    expect(said).toHaveLength(2);
  });

  it('are not said again until what is refused changes', () => {
    const refused = new RefusedEntries();
    // Positive control: the first read says them.
    expect(refused.fresh(file)).toHaveLength(2);
    expect(refused.fresh(file)).toEqual([]);
    expect(refused.fresh({ ...file, keys: {} })).toHaveLength(1);
    expect(refused.fresh({})).toEqual([]);
  });
});

// Todo 134: a character's own file, and a loop through Global's macros.
describe('the entries a character’s file states and does not load', () => {
  const base = { keys: { F1: '{doit}', F2: 'n' } };

  it('says its own refused entry, and what loops only with Global’s', () => {
    const raw = { automation: { aliases: { l: 'look', doit: 'grin\n{f1}' } }, keys: { F2: '' } };
    const said = new RefusedEntries().freshFor('vaelor', 'Vaelor', raw, base);
    // `l` is the realm's own word; `doit` and Global's F1 loop; F2 is dropped, which is not said.
    expect(notesOf(said, 'app.config.refusedCharacterAlias')).toHaveLength(2);
    expect(notesOf(said, 'app.config.refusedCharacterKey')).toHaveLength(1);
    expect(said).toHaveLength(3);
  });

  it('files a key under the name it loads as, so f2 over F2 is one key', () => {
    const raw = { keys: { f2: 'cast heal' } };
    // Positive control above: the same reporter says a refused one.
    expect(new RefusedEntries().freshFor('vaelor', 'Vaelor', raw, base)).toEqual([]);
  });
});
