import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';

import { EMPTY_CHARACTER, type CharacterState, type PartyMember } from '@shared/character';
import { DEFAULT_CONFIG } from '@shared/config';
import { withHidden } from '@shared/stash';
import { InventoryBody } from '../InventoryCard';
import PartyMemberRow from '../PartyMemberRow';
import RealmCard from '../RealmCard';
import { mount } from '../../hooks/__tests__/mount';

/*
 * Todo 20261102-1523-01: a name printed in a list is a control that opens its
 * card. Each case clicks a name and checks the opener it reached; the
 * positive control is a row beside it that the same surface leaves as text.
 */

const probe = mount();
afterEach(() => probe.unmount());

/** The button drawing exactly `text`. */
function control(text: string): ReactTestInstance {
  return probe.root().find((node) => node.type === 'button' && textOf(node) === text);
}

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
}

const anchor = { getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0 }) };

describe('the Inventory card’s keys and stash', () => {
  const character: CharacterState = {
    ...EMPTY_CHARACTER,
    inventory: { ...EMPTY_CHARACTER.inventory, keys: ['bone key', 'bone key'] },
    stash: withHidden(
      withHidden([], { map: 1, room: 2150, name: 'Ganghouse, Vault' }, 'torch', 3, 1),
      { map: null, room: null, name: null },
      'katana',
      1,
      2
    )
  };

  it('opens each key, each hidden item and a placed stash’s room', () => {
    const inspect = vi.fn();
    const goToRoom = vi.fn();
    probe.render(createElement(InventoryBody, { character, session: 's', inspect, goToRoom }));
    control('2 bone key').props['onClick']({ currentTarget: anchor });
    control('3 torch').props['onClick']({ currentTarget: anchor });
    expect(inspect.mock.calls.map(([name]) => name)).toEqual(['bone key', 'torch']);
    control('Ganghouse, Vault').props['onClick']({ currentTarget: anchor });
    expect(goToRoom).toHaveBeenCalledWith('1/2150', anchor);
    // A stash the client could not place has no room to open: its name is text.
    const buttons = probe
      .root()
      .findAll((node) => node.type === 'button')
      .map(textOf);
    expect(buttons).toContain('katana');
    expect(buttons.some((text) => text.includes('could not place'))).toBe(false);
  });
});

describe('a Party card row', () => {
  const member: PartyMember = {
    name: 'Festus',
    className: 'Warrior',
    health: 1,
    mana: null,
    pool: null,
    rank: 'front',
    activity: null,
    invited: false
  } as PartyMember;

  it('opens the class and the monsters, and leaves the name text for a stranger', () => {
    const inspect = vi.fn();
    probe.render(
      createElement(PartyMemberRow, {
        member,
        className: 'Warrior',
        thresholds: DEFAULT_CONFIG.ui.vitals,
        head: false,
        self: false,
        person: false,
        selected: false,
        fighting: 'kobold thief',
        hitBy: 'orc scout',
        inspect
      })
    );
    for (const name of ['Warrior', 'kobold thief', 'orc scout']) {
      control(name).props['onClick']({ currentTarget: anchor });
    }
    expect(inspect.mock.calls.map(([name]) => name)).toEqual([
      'Warrior',
      'kobold thief',
      'orc scout'
    ]);
    // Not known as a person, so no flyout: the name is not a button.
    const buttons = probe
      .root()
      .findAll((node) => node.type === 'button')
      .map(textOf);
    expect(buttons).not.toContain('Festus');
  });
});

describe('the Realm card’s gangs', () => {
  it('opens the gang from its column and its chip', () => {
    const onSelectGang = vi.fn();
    probe.render(
      createElement(RealmCard, {
        online: [
          {
            name: 'Festus',
            alignment: 'Neutral',
            title: 'Squire',
            flags: null,
            gang: 'EyeExploredDora',
            provisional: false
          }
        ],
        self: null,
        inGame: true,
        session: 's',
        subject: null,
        onSelect: vi.fn(),
        onSelectGang
      } as never)
    );
    const gangs = probe
      .root()
      .findAll((node) => node.type === 'button' && textOf(node) === 'EyeExploredDora');
    expect(gangs.length).toBeGreaterThan(0);
    gangs[0]!.props['onClick']({
      currentTarget: { ...anchor, closest: () => null }
    });
    expect(onSelectGang).toHaveBeenCalledWith('EyeExploredDora', expect.anything());
  });
});
