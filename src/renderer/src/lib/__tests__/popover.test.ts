import { describe, expect, it } from 'vitest';

import {
  clampPanel,
  placePopover,
  popoverWidth,
  scrollMovesAnchor,
  type Enclosing
} from '../popover';

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

/*
 * The width the panel is drawn at, from the room beside the name that was
 * clicked. Every case here is one the arithmetic gets wrong in a way nobody
 * clicks through by hand: an anchor hard against either edge, a window
 * narrower than the floor, and — the one that matters — a width that the side
 * `placePopover` then picks must still have room for.
 */
const range = { min: 300, max: 560 };

describe('how wide a slide-out is drawn', () => {
  it('takes the room to the right of the anchor, up to the ceiling', () => {
    // 1000 - 160 - 8 - 8 = 824 to the right, which is past the ceiling.
    expect(popoverWidth(box(100, 100), viewport, range)).toBe(560);
  });

  it('takes the whole window when neither side has room for the floor', () => {
    /*
     * An anchor filling the window. Neither side can hold the floor, so the
     * panel is going below, above or over it — and the room *there* is the
     * window less its margins, not the sliver beside the anchor.
     */
    expect(popoverWidth(box(0, 100, 1000), viewport, range)).toBe(560);
  });

  it('is never narrower than the floor, even in a window that cannot hold it', () => {
    // `max-width: calc(100vw - 16px)` in the stylesheet keeps it on screen;
    // the floor is what the two columns need to read as columns at all.
    expect(popoverWidth(box(20, 100), { width: 200, height: 600 }, range)).toBe(300);
  });

  it('takes the wider side when one of them is cramped', () => {
    // An anchor at 500: 424 to the right of it, 484 to the left. Neither
    // reaches the ceiling, so the answer is the roomier side exactly.
    expect(popoverWidth(box(500, 100), viewport, range)).toBe(484);
  });

  /*
   * The load-bearing one. `popoverWidth` and `placePopover` are two pieces of
   * arithmetic over the same numbers, and a width chosen from room the placer
   * then decides is not enough would put the panel below or over the anchor
   * instead of beside it — which is the placement of last resort.
   */
  it('always leaves the placer a side to use', () => {
    for (let left = 0; left <= 940; left += 20) {
      const anchor = box(left, 100);
      const width = popoverWidth(anchor, viewport, range);
      const at = placePopover(anchor, { width, height: 200 }, viewport);
      if (width < viewport.width - 16) expect(at.side === 'right' || at.side === 'left').toBe(true);
    }
  });
});

describe('a panel kept inside the window', () => {
  it('leaves an untroubled position alone', () => {
    expect(clampPanel({ top: 100, left: 200 }, panel, viewport)).toEqual({ top: 100, left: 200 });
  });

  it('pulls one dragged past an edge back inside it', () => {
    expect(clampPanel({ top: 590, left: 990 }, panel, viewport)).toEqual({ top: 392, left: 692 });
    expect(clampPanel({ top: -80, left: -80 }, panel, viewport)).toEqual({ top: 8, left: 8 });
  });

  /*
   * A panel larger than the window goes to the top-left rather than being
   * centred: the pin and the close glyph are in its heading, and the corner
   * that has to stay reachable is the one they are in.
   */
  it('pins one larger than the window to the corner its controls are in', () => {
    const huge = { width: 2000, height: 2000 };
    expect(clampPanel({ top: 300, left: 300 }, huge, viewport)).toEqual({ top: 8, left: 8 });
  });
});
