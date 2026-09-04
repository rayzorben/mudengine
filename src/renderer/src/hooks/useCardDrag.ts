import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { insertionIndex } from '../lib/reorder';
import type { CardId, CardLayoutApi, Lane } from './useCardLayout';
import { tuning } from '../lib/tuning';

/**
 * Where a card would land if the pointer were released now.
 *
 * A docked target carries its lane and the insertion index, so the indicator
 * can be drawn *between* two cards rather than on one of them: a drop that
 * lands somewhere the player was not shown is a drop they have to undo.
 */
export type DropTarget = { where: 'lane'; lane: Lane; index: number } | { where: 'float' };

export interface DragState {
  id: CardId;
  /** Where the pointer is, in client coordinates, for the ghost to follow. */
  x: number;
  y: number;
  target: DropTarget;
  /** True once the pointer has moved far enough that this is a drag, not a click. */
  live: boolean;
  /**
   * The shape of what was picked up — the card's own box, or a put-away
   * card's chip — so the ghost is that shape and the gap opened for it on a
   * lane is that size. Somebody dragging a card should feel the card move,
   * not a label.
   */
  shape: 'card' | 'chip';
  size: { w: number; h: number };
  /** Where inside that box the pointer took hold, so the ghost does not jump. */
  grab: { dx: number; dy: number };
}

export interface CardDrag {
  state: DragState | null;
  /**
   * Put on a card header. Starts a drag if the pointer travels far enough.
   *
   * `fromControl` is for a handle that *is* a button — a put-away card's chip
   * — where the press is otherwise refused as a click on a control inside the
   * header. The chip's click still fires if the pointer does not travel.
   */
  begin(id: CardId, event: React.PointerEvent, options?: { fromControl?: boolean }): void;
}

/** One lane's box and the midpoints of the cards in it. */
interface LaneShape {
  lane: Lane;
  box: DOMRect;
  /**
   * Card midpoints along the lane's own axis.
   *
   * The rail stacks, so its axis is vertical; the strips run left to right, so
   * theirs is horizontal. One number per card either way — which is what lets
   * the insertion index be computed the same way for all three.
   */
  vertical: boolean;
  slots: number[];
}

interface Origin {
  id: CardId;
  x: number;
  y: number;
  /** Offset from the pointer to the float's own corner, so it does not jump. */
  grab: { dx: number; dy: number } | null;
  floating: boolean;
  shape: DragState['shape'];
  size: DragState['size'];
  /** Where inside the grabbed box the pointer took hold. */
  hold: DragState['grab'];
}

/**
 * Dragging a card from one place on the instrument to another.
 *
 * One machine for both directions, because they are the same gesture: a card is
 * picked up, the pointer says where it would go, and releasing puts it there.
 * Splitting it into "reorder" and "pop out" would mean two sets of hit-testing
 * that have to agree about where the rail ends, and they would stop agreeing.
 *
 * The drop target is computed continuously and shown continuously — the rail
 * opens a gap the card's size, a float follows the pointer — so releasing never
 * does something the player was not already looking at.
 */
