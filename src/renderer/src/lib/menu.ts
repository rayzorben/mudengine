import { tuning } from './tuning';

/** A rectangle, as `getBoundingClientRect` gives one. */
export interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Which edge of the anchor the menu lines up with.
 *
 * `end` is the kebab's: the button is at the right of the thing it belongs to,
 * so its menu hangs back to the left of it. `start` is a right-click's: the
 * anchor is the pointer itself, which has no width to hang off, and a menu
 * that opened to the *left* of the pointer would read as belonging to whatever
 * it covered rather than to the spot that was clicked.
 */
export type MenuAlign = 'start' | 'end';

/**
 * Where a popup menu goes, given what it hangs off and how big it is.
 *
 * Below the anchor and right-aligned to it, which is where a kebab's menu is
 * expected — the button is at the right edge of the thing it belongs to, and a
 * left-aligned menu would hang off the window on a rail that is already at the
 * right of nothing.
 *
 * Then clamped into the window on both axes. That is the whole reason this is a
 * function rather than two additions: the tab whose menu is most likely to
 * open past the bottom edge is the *last* one, which on a full rail is the one
 * somebody is most likely to be reaching for, and a menu that opens off screen
 * reads as a button that does nothing.
 *
 * The clamp puts the near edge first, so a menu larger than the window is
 * pinned to the top-left and loses its far edge rather than its near one:
 * losing the first entry is losing the one the caret is on.
 */
export function menuPosition(
  anchor: Box,
  menu: Size,
  viewport: Size,
  align: MenuAlign = 'end'
): { top: number; left: number } {
  const wanted = align === 'end' ? anchor.right - menu.width : anchor.left;
  // Read once, so both axes are clamped against the same margin.
  const margin = tuning().menuMargin;
  return {
    top: Math.max(margin, Math.min(anchor.bottom + margin, viewport.height - menu.height - margin)),
    left: Math.max(margin, Math.min(wanted, viewport.width - menu.width - margin))
  };
}
