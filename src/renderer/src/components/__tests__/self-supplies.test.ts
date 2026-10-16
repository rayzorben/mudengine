import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CardChrome } from '../BentoCard';
import { cardElement } from '../CardSwitch';
import SelfCard from '../SelfCard';
import type { SupplyList } from '../SupplyControls';
import type { CardContext } from '../../hooks/useCardContext';
import { CardSizeContext } from '../../hooks/useCardSize';
import { mount } from '../../hooks/__tests__/mount';
import { EMPTY_CHARACTER } from '@shared/character';
import type { SessionId } from '@shared/ipc';
import type { SupplyItem } from '@shared/packConfig';

/*
 * Todo 149: the Self card's Supplies face. The bin removes its row and a Min
 * typed is written onto it, on the shown character's card and on another
 * character's pinned float alike, each to its own character.
 */
const SESSION = 'rayzor' as SessionId;
const torch: SupplyItem = { name: 'torch', min: 3, max: 6, shop: 'General Store', at: null };

const probe = mount();
afterEach(() => {
  probe.unmount();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  // The Supplies face, as the card remembers it.
  const stored: Record<string, string> = { [`mudengine.self-tab.${SESSION}`]: 'supplies' };
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => stored[key] ?? null,
      setItem: (key: string, value: string) => (stored[key] = value)
    }
  });
});

function supplyList(): { list: SupplyList; changes: (SupplyItem | null)[] } {
  const changes: (SupplyItem | null)[] = [];
  const list: SupplyList = {
    items: [torch],
    edit: (name, change) => changes.push(change(name === torch.name ? torch : null)),
    counters: () => new Promise(() => undefined)
  };
  return { list, changes };
}

function draw(supplies: SupplyList): void {
  probe.render(
    createElement(
      CardSizeContext.Provider,
      { value: 'medium' },
      createElement(SelfCard, {
        ...({} as CardChrome),
        character: EMPTY_CHARACTER,
        session: SESSION,
        profileName: 'Rayzor',
        supplies,
        suppliesOn: true
      })
    )
  );
}

describe("the Self card's supplies", () => {
  it('removes the row the bin is on', () => {
    const { list, changes } = supplyList();
    draw(list);
    const bin = probe
      .root()
      .findAll((node) => node.type === 'button' && node.props['className'] === 'row-action');
    expect(bin).toHaveLength(1);
    act(() => bin[0]?.props['onClick']());
    expect(changes).toEqual([null]);
  });

  it('writes a Min typed onto its row', () => {
    const { list, changes } = supplyList();
    draw(list);
    const [min] = probe.root().findAll((node) => node.type === 'input');
    act(() => min?.props['onChange']({ target: { value: '2' } }));
    act(() => min?.props['onBlur']());
    expect(changes).toEqual([{ ...torch, min: 2 }]);
  });

  it("hands a pinned float its own character's list and write", () => {
    const { list } = supplyList();
    const ctx = {
      chrome: {} as CardChrome,
      character: EMPTY_CHARACTER,
      view: {},
      session: SESSION,
      inGame: false,
      chooseOnMap: null,
      supplies: list,
      toolbar: { switches: { supplies: true } }
    } as unknown as CardContext;
    const element = cardElement('self', ctx) as { props: { supplies: SupplyList } };
    expect(element.props.supplies).toBe(list);
  });
});
