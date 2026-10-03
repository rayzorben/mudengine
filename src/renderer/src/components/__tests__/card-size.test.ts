import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import CardTable, { type Column } from '../CardTable';
import { CardSizeContext } from '../../hooks/useCardSize';
import { mount } from '../../hooks/__tests__/mount';
import type { CardSize } from '../../lib/cardSize';
import type { SessionId } from '@shared/ipc';

interface Row {
  name: string;
  level: number;
  title: string;
}

const columns: Column<Row>[] = [
  { id: 'name', label: 'n', wide: true, value: (row) => row.name },
  { id: 'level', label: 'l', numeric: true, from: 'medium', value: (row) => row.level },
  { id: 'title', label: 't', from: 'large', value: (row) => row.title }
];

const view = mount();
afterEach(() => view.unmount());

function drawn(size: CardSize): string[] {
  view.render(
    createElement(
      CardSizeContext.Provider,
      { value: size },
      createElement(CardTable<Row>, {
        caption: 'c',
        columns,
        empty: 'none',
        keyOf: (row) => row.name,
        name: `card-size-${size}`,
        rows: [{ name: 'Rand', level: 12, title: 'Squire' }],
        session: 'card-size' as SessionId
      })
    )
  );
  return view
    .root()
    .findAll((node) => node.type === 'th' && typeof node.props['data-column'] === 'string')
    .map((node) => node.props['data-column'] as string);
}

describe('a card table draws the columns its size has room for', () => {
  it('small, only what is marked for every size', () => {
    expect(drawn('small')).toEqual(['name']);
  });

  it('medium, what the card ships with', () => {
    expect(drawn('medium')).toEqual(['name', 'level']);
  });

  it('large, every column', () => {
    expect(drawn('large')).toEqual(['name', 'level', 'title']);
  });
});
