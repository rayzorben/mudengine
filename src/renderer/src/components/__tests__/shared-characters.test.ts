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
    probe.render(createElement(SharedCharacters, { sheets, onSelect: () => undefined }));
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
    probe.render(createElement(SharedCharacters, { sheets: [], onSelect: () => undefined }));
    expect(probe.root().findAll((node) => node.props['className'] === 'shared-characters')).toEqual(
      []
    );
    // Positive control: one sharer, and the section is there.
    probe.render(
      createElement(SharedCharacters, { sheets: [sharedSheet('Soul')], onSelect: () => undefined })
    );
    expect(
      probe.root().findAll((node) => node.props['className'] === 'shared-characters')
    ).toHaveLength(1);
  });
});
