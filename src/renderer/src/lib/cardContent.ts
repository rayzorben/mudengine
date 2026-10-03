/**
 * How tall a card's content is at the width and size it is drawn (todo 01),
 * for auto layout. A rail card is a fixed box whose body scrolls, so the
 * content is read off each scroll region inside it: how far it runs past the
 * region, or how far short of it it stops. A region whose content stretches
 * to fill it (the map) needs exactly the box it has.
 */

function scrolls(element: HTMLElement): boolean {
  const { overflowY } = getComputedStyle(element);
  return overflowY === 'auto' || overflowY === 'scroll';
}

/**
 * The outermost scroll regions in a card. Not inside one: what a region
 * holds is in its own measure, and an SVG's insides are drawing, not layout.
 */
function regions(card: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (parent: Element): void => {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement)) continue;
      if (scrolls(child)) out.push(child);
      else walk(child);
    }
  };
  walk(card);
  return out;
}

/** How many px a region's content runs past it (positive) or stops short of it (negative). */
function shortfall(region: HTMLElement): number {
  if (region.scrollHeight > region.clientHeight + 1)
    return region.scrollHeight - region.clientHeight;
  const range = document.createRange();
  range.selectNodeContents(region);
  const content = range.getBoundingClientRect();
  const style = getComputedStyle(region);
  const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const inner = region.getBoundingClientRect().top + region.clientTop;
  const extent =
    content.height === 0 && content.width === 0
      ? padding
      : content.bottom - inner + region.scrollTop + parseFloat(style.paddingBottom);
  return Math.min(0, extent - region.clientHeight);
}

/** The height in px the card would take to draw everything it draws now without scrolling. */
export function contentHeight(card: HTMLElement): number {
  const delta = regions(card).reduce((sum, region) => sum + shortfall(region), 0);
  return card.getBoundingClientRect().height + delta;
}
