import { describe, expect, it } from 'vitest';

import { placePopover, scrollMovesAnchor, type Enclosing } from '../popover';

const viewport = { width: 1000, height: 600 };
const panel = { width: 300, height: 200 };
const box = (left: number, top: number, width = 60, height = 16) => ({
  left,
  top,
  right: left + width,
  bottom: top + height
});

/*
 * The order is the design: right, then left, then below, then above, then
 * over the anchor. Each case moves the anchor until the previous side is out
 * of room, so a change to the order fails here rather than being noticed as a
 * panel covering the name it was opened from.
 */
describe('where a slide-out lands', () => {
  it('opens to the right when there is room, level with the anchor', () => {
    const at = placePopover(box(100, 100), panel, viewport);
    expect(at.side).toBe('right');
    expect(at.left).toBe(168);
    expect(at.top).toBe(100);
  });

  it('opens to the left when the right is short', () => {
    const at = placePopover(box(800, 100), panel, viewport);
    expect(at.side).toBe('left');
    expect(at.left).toBe(800 - 8 - 300);
  });

  it('opens below when neither side has room', () => {
    const narrow = { width: 400, height: 600 };
    const at = placePopover(box(50, 100), panel, narrow);
    expect(at.side).toBe('below');
    expect(at.top).toBe(100 + 16 + 8);
    expect(at.left).toBe(50);
  });

  it('opens above when below is short as well', () => {
    const narrow = { width: 400, height: 600 };
    const at = placePopover(box(50, 500), panel, narrow);
    expect(at.side).toBe('above');
    expect(at.top).toBe(500 - 8 - 200);
  });

  it('lies over the anchor when nothing else fits, and stays in the window', () => {
    const tiny = { width: 320, height: 240 };
    const at = placePopover(box(150, 120), panel, tiny);
    expect(at.side).toBe('over');
    expect(at.left).toBeGreaterThanOrEqual(8);
    expect(at.top).toBeGreaterThanOrEqual(8);
    expect(at.left + panel.width).toBeLessThanOrEqual(tiny.width - 8);
    expect(at.top + panel.height).toBeLessThanOrEqual(tiny.height - 8);
  });

  /* A row at the foot of a card must not put the panel off the bottom. */
  it('keeps a side panel inside the window vertically', () => {
    const at = placePopover(box(100, 580), panel, viewport);
    expect(at.side).toBe('right');
    expect(at.top).toBe(600 - 200 - 8);
  });

  it('never goes above the top margin', () => {
    const at = placePopover(box(100, 0), panel, viewport);
    expect(at.top).toBe(8);
  });
});

/**
 * A stand-in for a DOM node that knows only what is inside it, which is all the
 * dismissal rule asks of one. The suite runs with no DOM (`vitest.config.ts`
 * sets `environment: 'node'`), and the rule is worth testing where the listener
 * plumbing around it is not.
 */
type Fake = Enclosing & { readonly kids: readonly Fake[] };
const node = (...kids: Fake[]): Fake => {
  const self: Fake = {
    kids,
    contains: (inside) => inside === self || kids.some((kid) => kid.contains(inside))
  };
  return self;
};

describe('a scroll closes a panel only when it moved the panel', () => {
  /*
   * The terminal and the chrome are two surfaces. A `scroll` listener has to
   * be captured at the window to hear a scrolling element at all, so every
   * scroller in the client arrives at the same handler — and the loudest is
   * the console, which scrolls to the bottom on every line the game prints.
   * Dismissing on all of them took the realm's answer about a clicked item
   * away the instant anything arrived, which in a MUD is immediately.
   */
  it('leaves a panel opened from a card alone when the console scrolls', () => {
    // Two trees, as the two surfaces are on screen: the pack's row lives under
    // the rail, and the word the game just printed under the terminal.
    const sandals = node();
    const rail = node(node(sandals));
    const terminal = node(node());
    expect(scrollMovesAnchor(terminal, sandals)).toBe(false);
    // And the rail, which does move it, still does.
    expect(scrollMovesAnchor(rail, sandals)).toBe(true);
  });

  it('closes it when the list the name sits in scrolls', () => {
    // The positive control: without this the rule above would pass just as
    // well if nothing ever dismissed, which is a panel that will not go away.
    const sandals = node();
    const pack = node(sandals);
    expect(scrollMovesAnchor(pack, sandals)).toBe(true);
  });

  it('closes a panel opened from a word in the console when the console scrolls', () => {
    // `within` is `.xterm-screen`, which sits inside `.xterm-viewport` — the
    // element that actually moves. The mount is the viewport's *parent*, and
    // would have answered no to the one scroll that does move the word.
    const screen = node();
    const viewport = node(screen);
    expect(scrollMovesAnchor(viewport, screen)).toBe(true);
  });

  it('does not close it when a card elsewhere scrolls', () => {
    const screen = node();
    const talk = node(node());
    expect(scrollMovesAnchor(talk, screen)).toBe(false);
  });

  it('closes it when something scrolled that is not a node at all', () => {
    // A scroll reported against the document or the window moved the page, and
    // with it everything laid out in it.
    expect(scrollMovesAnchor(null, node())).toBe(true);
    expect(scrollMovesAnchor(undefined, node())).toBe(true);
  });
});

describe('a fixed point is not moved by scrolling', () => {
  /*
   * A right-click's anchor is the pointer: a point in the window, in no
   * document flow, that no scroll can move. It used to close on any scroll,
   * so the console's own auto-scroll shut the terminal's context menu on the
   * next line of output — the same complaint one surface further along.
   * A click elsewhere, Escape and a resize still close it.
   */
  it('survives every scroll', () => {
    expect(scrollMovesAnchor(node(), null)).toBe(false);
    expect(scrollMovesAnchor(null, null)).toBe(false);
  });
});