export function useCardDrag(
  layout: CardLayoutApi,
  workspaceRef: React.RefObject<HTMLElement>
): CardDrag {
  const [state, setState] = useState<DragState | null>(null);
  const origin = useRef<Origin | null>(null);
  // Read by the pointerup listener, which is registered once and must not close
  // over a stale target.
  const latest = useRef<DragState | null>(null);
  latest.current = state;

  /**
   * Every lane on screen, measured now.
   *
   * Re-measured per move rather than cached at pointerdown, because the lanes
   * genuinely move during a drag: the docked strips appear as empty drop zones
   * the moment one starts, so a set measured before that would not include the
   * two places a card most needs to be droppable into. A handful of rects at
   * pointer rate is cheap; a drop target that cannot be reached is not.
   */
  const measure = useCallback((): LaneShape[] => {
    const lanes: LaneShape[] = [];
    for (const [selector, lane, vertical] of [
      ['.rail', 'rail', true],
      ['.dock-above', 'above', false],
      ['.dock-below', 'below', false]
    ] as const) {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) continue;
      lanes.push({
        lane,
        vertical,
        box: element.getBoundingClientRect(),
        slots: Array.from(element.querySelectorAll<HTMLElement>('[data-card]')).map((card) => {
          const box = card.getBoundingClientRect();
          return vertical ? box.top + box.height / 2 : box.left + box.width / 2;
        })
      });
    }
    return lanes;
  }, []);

  /** Which lane and index the pointer is over, or a float if it is over none. */
  const targetFor = useCallback(
    (x: number, y: number): DropTarget => {
      const at = origin.current;
      if (!at) return { where: 'float' };
      /*
       * The strips first.
       *
       * They overlay the console's edges while a drag is running, so where they
       * overlap the rail's box the nearer intent is the strip: somebody holding a
       * card over the foot of the console means the foot of the console.
       */
      for (const lane of measure()) {
        const { box } = lane;
        if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
        // Between the two cards whose midpoints straddle the pointer. The same
        // rule the tab rail drags by, stated once in `lib/reorder.ts`: two
        // copies of it drift into an indicator that points at one gap while the
        // drop lands in another.
        const along = lane.vertical ? y : x;
        return { where: 'lane', lane: lane.lane, index: insertionIndex(lane.slots, along) };
      }
      return { where: 'float' };
    },
    [measure]
  );

  const begin = useCallback(
    (id: CardId, event: React.PointerEvent, options?: { fromControl?: boolean }) => {
      // Only the primary button, and never from a control inside the header:
      // the close button and the face crumbs are things you click.
      if (event.button !== 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!options?.fromControl && target?.closest('button, input, a')) return;

      const existing = layout.floatOf(id);
      const workspace = workspaceRef.current?.getBoundingClientRect() ?? null;
      /*
       * The box that was picked up, measured now: the card behind a header,
       * or the chip itself. Its size is what the ghost and the gap take, and
       * where in it the pointer landed is what keeps the ghost from jumping.
       */
      const handle = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
      const card = handle?.closest<HTMLElement>('[data-card]') ?? null;
      const box = (card ?? handle)?.getBoundingClientRect() ?? null;
      const shape: DragState['shape'] = card ? 'card' : 'chip';
      const size = box ? { w: box.width, h: box.height } : { w: 0, h: 0 };
      const hold = box
        ? { dx: event.clientX - box.left, dy: event.clientY - box.top }
        : { dx: 0, dy: 0 };
      origin.current = {
        id,
        x: event.clientX,
        y: event.clientY,
        // A float is dragged by the point it was grabbed at, not by its corner,
        // so it does not leap under the hand on the first pixel of movement.
        grab:
          existing && workspace
            ? {
                dx: event.clientX - (workspace.left + existing.x * workspace.width),
                dy: event.clientY - (workspace.top + existing.y * workspace.height)
              }
            : null,
        floating: existing !== undefined,
        shape,
        size,
        hold
      };

      setState({
        id,
        x: event.clientX,
        y: event.clientY,
        target: existing ? { where: 'float' } : { where: 'lane', lane: 'rail', index: 0 },
        live: false,
        shape,
        size,
        grab: hold
      });
      // Refuses the mouse's attempt to park the caret, exactly as `keepFocus`
      // does: a card is read, never typed into.
      event.preventDefault();
    },
    [layout, workspaceRef]
  );

  const dragging = state !== null;

  useEffect(() => {
    if (!dragging) return;

    const move = (event: PointerEvent): void => {
      const at = origin.current;
      if (!at) return;
      const far =
        Math.abs(event.clientX - at.x) > tuning().dragSlop ||
        Math.abs(event.clientY - at.y) > tuning().dragSlop;
      const live = far || (latest.current?.live ?? false);
      const target = targetFor(event.clientX, event.clientY);

      // A card already floating follows the pointer as it is dragged; one being
      // lifted off the rail is represented by a ghost until it is dropped.
      if (live && at.floating && target.where === 'float') {
        const workspace = workspaceRef.current?.getBoundingClientRect();
        if (workspace && workspace.width > 0 && workspace.height > 0) {
          const grab = at.grab ?? { dx: 0, dy: 0 };
          layout.moveFloat(at.id, {
            x: (event.clientX - grab.dx - workspace.left) / workspace.width,
            y: (event.clientY - grab.dy - workspace.top) / workspace.height
          });
        }
      }

      setState({
        id: at.id,
        x: event.clientX,
        y: event.clientY,
        target,
        live,
        shape: at.shape,
        size: at.size,
        grab: at.hold
      });
    };

    const finish = (event: PointerEvent): void => {
      const at = origin.current;
      const dragged = latest.current;
      origin.current = null;
      setState(null);
      if (!at || !dragged?.live) return;

      if (dragged.target.where === 'lane') {
        layout.dock(at.id, dragged.target.lane, dragged.target.index);
        return;
      }
      // Already floating and released over the console: it has been following
      // the pointer the whole way, so there is nothing left to commit.
      if (at.floating) return;

      const workspace = workspaceRef.current?.getBoundingClientRect();
      if (!workspace || workspace.width === 0 || workspace.height === 0) return;
      layout.lift(at.id, {
        x: (event.clientX - workspace.left) / workspace.width,
        y: (event.clientY - workspace.top) / workspace.height
      });
    };

    const cancel = (): void => {
      origin.current = null;
      setState(null);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
    };
    // Keyed on whether a drag is running rather than on the drag itself: the
    // listeners read the live pointer position through refs, so re-registering
    // them on every move would be churn for nothing.
  }, [dragging, layout, targetFor, workspaceRef]);

  // One object for as long as neither half moves: `renderCard` lists this as a
  // dependency, and a fresh object per render rebuilt every card's element on
  // every commit of the window, drag or no drag.
  return useMemo(() => ({ state, begin }), [state, begin]);
}
