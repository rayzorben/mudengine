import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { CARD_SIZES, cardSizeOf, drawnAt } from '../cardSize';

const root = path.resolve(__dirname, '..', '..', '..', '..', '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
const bounds = { medium: 160, large: 300 };

describe('the size a card draws at', () => {
  it('is decided by the shorter side of its box', () => {
    expect(cardSizeOf({ width: 100, height: 100 }, bounds)).toBe('small');
    expect(cardSizeOf({ width: 600, height: 140 }, bounds)).toBe('small');
    expect(cardSizeOf({ width: 260, height: 160 }, bounds)).toBe('medium');
    expect(cardSizeOf({ width: 299, height: 900 }, bounds)).toBe('medium');
    expect(cardSizeOf({ width: 300, height: 300 }, bounds)).toBe('large');
  });

  it('is unknown for a card with no box', () => {
    expect(cardSizeOf({ width: 0, height: 200 }, bounds)).toBeNull();
    expect(cardSizeOf({ width: Number.NaN, height: 200 }, bounds)).toBeNull();
  });

  it('draws at a size everything marked for that size or a smaller one', () => {
    expect(drawnAt('small', 'small')).toBe(true);
    expect(drawnAt('small', 'medium')).toBe(false);
    expect(drawnAt('medium', 'medium')).toBe(true);
    expect(drawnAt('medium', 'large')).toBe(false);
    expect(drawnAt('large', 'medium')).toBe(true);
  });
});

describe('the lengths and the classes live in the stylesheet', () => {
  it('declares both lengths once, the large past the medium', () => {
    const tokens = read('src/renderer/src/styles/tokens.css');
    const length = (name: string): number[] =>
      [...tokens.matchAll(new RegExp(`--card-size-${name}:\\s*(\\d+)px`, 'g'))].map((m) =>
        Number(m[1])
      );
    expect(length('medium')).toHaveLength(1);
    expect(length('large')).toHaveLength(1);
    expect(length('large')[0]!).toBeGreaterThan(length('medium')[0]!);
  });

  it('hides each size class by the sizes the type names', () => {
    const css = read('src/renderer/src/styles/index.css');
    // Every size the attribute can carry is one the type has.
    const named = new Set([...css.matchAll(/data-card-size='(\w+)'/g)].map((match) => match[1]!));
    expect(named.size).toBeGreaterThan(0);
    for (const size of named) expect(CARD_SIZES).toContain(size);
    expect(css).toMatch(/\.card\[data-card-size='small'\] \.from-medium/);
    expect(css).toMatch(/\.card:not\(\[data-card-size='large'\]\) \.from-large/);
    expect(css).toMatch(/\.card:not\(\[data-card-size='small'\]\) \.only-small/);
  });
});
