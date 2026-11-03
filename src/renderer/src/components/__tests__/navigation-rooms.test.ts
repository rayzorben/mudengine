import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CardChrome } from '../BentoCard';
import NavigationCard from '../NavigationCard';
import { CardSizeContext } from '../../hooks/useCardSize';
import { mount } from '../../hooks/__tests__/mount';
import { EMPTY_CHARACTER } from '@shared/character';
import { NO_LOOP } from '@shared/loops';
import { IDLE_WALK, type WalkProgress } from '@shared/walk';

/*
 * Todo 1523: the rooms ahead on the Navigation card are names a player acts
 * on, so each placed one opens the route panel, and one the client could not
 * place stays text.
 */

const probe = mount();
afterEach(() => {
  probe.unmount();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  // The card's clock and its remembered face; neither is what is tested.
  vi.stubGlobal('window', {
    setInterval: () => 0,
    clearInterval: () => undefined,
    localStorage: { getItem: () => null, setItem: () => undefined }
  });
});

const walking: WalkProgress = {
  ...IDLE_WALK,
  status: 'walking',
  total: 2,
  destination: 'Town Square',
  destinationRoom: { map: 1, room: 3 },
  ahead: [
    { name: 'Market Street', room: { map: 1, room: 2 } },
    { name: 'Somewhere Dark', room: null }
  ]
};

describe('the rooms ahead on the Navigation card', () => {
  it('opens a placed room in the route panel and leaves an unplaced one as text', () => {
    const chosen: Array<[number, number]> = [];
    probe.render(
      createElement(
        CardSizeContext.Provider,
        { value: 'medium' },
        createElement(NavigationCard, {
          ...({} as CardChrome),
          walk: walking,
          loop: NO_LOOP,
          character: EMPTY_CHARACTER,
          loops: null,
          onChoose: (map: number, room: number) => chosen.push([map, room]),
          onStart: vi.fn(),
          onStop: vi.fn(),
          onWalkOn: vi.fn(),
          onReverseLoop: vi.fn()
        })
      )
    );
    const names = probe.root().findAll((node) => node.props.className === 'step-name');
    const ahead = names.filter((node) => node.parent?.type === 'li');
    expect(ahead).toHaveLength(2);
    const market = ahead[0]!.findByType('button');
    market.props.onClick();
    expect(chosen).toEqual([[1, 2]]);
    expect(ahead[1]!.findAllByType('button')).toHaveLength(0);
    expect(ahead[1]!.children).toEqual(['Somewhere Dark']);
  });
});
