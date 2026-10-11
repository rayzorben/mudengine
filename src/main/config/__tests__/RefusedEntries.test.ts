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
