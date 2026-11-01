import { describe, expect, it } from 'vitest';

import { LAYOUT_FILE_KIND } from '@shared/cardLayoutFile';

import {
  arrangementKey,
  arrangementOf,
  LAYOUT_NAME_MAX,
  layoutFileText,
  layoutName,
  shownLayout,
  withLayout,
  withoutLayout,
  writtenLayoutFile,
  type NamedLayout
} from '../../lib/cardLayouts';
import { CARDS, type CardArrangement } from '../../lib/cards';
import { normalizeLayout } from '../useCardLayout';
import { namedLayoutOf } from '../useNamedLayouts';

/** The shipped layout with the map taken off the rail into a float and Vitals sized. */
function arranged(): CardArrangement {
  const shipped = normalizeLayout({});
  return arrangementOf(
    normalizeLayout({
      ...shipped,
      rail: shipped.rail.filter((id) => id !== 'map'),
      floats: [...shipped.floats, { id: 'map', x: 0.1, y: 0.2, w: 0.3, h: 0.4, solidity: 0.5 }],
      sizes: { vitals: { w: 20, h: 9 } }
    })
  );
}

/** The same value with every object's keys in the opposite order. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value).reverse();
  return Object.fromEntries(entries.map(([key, field]) => [key, reversed(field)]));
}

describe('a layout name', () => {
  it('is what was typed, trimmed, with runs of space made one', () => {
    expect(layoutName('  Hunting   the  orcs ')).toBe('Hunting the orcs');
  });

  it('is cut to the longest kept', () => {
    expect(layoutName('x'.repeat(LAYOUT_NAME_MAX + 9))).toHaveLength(LAYOUT_NAME_MAX);
  });

  it('is nothing for blank text', () => {
    expect(layoutName('   ')).toBeNull();
  });
});

describe('which saved layout the cards stand in', () => {
  it('is the one with every card in the same place, whatever order its keys were written in', () => {
    const layout = arranged();
    const reordered = reversed(layout) as CardArrangement;
    expect(arrangementKey(reordered)).toBe(arrangementKey(layout));
    expect(shownLayout([{ name: 'Hunting', layout }], layout)).toBe('Hunting');
  });

  it('is none once a card has moved', () => {
    const layout = arranged();
    const moved = { ...layout, sizes: { vitals: { w: 20, h: 10 } } };
    expect(shownLayout([{ name: 'Hunting', layout }], moved)).toBeNull();
  });

  it('is still the one put on, with what is set on each card kept', () => {
    const layout = arranged();
    const put = normalizeLayout({ ...layout, settings: { map: { autoHide: true } } });
    expect(put.settings).toEqual({ map: { autoHide: true } });
    expect(shownLayout([{ name: 'Hunting', layout }], put)).toBe('Hunting');
  });
});

describe('the saved list', () => {
  const a: NamedLayout = { name: 'A', layout: arranged() };
  const b: NamedLayout = { name: 'B', layout: arrangementOf(normalizeLayout({})) };

  it('replaces a layout saved under the same name where it stands', () => {
    const replaced = { ...a, layout: b.layout };
    expect(withLayout([a, b], replaced)).toEqual([replaced, b]);
  });

  it('adds a new name at the end, and drops one by name', () => {
    expect(withLayout([a], b)).toEqual([a, b]);
    expect(withoutLayout([a, b], 'A')).toEqual([b]);
  });
});

describe('a card layout file', () => {
  it('reads back as the layout written', () => {
    const entry: NamedLayout = { name: 'Hunting', layout: arranged() };
    const written = writtenLayoutFile(layoutFileText(entry));
    expect(written).not.toBeNull();
    expect(namedLayoutOf(written)).toEqual(entry);
  });

  it('is refused when it is not JSON, not a layout, or has no name', () => {
    expect(writtenLayoutFile('{')).toBeNull();
    expect(writtenLayoutFile(JSON.stringify({ name: 'x', layout: {} }))).toBeNull();
    expect(writtenLayoutFile(JSON.stringify({ kind: LAYOUT_FILE_KIND, layout: {} }))).toBeNull();
    expect(
      writtenLayoutFile(JSON.stringify({ kind: LAYOUT_FILE_KIND, name: ' ', layout: {} }))
    ).toBeNull();
  });

  it('drops a card this build does not have and puts every card it has somewhere', () => {
    const text = JSON.stringify({
      kind: LAYOUT_FILE_KIND,
      name: 'Old',
      layout: { rail: ['map', 'no-such-card'], away: 'not a list' }
    });
    const read = namedLayoutOf(writtenLayoutFile(text));
    expect(read?.layout.rail[0]).toBe('map');
    const seen = [
      ...(read?.layout.rail ?? []),
      ...(read?.layout.above ?? []),
      ...(read?.layout.below ?? []),
      ...(read?.layout.floats.map((float) => float.id) ?? []),
      ...(read?.layout.away ?? [])
    ];
    expect([...seen].sort()).toEqual(CARDS.map((card) => card.id).sort());
  });
});
