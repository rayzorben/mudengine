import { describe, expect, it } from 'vitest';

import { CARDS, cardLabel } from '../cards';
import { helpSections } from '../help';

describe('the help page', () => {
  it('has a sentence for every card, in the rail order', () => {
    const cards = helpSections().find((section) => section.id === 'cards');
    expect(cards?.rows.map((row) => row.label)).toEqual(CARDS.map((card) => cardLabel(card.id)));
    expect(cards?.rows.every((row) => row.text.length > 0)).toBe(true);
  });

  it('names what is on by default from the defaults, not from a copy', () => {
    const automation = helpSections().find((section) => section.id === 'automation');
    expect(automation?.paragraphs.some((text) => text.includes('{switches}'))).toBe(false);
  });
});
