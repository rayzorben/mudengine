/**
 * The reader's place in a scrolled list whose rows come and go above it: the
 * first row in view and how far below the box's top edge it sits. Read in a
 * scroll handler or a layout effect, never during a render. A row is a direct
 * child carrying `data-line`.
 */
export interface ScrollPlace {
  key: string;
  /** The row's top less the box's, in pixels; negative for a row cut by the edge. */
  top: number;
}

/** The first row whose foot is below the box's top edge. Rows are in document order, top to bottom. */
export function placeOf(box: HTMLElement): ScrollPlace | null {
  const edge = box.getBoundingClientRect().top;
  const rows = box.children;
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (rows[mid]!.getBoundingClientRect().bottom <= edge) low = mid + 1;
    else high = mid;
  }
  for (let index = low; index < rows.length; index += 1) {
    const row = rows[index] as HTMLElement;
    const key = row.dataset['line'];
    if (key !== undefined) return { key, top: row.getBoundingClientRect().top - edge };
  }
  return null;
}

/**
 * Scrolls the box so the row sits where it did. True when the box moved; false
 * when the row is gone or already there.
 */
export function putBack(box: HTMLElement, place: ScrollPlace | null): boolean {
  if (place === null) return false;
  const edge = box.getBoundingClientRect().top;
  for (const row of box.children) {
    if ((row as HTMLElement).dataset['line'] !== place.key) continue;
    const drift = row.getBoundingClientRect().top - edge - place.top;
    if (Math.abs(drift) < 1) return false;
    box.scrollTop += drift;
    return true;
  }
  return false;
}
