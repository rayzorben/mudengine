import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Find } from '@shared/finds';
import FindsFace from '../FindsFace';
import { mount } from '../../hooks/__tests__/mount';

/*
 * Todo 20261102-1523-01: the Finds face's What column was text while the Where
 * column beside it opened the room. A found item opens its card; found money
 * has no card and stays text.
 */

const probe = mount();
afterEach(() => probe.unmount());

const find = (over: Partial<Find>): Find => ({
  room: '1/2',
  roomName: 'Den',
  name: 'scroll of minor healing',
  quantity: null,
  copper: null,
  coins: null,
  at: 0,
  seen: 1,
  hits: 1,
  searched: 1,
  rarity: null,
  ...over
});

describe('the Finds face', () => {
  it('opens an item from the What column and leaves money as text', () => {
    const inspect = vi.fn();
    const goToRoom = vi.fn();
    probe.render(
      createElement(FindsFace, {
        session: 's',
        finds: [find({}), find({ name: 'copper farthings', copper: 30, quantity: 30 })],
        days: 0,
        goToRoom,
        inspect
      })
    );
    const items = probe.root().findAll((node) => node.props['data-entity'] === 'realm');
    expect(items.map((node) => node.props.children)).toEqual(['scroll of minor healing']);
    items[0]!.props.onClick({ currentTarget: {} });
    expect(inspect).toHaveBeenCalledWith('scroll of minor healing', {});
    // The money row is drawn beside it, as text: its room is still a control.
    const rooms = probe.root().findAll((node) => node.props['data-entity'] === 'room');
    expect(rooms).toHaveLength(2);
    rooms[1]!.props.onClick({ currentTarget: {} });
    expect(goToRoom).toHaveBeenCalledWith('1/2', {});
  });
});
