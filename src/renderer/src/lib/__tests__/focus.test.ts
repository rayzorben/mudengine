import { describe, expect, it } from 'vitest';

import { caretIsFree, describeElement, ownsItsEnter, type KeyTarget } from '../focus';

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

describe('whether the caret is free to take back', () => {
  const holder = (tagName: string, classes: string[] = []) => ({
    tagName,
    matches: (selector: string) => classes.some((name) => selector === `.${name}`)
  });

  it('is free on the page and on the game view’s layer', () => {
    expect(caretIsFree(null)).toBe(true);
    expect(caretIsFree(holder('BODY'))).toBe(true);
    expect(caretIsFree(holder('DIV', ['gv-root']))).toBe(true);
  });

  it('is held by a field, a button or anything else', () => {
    expect(caretIsFree(holder('INPUT', ['palette-input']))).toBe(false);
    expect(caretIsFree(holder('BUTTON', ['gv-icon-button']))).toBe(false);
  });
});
