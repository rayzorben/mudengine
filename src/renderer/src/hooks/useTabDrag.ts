import { useCallback, useEffect, useRef, useState } from 'react';

import { insertionIndex, reordered } from '../lib/reorder';
import type { SessionId } from '@shared/ipc';
import { tuning } from '../lib/tuning';

/**
 * Dragging a character's tab into the order somebody wants it in.
 *
 * A separate machine from `useCardDrag`, and deliberately: that one exists
 * because reordering a card and lifting it onto the console are **one gesture**
 * with two outcomes, and splitting them would mean two hit-tests that have to
 * agree about where the rail ends. This gesture has exactly one outcome. A tab
 * dragged out of the rail does not become a floating tab — popping a character
 * into its own window is a menu entry, because it moves a *window's ownership*
 * of a session and is not something to do by releasing a pointer a little too
 * far to the left.
 *
 * What the two do share is the arithmetic, and that is in `lib/reorder.ts`
 * rather than in either of them.
 *
 * **The rail runs both ways.** `top` lays the tabs out horizontally and `left`
 * stacks them, so the axis is read from the boxes themselves rather than from
 * the side: whichever way the tabs are further apart is the way they are laid
 * out. Reading it from the side prop would be a second statement of a fact the
 * layout already makes, and the two would disagree the first time a rail
 * wrapped.
 */
export interface TabDrag {
  /** The tab being dragged, once the pointer has travelled far enough. */
  session: SessionId | null;
  /** The gap the indicator is drawn in, or null when nothing is being dragged. */
  index: number | null;
  /**
   * Where the ghost goes and what shape it is: the pointer, the tab's own box
   * as it was picked up, and where in that box the pointer took hold. Null
   * until the pointer has travelled far enough to be a drag.
   */
  ghost: { x: number; y: number; w: number; h: number } | null;
  /** Put on the grip and on a side rail's circle. Starts a drag if the pointer travels far enough. */
  begin(session: SessionId, event: React.PointerEvent): void;
}

interface Origin {
  session: SessionId;
  x: number;
  y: number;
  /** The tab's box when it was picked up, and where in it the pointer landed. */
  size: { w: number; h: number };
  hold: { dx: number; dy: number };
}

/**
 * Takes the click Chromium sends after a drag's release, before it reaches the tab.
 *
 * A tab's circle is a handle and the tab selects on a click, so a circle
 * dropped back on its own tab would otherwise show that character. The click
 * can come a task after the pointerup (27ms later under the smoke, 2026-11-18),
 * so no timer bounds the wait. After a release that sends none (outside the
 * window) the listener would take the next real click, so the next press or key
 * takes it off.
 */
function swallowClick(): void {
  const off = (): void => {
    window.removeEventListener('click', swallow, true);
    window.removeEventListener('pointerdown', off, true);
    window.removeEventListener('keydown', off, true);
  };
  const swallow = (event: MouseEvent): void => {
    event.stopPropagation();
    off();
  };
  window.addEventListener('click', swallow, true);
  window.addEventListener('pointerdown', off, true);
  window.addEventListener('keydown', off, true);
}

