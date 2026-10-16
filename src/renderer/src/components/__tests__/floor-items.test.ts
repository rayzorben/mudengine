import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { wireItem, type ItemEntity } from '@shared/entities';
import { UNKNOWN_WEARER, type Wearer } from '@shared/gear';
import FloorItems from '../FloorItems';
import { mount } from '../../hooks/__tests__/mount';

/*
 * The Room card's floor rows carry the console Floor rewrite's mark (todo
 * 146): the same verdict, drawn per item.
 */

const probe = mount();
afterEach(() => probe.unmount());

const warrior: Wearer = {
  ...UNKNOWN_WEARER,
  classId: 1,
  raceId: 1,
  level: 10,
  alignment: 'Neutral',
  weaponType: 8,
  armourType: 9,
  antiMagic: false,
  classNames: { 1: 'Warrior', 7: 'Druid', 8: 'Bard' }
};

const known = (name: string, over: Partial<ItemEntity>): ItemEntity => ({
  ...wireItem(name),
  source: 'hybrid',
  id: 1,
  ...over
});

describe('the Room card floor', () => {
  it('marks each item usable, ruled out or unknown', () => {
    const items = [
      known('small glass flask', { classes: [7, 8] }),
      known('bone key', {}),
      wireItem('bone charm')
    ];
    probe.render(createElement(FloorItems, { items, coins: '', wearer: warrior }));
    const marks = probe
      .root()
      .findAll((node) => node.props['className'] === 'use-mark')
      .map((node) => node.props['data-use'] as string);
    expect(marks).toEqual(['blocked', 'usable', 'unknown']);
  });
});
