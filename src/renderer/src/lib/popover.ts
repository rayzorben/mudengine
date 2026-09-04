import type { Box, Size } from './menu';
import { tuning } from './tuning';

/** Which side of what was clicked the panel opens on. */
export type PopoverSide = 'right' | 'left' | 'below' | 'above' | 'over';

export interface PopoverPlacement {
  top: number;
  left: number;
  side: PopoverSide;
}

/**
 * Where a slide-out lands, given what was clicked and how big the panel is.
 *
 * Somebody clicked a *name* and wants to read about it, then put it away: the
 * panel belongs beside the name so the eye does not have to travel, and it
 * must not cover the thing it was opened from. So the sides are tried in a
 * fixed order — right, left, below, above — and the first one with room wins.
 * Right first because the rail is at the right of the console and the console
 * is the wide thing: a panel opening leftward from a rail card lands over the
 * game, which is the one place it should go last.
 *
 * `over` is the last resort, for a window too small for any side: the panel is
 * centred on the anchor and clamped into the window, and the caller animates
 * it as a fade rather than a slide because there is no edge to slide from.
 *
 * Pure, so the edge cases are tested rather than discovered: an anchor at the
 * window's edge, a panel taller than the window, a zero-size anchor.
 */
export function placePopover(anchor: Box, panel: Size, viewport: Size): PopoverPlacement {
  // Read once for the whole placement, so every comparison below is against
  // the same pair even if the file is saved mid-gesture.
  const { popoverGap: gap, popoverMargin: margin } = tuning();
  const clampTop = (top: number): number =>
    Math.max(margin, Math.min(top, viewport.height - panel.height - margin));
  const clampLeft = (left: number): number =>
    Math.max(margin, Math.min(left, viewport.width - panel.width - margin));

  // Lined up with the anchor's top edge, so a row and its panel read as one.
  const beside = clampTop(anchor.top);
  if (anchor.right + gap + panel.width + margin <= viewport.width) {
    return { top: beside, left: anchor.right + gap, side: 'right' };
  }
  if (anchor.left - gap - panel.width >= margin) {
    return { top: beside, left: anchor.left - gap - panel.width, side: 'left' };
  }

  // Lined up with the anchor's left edge, the way a menu hangs off its button.
  const under = clampLeft(anchor.left);
  if (anchor.bottom + gap + panel.height + margin <= viewport.height) {
    return { top: anchor.bottom + gap, left: under, side: 'below' };
  }
  if (anchor.top - gap - panel.height >= margin) {
    return { top: anchor.top - gap - panel.height, left: under, side: 'above' };
  }

  const middleX = (anchor.left + anchor.right) / 2;
  const middleY = (anchor.top + anchor.bottom) / 2;
  return {
    top: clampTop(middleY - panel.height / 2),
    left: clampLeft(middleX - panel.width / 2),
    side: 'over'
  };
}

/**
 * What a panel hangs off, and what scrolling would move it.
 *
 * A control is its own answer: it is an element, so the browser can be asked
 * whether the thing that just scrolled contains it. A word in the console is
 * not — xterm paints cells, so there is no node — and a bare rectangle cannot
 * say what would move it. So a box arrives paired with the element it was
 * measured inside, and the two cannot be separated: a `Box` on its own is not
 * a `PopoverAnchor`.
 *
 * `within` is the element **inside** the scroller, not the scroller itself.
 * For the console that is `.xterm-screen`, which sits within `.xterm-viewport`
 * — the thing that actually moves when output arrives — so the containment
 * test below reads the same way for both kinds of anchor.
 */
export type PopoverAnchor = HTMLElement | { box: Box; within: HTMLElement };

/** The anchor's rectangle, however it was given. */
export function anchorRect(anchor: PopoverAnchor): Box {
  return anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor.box;
}

/**
 * The part of a DOM node this needs: whether another one sits inside it.
 *
 * Structural rather than `Node`, because the unit suite runs with no DOM at
 * all (`vitest.config.ts` sets `environment: 'node'`) and this decision is the
 * only part of the dismissal path worth testing — the rest is listener
 * plumbing. A real `Node` satisfies it without a cast.
 */
export interface Enclosing {
  contains(inside: Enclosing | null): boolean;
}

/** The element whose scrolling moves the anchor, or null for a fixed point. */
export function anchorNode(anchor: PopoverAnchor | { x: number; y: number }): Enclosing | null {
  if (anchor instanceof HTMLElement) return anchor;
  return 'within' in anchor ? anchor.within : null;
}

/**
 * Whether a scroll that just happened actually moved the panel's anchor.
 *
 * **The terminal and the chrome are two surfaces, and a scroll in one is not
 * news in the other.** A `scroll` listener has to be captured at the window to
 * hear scrolling elements at all — scroll does not bubble — so *every*
 * scroller in the client reports here: the rail when a card mounts, the Talk
 * log when somebody speaks, and the console on every line the game prints,
 * because a pinned terminal scrolls to the bottom on each write and xterm's
 * viewport fires a real DOM event doing it. Dismissing on all of them meant
 * the realm's answer about a clicked item vanished the instant anything
 * arrived — which, in a MUD, is immediately.
 *
 * So a scroll dismisses only when the thing that scrolled encloses the anchor,
 * which is exactly when the anchor has moved on screen. `PopupMenu` already
 * had this rule for the same reason a card mounting used to close a tab's menu
 * under the pointer; this is that rule stated once, for both.
 *
 * A null anchor is a fixed point in the window — a right-click, which is at
 * the pointer and not in any document flow. Nothing scrolling can move it, so
 * nothing scrolling dismisses it; a click elsewhere, Escape or a resize still
 * does.
 */
export function scrollMovesAnchor(scrolled: unknown, anchor: Enclosing | null): boolean {
  if (anchor === null) return false;
  // Anything that cannot answer the containment question is treated as having
  // moved the page — `window` is the one that reaches here, and a scroll of the
  // window moves everything laid out in it. `document` answers for itself.
  if (!isEnclosing(scrolled)) return true;
  return scrolled.contains(anchor);
}

function isEnclosing(value: unknown): value is Enclosing {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Enclosing).contains === 'function'
  );
}