export function useTabDrag(
  order: readonly SessionId[],
  onReorder: (order: SessionId[]) => void
): TabDrag {
  const [session, setSession] = useState<SessionId | null>(null);
  const [index, setIndex] = useState<number | null>(null);
  const [ghost, setGhost] = useState<TabDrag['ghost']>(null);
  const origin = useRef<Origin | null>(null);
  /*
   * Read by the pointerup listener, which is registered once per gesture and
   * must not close over a stale gap — and by `move`, which needs to know
   * whether the slop has already been broken.
   */
  const latest = useRef<{ live: boolean; index: number | null }>({ live: false, index: null });
  // The list as it is drawn now, so a roster republished mid-drag is what the
  // drop is committed against rather than the one measured at pointerdown.
  const current = useRef<readonly SessionId[]>(order);
  current.current = order;
  // The same for the callback, so `begin` keeps one identity.
  const commit = useRef(onReorder);
  commit.current = onReorder;
  /** Takes the running gesture's listeners off the window; null between gestures. */
  const stop = useRef<(() => void) | null>(null);

  /**
   * The midpoint of every tab, along whichever axis they are laid out on.
   *
   * Measured per move rather than cached at pointerdown, the rule the card
   * drag already keeps: the rail scrolls, and a set of boxes measured before a
   * scroll points at gaps that have moved.
   */
  const measure = useCallback((): { slots: number[]; vertical: boolean } => {
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('.tab-rail [data-session]'));
    const boxes = tabs.map((tab) => tab.getBoundingClientRect());
    const first = boxes[0];
    const last = boxes[boxes.length - 1];
    // One tab is neither horizontal nor vertical and cannot be reordered
    // anyway; the axis it reports does not matter.
    const vertical =
      first && last ? Math.abs(last.top - first.top) >= Math.abs(last.left - first.left) : true;
    return {
      vertical,
      slots: boxes.map((box) => (vertical ? box.top + box.height / 2 : box.left + box.width / 2))
    };
  }, []);

  const begin = useCallback(
    (id: SessionId, event: React.PointerEvent) => {
      // Only the primary button. A right-click on the grip is a context menu.
      if (event.button !== 0) return;
      // One gesture at a time: a second finger or a pen down mid-drag would
      // drop the tab in hand without committing it.
      if (stop.current !== null) return;
      // The tab behind the grip, measured now: the ghost is that shape and the
      // gap opened for it is that size, so the tab is felt to move rather than
      // a line to appear.
      const tab =
        event.currentTarget instanceof HTMLElement
          ? event.currentTarget.closest<HTMLElement>('[data-session]')
          : null;
      const box = tab?.getBoundingClientRect() ?? null;
      origin.current = {
        session: id,
        x: event.clientX,
        y: event.clientY,
        size: box ? { w: box.width, h: box.height } : { w: 0, h: 0 },
        hold: box ? { dx: event.clientX - box.left, dy: event.clientY - box.top } : { dx: 0, dy: 0 }
      };
      latest.current = { live: false, index: null };
      /*
       * Refuses the mouse's attempt to park the caret, exactly as `keepFocus`
       * does everywhere else in the rail: the grip is dragged, never typed into,
       * and a swallowed keystroke can cost a character.
       */
      event.preventDefault();

      /*
       * The gesture's listeners go on with the press and nothing is published
       * until it travels: a circle is pressed to select a character, and a press
       * that set state drew the tab as dragged for as long as the button was down.
       */
      const move = (event: PointerEvent): void => {
        const at = origin.current;
        if (!at) return;
        // A release the window never heard (focus lost mid-press) leaves the
        // button up and the gesture on; it ends here, committing nothing.
        if ((event.buttons & 1) === 0) {
          cancel();
          return;
        }
        const far =
          Math.abs(event.clientX - at.x) > tuning().dragSlop ||
          Math.abs(event.clientY - at.y) > tuning().dragSlop;
        if (!far && !latest.current.live) return;

        const { slots, vertical } = measure();
        const gap = insertionIndex(slots, vertical ? event.clientY : event.clientX);
        latest.current = { live: true, index: gap };
        setSession(at.session);
        setIndex(gap);
        setGhost({
          x: event.clientX - at.hold.dx,
          y: event.clientY - at.hold.dy,
          w: at.size.w,
          h: at.size.h
        });
      };

      const finish = (): void => {
        stop.current?.();
        const at = origin.current;
        const { live, index: gap } = latest.current;
        origin.current = null;
        latest.current = { live: false, index: null };
        setSession(null);
        setIndex(null);
        setGhost(null);
        // A press that never travelled is a click on the grip, and a click on the
        // grip is not a request to reorder anything.
        if (!at || !live || gap === null) return;
        swallowClick();
        /*
         * The caller is handed the *new order*, not a move: main writes down a
         * list, and deriving the list from a move in two places is two chances
         * to disagree about where a tab landed.
         *
         * `reordered` returns the same reference when nothing changed, which is
         * how a tab dropped back where it started sends nothing at all — a drop
         * that renumbered the rail into the order it was already in would still
         * be a file written and a roster republished.
         */
        const next = reordered(current.current, at.session, gap);
        if (next === current.current) return;
        commit.current([...next]);
      };

      const cancel = (): void => {
        stop.current?.();
        origin.current = null;
        latest.current = { live: false, index: null };
        setSession(null);
        setIndex(null);
        setGhost(null);
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', cancel);
      stop.current = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', cancel);
        stop.current = null;
      };
    },
    [measure]
  );

  // A rail taken down mid-press leaves no listener on the window.
  useEffect(() => () => stop.current?.(), []);

  return { session, index, ghost, begin };
}
