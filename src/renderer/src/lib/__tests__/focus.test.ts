import { describe, expect, it } from 'vitest';

import { describeElement, ownsItsEnter, type KeyTarget } from '../focus';

const element = (over: Partial<KeyTarget> & { inside?: string[] } = {}): KeyTarget => {
  const inside = over.inside ?? [];
  return {
    tagName: 'BUTTON',
    isContentEditable: false,
    textContent: null,
    getAttribute: () => null,
    closest: (selector) =>
      selector.split(',').some((part) => inside.includes(part.trim())) ? {} : null,
    ...over
  };
};

/* Todo 00: an Enter for the game that went somewhere else says where. */
describe('where a plain Enter went', () => {
  it('leaves a text field, a key-owning surface and a dialog their own Enter', () => {
    expect(ownsItsEnter(element({ tagName: 'INPUT' }))).toBe(true);
    expect(ownsItsEnter(element({ tagName: 'textarea' }))).toBe(true);
    expect(ownsItsEnter(element({ tagName: 'SELECT' }))).toBe(true);
    expect(ownsItsEnter(element({ tagName: 'DIV', isContentEditable: true }))).toBe(true);
    expect(ownsItsEnter(element({ inside: ['[data-owns-keys]'] }))).toBe(true);
    expect(ownsItsEnter(element({ inside: ['[role="dialog"]'] }))).toBe(true);
  });

  it('counts a button on a card as somewhere an Enter went astray', () => {
    expect(ownsItsEnter(element())).toBe(false);
  });

  it('names an element by its label, else a control by its text, else its tag', () => {
    expect(
      describeElement(element({ getAttribute: (name) => (name === 'aria-label' ? 'Walk' : null) }))
    ).toBe('button "Walk"');
    expect(describeElement(element({ textContent: '  Stop\n  moving ' }))).toBe(
      'button "Stop moving"'
    );
    // A card's whole text is not its name.
    expect(describeElement(element({ tagName: 'DIV', textContent: 'a card full of text' }))).toBe(
      'div'
    );
    expect(describeElement(element({ tagName: 'BODY' }))).toBe('body');
  });
});
