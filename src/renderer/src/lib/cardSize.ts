/**
 * How big a card is, in the three sizes every card designs for (todo 06):
 * `small` draws what a glance needs, mostly as bars and marks; `medium` is the
 * card as it ships on the rail; `large` adds the detail a bigger box has room
 * for. A larger size never drops what a smaller one draws.
 *
 * Decided off the shorter side of the card's box against two lengths in
 * `tokens.css` (`--card-size-medium`, `--card-size-large`), read here so the
 * stylesheet holds the numbers once. See `mudengine-ui` › `parts/cards.md`.
 */

export const CARD_SIZES = ['small', 'medium', 'large'] as const;
export type CardSize = (typeof CARD_SIZES)[number];

/** The shorter side, in px, from which a card draws each larger size. */
export interface CardSizeBounds {
  medium: number;
  large: number;
}

/** The size a box of this width and height draws, or null when it has no box. */
export function cardSizeOf(
  box: { width: number; height: number },
  bounds: CardSizeBounds
): CardSize | null {
  const side = Math.min(box.width, box.height);
  if (!(side > 0)) return null;
  if (side >= bounds.large) return 'large';
  if (side >= bounds.medium) return 'medium';
  return 'small';
}

/** Whether something a card draws from `least` up is drawn at `size`. */
export function drawnAt(size: CardSize, least: CardSize): boolean {
  return CARD_SIZES.indexOf(size) >= CARD_SIZES.indexOf(least);
}

/**
 * The two lengths as the stylesheet resolved them for this card, or null while
 * either is unreadable (a headless render with no stylesheet): an unmeasured
 * card draws its medium design rather than a guessed one.
 */
export function cardSizeBounds(element: Element): CardSizeBounds | null {
  const style = getComputedStyle(element);
  const medium = parseFloat(style.getPropertyValue('--card-size-medium'));
  const large = parseFloat(style.getPropertyValue('--card-size-large'));
  return medium > 0 && large > medium ? { medium, large } : null;
}
