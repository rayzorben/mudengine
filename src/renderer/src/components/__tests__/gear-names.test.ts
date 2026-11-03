import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GearTripPlan } from '@shared/gearTrip';
import type { GearSlot } from '@shared/upgrades';
import GearSlotTile from '../GearSlotTile';
import GearTripFace from '../GearTripFace';
import { mount } from '../../hooks/__tests__/mount';

/*
 * Todo 20261102-1523-01: every name the Gear card prints opens its card. The
 * worn item opens the realm's answer, a stop's room the route panel, and a key
 * named inside a leg's sentence is a control too.
 */

const probe = mount();
afterEach(() => probe.unmount());

const slot = {
  slot: 'Head',
  worn: 'leather cap',
  ranking: 'armour',
  places: 1,
  items: []
} as unknown as GearSlot;

const plan: GearTripPlan = {
  from: '1/1',
  stops: [
    {
      kind: 'shop',
      room: '1/42',
      place: 'Market Square',
      shop: 'the armoury',
      items: [],
      leg: {
        steps: 3,
        fights: [],
        hazards: [],
        walls: [],
        needs: [{ id: 7, name: 'iron key' }],
        blocked: null
      }
    }
  ],
  moves: 3,
  owed: 0,
  unpriced: 0,
  purse: 0,
  short: 0,
  left: []
};

const buttonNamed = (text: string) =>
  probe.root().find((node) => node.type === 'button' && node.children.join('') === text);

describe('the gear card’s names', () => {
  it('opens the worn item’s card, and draws the slot name as text', () => {
    const inspect = vi.fn();
    probe.render(
      createElement(GearSlotTile, {
        slot,
        suggested: [],
        declined: new Set<string>(),
        chosen: false,
        budget: 0,
        inspect,
        onDecline: vi.fn(),
        onChoose: vi.fn(),
        onReset: vi.fn()
      })
    );
    // The positive control: the slot's own name, beside it, is no button.
    expect(
      probe.root().findAll((node) => node.type === 'button' && node.children.join('') === 'Head')
    ).toHaveLength(0);
    buttonNamed('leather cap').props.onClick({ currentTarget: 'cap' });
    expect(inspect).toHaveBeenCalledWith('leather cap', 'cap');
  });

  it('opens the route panel at a stop’s room, and a key the leg needs', () => {
    const goToRoom = vi.fn();
    const inspect = vi.fn();
    probe.render(
      createElement(GearTripFace, {
        plan,
        trip: null,
        onGo: vi.fn(),
        onStop: vi.fn(),
        onReplan: vi.fn(),
        inspect,
        goToRoom
      })
    );
    buttonNamed('the armoury').props.onClick({ currentTarget: 'shop' });
    buttonNamed('Market Square').props.onClick({ currentTarget: 'place' });
    expect(goToRoom.mock.calls).toEqual([
      ['1/42', 'shop'],
      ['1/42', 'place']
    ]);
    buttonNamed('iron key').props.onClick({ currentTarget: 'key' });
    expect(inspect).toHaveBeenCalledWith('iron key', 'key');
  });
});
