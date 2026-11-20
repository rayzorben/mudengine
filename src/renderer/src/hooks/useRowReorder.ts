import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { moved, rowUnderDrag } from '../lib/reorder';

/** What a row's grip is given: the drag, and the arrow keys for the same move. */
export interface RowGripHandlers {
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void;
  onPointerDown(event: PointerEvent<HTMLButtonElement>): void;
  onPointerMove(event: PointerEvent<HTMLButtonElement>): void;
  onLostPointerCapture(event: PointerEvent<HTMLButtonElement>): void;
}

/** The attribute a grip wears, so the grip at a place can be given the focus. */
export const REORDER_GRIP = 'data-reorder-grip';
const REORDER_LIST = 'data-reorder-list';
const REORDER_ROW = 'data-reorder-row';

export interface RowReorder {
  /** Spread on the element holding the rows. */
  listProps: { [REORDER_LIST]: '' };
  /** Spread on each row: what it is measured by, and whether it is being dragged. */
  rowProps(index: number): { [REORDER_ROW]: ''; 'data-dragging': '' | undefined };
  grip(index: number): RowGripHandlers;
}

/**
 * Reordering a settings list by its rows' grips: drag one, or focus it and
 * press the up and down arrows.
 *
 * The row moves as the pointer passes each neighbour, so what is on screen is
 * always the order that will be saved. The rows are keyed by place, so the
 * grip that holds the pointer stays mounted while the rows change under it,
 * and the place being dragged is kept here.
 */
export function useRowReorder<T>(rows: readonly T[], onChange: (rows: T[]) => void): RowReorder {
  const from = useRef<number | null>(null);
  /* The list a move was made from. A second pointer event can arrive before
     the form draws the move, and would be measured against the old rows. */
  const sent = useRef<readonly T[] | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  const move = (at: number, to: number): boolean => {
    const next = moved(rows, at, to);
    if (next === rows) return false;
    sent.current = rows;
    onChange([...next]);
    return true;
  };

  /** The grip at a place takes the focus, so the keys act on the row that moved. */
  const focusGrip = (within: Element, place: number): void => {
    within
      .closest(`[${REORDER_LIST}]`)
      ?.querySelectorAll<HTMLElement>(`[${REORDER_GRIP}]`)
      [place]?.focus();
  };

  const grip = (index: number): RowGripHandlers => ({
    onKeyDown(event) {
      const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      if (move(index, index + delta)) focusGrip(event.currentTarget, index + delta);
    },
    onPointerDown(event) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      from.current = index;
      sent.current = null;
      setDragging(index);
    },
    onPointerMove(event) {
      const at = from.current;
      if (at === null || sent.current === rows) return;
      const list = event.currentTarget.closest(`[${REORDER_LIST}]`);
      if (!list) return;
      const extents = [...list.querySelectorAll(`[${REORDER_ROW}]`)].map((row) => {
        const box = row.getBoundingClientRect();
        return { start: box.top, end: box.bottom };
      });
      // A marked element that is not one of these rows would put every place out.
      if (extents.length !== rows.length) return;
      const to = rowUnderDrag(extents, at, event.clientY);
      if (!move(at, to)) return;
      from.current = to;
      setDragging(to);
    },
    onLostPointerCapture(event) {
      if (from.current !== null) focusGrip(event.currentTarget, from.current);
      from.current = null;
      setDragging(null);
    }
  });

  return {
    listProps: { [REORDER_LIST]: '' },
    rowProps: (index) => ({
      [REORDER_ROW]: '',
      'data-dragging': dragging === index ? '' : undefined
    }),
    grip
  };
}
