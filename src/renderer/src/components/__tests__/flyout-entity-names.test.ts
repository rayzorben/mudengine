import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '@shared/character';
import type { RoomBrief, WorldLair, WorldMob } from '@shared/world';
import ReferenceDetail from '../ReferenceDetail';
import RoomQuickView from '../RoomQuickView';
import TargetCard from '../game/TargetCard';
import { mount } from '../../hooks/__tests__/mount';

vi.mock('react-dom', async (actual) => ({
  ...(await actual<typeof import('react-dom')>()),
  // The test renderer has no document to portal into; the panel draws in place.
  createPortal: (children: unknown) => children
}));

/*
 * Todo 20261102-1523-01: a name printed in a panel or the game view is the
 * control that opens its card. Each case clicks the name and expects the
 * opener to hear it.
 */

const probe = mount();
afterEach(() => probe.unmount());

const buttonsNamed = (name: string) =>
  probe
    .root()
    .findAll((node) => node.type === 'button' && node.props['data-entity'] === 'realm')
    .filter((node) => node.children.join('') === name);

const ogre = {
  name: 'ogre',
  hp: 30,
  disposition: null,
  drops: ['club', 'ogre hide']
} as unknown as WorldMob;

describe('a monster’s drops in the reference panel', () => {
  it('opens each item it drops', () => {
    const onName = vi.fn();
    probe.render(
      createElement(ReferenceDetail, {
        entry: {
          kind: 'mob',
          name: 'ogre',
          mob: ogre,
          learned: null,
          fights: null,
          verdict: null,
          places: null,
          peace: null
        },
        level: 10,
        onName
      })
    );
    expect(buttonsNamed('ogre hide')).toHaveLength(1);
    buttonsNamed('club')[0]!.props.onClick({ currentTarget: 'anchor' });
    expect(onName).toHaveBeenCalledWith('club', 'anchor');
  });
});

describe('a lair in the room quick view', () => {
  it('opens the monster it spawns', async () => {
    // The panel listens on, and portals into, the document; the mock above draws it in place.
    const listens = { addEventListener: () => undefined, removeEventListener: () => undefined };
    vi.stubGlobal('document', { body: {}, ...listens });
    vi.stubGlobal('window', { ...listens, innerWidth: 1000, innerHeight: 800 });
    try {
      const inspect = vi.fn();
      const lair = { max: 2, mobs: [{ ...ogre, row: { id: 7 } }] } as unknown as WorldLair;
      const brief = { id: '1/2', name: 'Den', exits: [], lair } as unknown as RoomBrief;
      probe.render(
        createElement(RoomQuickView, {
          asked: {
            room: '1/2',
            anchor: { box: { left: 0, top: 0, right: 1, bottom: 1 }, within: {} as HTMLElement },
            settled: true,
            act: null,
            also: null
          },
          load: () => Promise.resolve(brief),
          standing: { alignment: null } as never,
          onDismiss: () => undefined,
          onPointerEnter: () => undefined,
          onPointerLeave: () => undefined,
          inspect
        })
      );
      // The brief lands on a later turn; the monster's button is the sign it did.
      await vi.waitFor(() => expect(buttonsNamed('ogre')).toHaveLength(1));
      buttonsNamed('ogre')[0]!.props.onClick({ currentTarget: 'anchor' });
      expect(inspect).toHaveBeenCalledWith('ogre', 'anchor');
      // Put down while the stubs stand: its effects clean up against them.
      probe.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the game view’s target card', () => {
  it('opens the monster being fought', () => {
    const inspect = vi.fn();
    const character: CharacterState = {
      ...EMPTY_CHARACTER,
      combat: { ...EMPTY_CHARACTER.combat, target: 'ogre' }
    };
    probe.render(createElement(TargetCard, { character, target: 'ogre', inspect }));
    buttonsNamed('ogre')[0]!.props.onClick({ currentTarget: 'anchor' });
    expect(inspect).toHaveBeenCalledWith('ogre', 'anchor');
  });
});
