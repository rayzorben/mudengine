import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import SharedCharacters from '../SharedCharacters';
import { mount } from '../../hooks/__tests__/mount';
import { t } from '../../lib/i18n';
import { afflicted, sharedSheet } from '@shared/__tests__/sharedSheets';

/*
 * Todo 20261031-1156-01: a shared character on the Players card, as the
 * sharer's own client states it; what it did not send reads as unknown.
 */
const probe = mount();
const NO_CONTROL = { onSelect: () => undefined, onControl: () => undefined, refused: null };
afterEach(() => probe.unmount());

const textOf = (name: string): string => {
  const row = probe.root().find((node) => node.props['data-shared-character'] === name);
  const words: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') words.push(node);
    else if (node !== null && typeof node === 'object' && 'children' in node) {
      for (const child of (node as { children: unknown[] }).children) walk(child);
    }
  };
  walk(row);
  return words.join(' ');
};

describe('the characters shared with this one', () => {
  it('draws a sharer’s figures and conditions, and unknown where nothing was sent', () => {
    const sheets = [
      sharedSheet('Brakkle', {
        level: 12,
        vitals: {
          hp: 40,
          hpMax: 120,
          mana: null,
          manaMax: 30,
          manaType: 'MA',
          resting: false,
          meditating: false
        },
        afflictions: afflicted('poisoned')
      }),
      sharedSheet('Soul')
    ];
    probe.render(createElement(SharedCharacters, { sheets, ...NO_CONTROL }));
    const brakkle = textOf('Brakkle');
    expect(brakkle).toContain(t('cards.players.shared.hp', { hp: '40', hpMax: '120' }));
    expect(brakkle).toContain(
      t('cards.players.shared.pool', {
        mana: t('cards.players.shared.unknown'),
        manaMax: '30',
        pool: 'MA'
      })
    );
    expect(brakkle).toContain(t('cards.vitals.afflicted.poisoned'));
    const soul = textOf('Soul');
    expect(soul).toContain(
      t('cards.players.shared.level', { level: t('cards.players.shared.unknown') })
    );
    expect(soul).toContain(t('cards.players.shared.conditionsUnknown'));
    expect(soul).toContain(t('cards.players.shared.roomUnknown'));
  });

  it('draws nothing while nobody shares', () => {
    probe.render(createElement(SharedCharacters, { sheets: [], ...NO_CONTROL }));
    expect(probe.root().findAll((node) => node.props['className'] === 'shared-characters')).toEqual(
      []
    );
    // Positive control: one sharer, and the section is there.
    probe.render(createElement(SharedCharacters, { sheets: [sharedSheet('Soul')], ...NO_CONTROL }));
    expect(
      probe.root().findAll((node) => node.props['className'] === 'shared-characters')
    ).toHaveLength(1);
  });

  it('offers remote control only of a sharer that gives it, and opens it by name', () => {
    const opened: string[] = [];
    const controls = (): unknown[] =>
      probe.root().findAll((node) => typeof node.props['data-remote-control'] === 'string');
    probe.render(createElement(SharedCharacters, { ...NO_CONTROL, sheets: [sharedSheet('Soul')] }));
    expect(controls()).toEqual([]);
    probe.render(
      createElement(SharedCharacters, {
        ...NO_CONTROL,
        onControl: (name: string) => opened.push(name),
        sheets: [sharedSheet('Soul'), sharedSheet('Brakkle', { control: true })]
      })
    );
    const [button] = probe
      .root()
      .findAll((node) => node.props['data-remote-control'] === 'Brakkle');
    expect(controls()).toHaveLength(1);
    (button!.props['onClick'] as () => void)();
    expect(opened).toEqual(['Brakkle']);
  });
});
