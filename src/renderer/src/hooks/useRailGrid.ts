/**
 * The card rail's grid (todo 09): how many cells across it is and how many
 * show at once, measured under a `ResizeObserver`, and the arrangement the
 * rail last drew, which the drag and the corner grip read through
 * `RailGridView` when a gesture needs it. See `mudengine-ui` ›
 * `parts/cards.md`, *The card rail is a grid*.
 */
import { useCallback, useMemo, useRef, useState } from 'react';

import type { CardId, RailGridView } from '../lib/cards';
import type { GridBox } from '../lib/railGrid';

export interface RailGrid {
  /** Put on the grid element. */
  ref(element: HTMLElement | null): void;
  /** Cells across, null before the grid is laid out. */
  columns: number | null;
  /** Rows of cells the rail shows at once. */
  showing: number;
  /** The rail hands over what it drew, after each commit. */
  publish(drawn: ReadonlyMap<CardId, GridBox>): void;
  view: RailGridView;
}

const NOTHING: ReadonlyMap<CardId, GridBox> = new Map();

/** A grid cell in px, from the token the stylesheet holds; 0 where it is not set. */
export function gridCell(element: Element): number {
  return parseFloat(getComputedStyle(element).getPropertyValue('--grid-cell')) || 0;
}

export function useRailGrid(): RailGrid {
  const [columns, setColumns] = useState<number | null>(null);
  const [showing, setShowing] = useState(0);
  const element = useRef<HTMLElement | null>(null);
  const drawn = useRef<ReadonlyMap<CardId, GridBox>>(NOTHING);
  const observer = useRef<ResizeObserver | null>(null);

  const measure = useCallback(() => {
    const grid = element.current;
    if (!grid) return;
    const cell = gridCell(grid);
    if (cell <= 0) return;
    setColumns(Math.max(1, Math.floor(grid.clientWidth / cell)));
    setShowing(Math.floor((grid.parentElement?.clientHeight ?? 0) / cell));
  }, []);

  /*
   * A callback ref, because the rail mounts and unmounts with the HUD: the
   * observer follows the element rather than an effect that ran once.
   */
  const ref = useCallback(
    (next: HTMLElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      element.current = next;
      if (!next) {
        drawn.current = NOTHING;
        return;
      }
      measure();
      if (typeof ResizeObserver === 'undefined') return;
      const watching = new ResizeObserver(measure);
      watching.observe(next);
      if (next.parentElement) watching.observe(next.parentElement);
      observer.current = watching;
    },
    [measure]
  );

  const publish = useCallback((next: ReadonlyMap<CardId, GridBox>) => {
    drawn.current = next;
  }, []);

  const view = useMemo<RailGridView>(
    () => ({
      frame: () => {
        const grid = element.current;
        if (!grid) return null;
        const cell = gridCell(grid);
        if (cell <= 0) return null;
        const { left, top } = grid.getBoundingClientRect();
        return { left, top, cell, columns: Math.max(1, Math.floor(grid.clientWidth / cell)) };
      },
      drawn: () => drawn.current,
      scroller: () => element.current?.parentElement ?? null
    }),
    []
  );

  return useMemo(
    () => ({ ref, columns, showing, publish, view }),
    [ref, columns, showing, publish, view]
  );
}
