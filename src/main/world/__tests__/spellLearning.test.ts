import { describe, expect, it } from 'vitest';

import { shopsNamedIn } from '../../../shared/world';
import { worldOf } from './realmFile';

/**
 * Where a spell is learned, as the Reference card is answered it (todo 71):
 * the scroll a shop sells and the trainer whose script teaches it, with the
 * trainer's room named.
 */
describe('a spell’s lookup', () => {
  const world = worldOf([{ m: 1, r: 274, n: 'Enchanter’s Tower', x: {} }], {
    v: 68,
    spells: [
      {
        id: 5539,
        n: 'fire blade',
        from: [{ k: 'npc', w: 'Naram Fireblade', at: '1/274', say: ['learn 3'], p: 360000 }]
      },
      { id: 12, n: 'harm' }
    ],
    items: [
      { id: 296, n: 'scroll of cause harm', ab: [[42, 12]], price: 15, shops: ['Magic Shop'] },
      { id: 297, n: 'old map', ab: [[42, 0]] }
    ]
  });

  it('names the trainer’s room and keeps the topic and the price', () => {
    const [spell] = world.lookup('fire blade').spells;
    expect(spell?.from).toEqual([
      {
        kind: 'asked',
        who: 'Naram Fireblade',
        room: '1/274',
        place: 'Enchanter’s Tower',
        say: ['learn 3'],
        price: 360000
      }
    ]);
    expect(spell?.scrolls).toBeUndefined();
  });

  it('lists the scroll that teaches it, and the shop that sells the scroll', () => {
    const found = world.lookup('harm');
    expect(found.spells[0]?.scrolls).toEqual([
      { id: 296, name: 'scroll of cause harm', price: 15, shops: ['Magic Shop'] }
    ]);
    expect(shopsNamedIn(found)).toContain('Magic Shop');
  });
});
