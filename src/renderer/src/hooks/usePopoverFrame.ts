import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, Ref } from 'react';

import {
  anchorNode,
  anchorRect,
  clampPanel,
  placePopover,
  popoverWidth,
  scrollMovesAnchor,
  type PopoverAnchor,
  type PopoverSide
} from '../lib/popover';
import { tuning } from '../lib/tuning';

/** What a panel is doing to itself while a pointer is on one of its grips. */
type Gesture =
  | { kind: 'move'; fromX: number; fromY: number; top: number; left: number }
  | { kind: 'size'; fromX: number; fromY: number; width: number; height: number };

export interface PopoverFrameOptions {
  /** The name, row or console word this panel hangs off. */
  anchor: PopoverAnchor;
  /** Put the panel away. */
  onDismiss(): void;
  /**
   * What Escape does, where that is more than dismissing.
   *
   * The Gang panel hands the caret back to the game on Escape and does not on
   * a click-away, because a click has already put it somewhere. Defaults to
   * `onDismiss`.
   */
  onEscape?: () => void;
  /**
   * Re-place the panel when any of these change.
   *
   * An answer is taller than "looking…", a face with a warning under it is
   * taller than one without, and a member arriving adds a row — so the panel
   * is measured again and re-placed rather than left half off the bottom.
   */
  measure: readonly unknown[];
  /**
   * A portal outside the panel owns Escape while it is open.
   *
   * The copy menu, which is a `PopupMenu` in its own portal: Escape there means
   * the menu, and handling it here as well would put the panel away underneath
   * it in one press.
   */
  menuOpen?: boolean;
  /**
   * What to do when the element the panel hangs off leaves the document.
   *
   * `dismiss` for a panel hanging off a *row* — the listing was replaced and
   * that person is no longer in it, so the panel is beside nothing. `hold` for
   * one hanging off a name in a card that redraws constantly: a card redrawing
   * is not a reason for a panel to go, and the Reference panel's anchor is
   * often a rectangle in the console with no element to disconnect at all.
   */
  whenAnchorGone?: 'dismiss' | 'hold';
}

export interface PopoverFrame {
  /** Spread onto the panel: the geometry, and what it is currently doing. */
  props: {
    /*
     * `Ref`, not the `RefObject` the hook holds: this is spread onto a `<div>`,
     * and the element's own prop type is what has to be satisfied. Typing it as
     * the object makes the spread fail to compile against every intrinsic
     * element.
     */
    ref: Ref<HTMLDivElement>;
    style: CSSProperties;
    'data-side': PopoverSide;
    'data-pinned'?: 'true';
    'data-sized'?: 'true';
    'data-moving'?: 'true';
  };
  /** Whether a click outside still puts the panel away. */
  pinned: boolean;
  togglePin(): void;
  /** On the panel's grip: press and the panel follows the pointer. */
  onGrab(event: ReactPointerEvent<HTMLElement>): void;
  /** On the panel's corner: press and the panel takes the pointer's size. */
  onSize(event: ReactPointerEvent<HTMLElement>): void;
  /**
   * Back to the size it was fitted to the name at — the width chosen from the
   * room beside the anchor, and the height cap. A card's corner grip resets
   * the same way, and for the same reason: a panel dragged to something
   * unreadable needs a way back that is not "close it and click again".
   */
  onSizeReset(): void;
}

const viewportNow = () => ({ width: window.innerWidth, height: window.innerHeight });

/**
 * Everything a slide-out panel does that is not about what it says.
 *
 * The Reference popover, the Player flyout and the Gang flyout each had their
 * own copy of the placement, the measure-then-place pass and the four
 * dismissal listeners — three copies that had already drifted in two places by
 * the time this was written. They are one panel drawing three things, so the
 * plumbing is one hook and only the contents differ.
 *
 * What it adds beyond what those three had (2026-09-05, todo 03):
 *
 * - **A width chosen from the room beside the anchor**, not a flat 300px. See
 *   `popoverWidth`: a panel too narrow to hold a sentence turns it into a
 *   column one word wide, and since the panel caps its own height it then
 *   scrolls the answer below the fold.
 * - **Moving**, by the grip in the heading. The grip and not the whole heading,
 *   for the reason a tab's grip is its own element: a heading here carries the
 *   face pills and a close button, and a press anywhere on it that turned into
 *   a drag would make choosing a face a gamble on how still somebody's hand is.
 * - **Pinning.** A pinned panel stops being about where its anchor is — a click
 *   away, a scroll that moved the anchor and a window resize all stop
 *   dismissing it, and it is clamped back into the window instead. Escape and
 *   the close glyph still put it away, because a panel that cannot be
 *   dismissed at all is worse than one that closes too eagerly.
 * - **Resizing**, from the corner, with a floor from `internal.yaml`.
 *
 * The geometry is plain pixels and is deliberately not remembered. A float
 * card stores fractions of the workspace because it is *persisted* and a
 * fraction is what survives a different monitor; this dies with the click that
 * opened it, so there is nothing for a fraction to protect against — and a
 * remembered position would put the next panel somewhere the name that opened
 * it is not.
 */
export function usePopoverFrame({
  anchor,
  onDismiss,
  onEscape,
  measure,
  menuOpen = false,
  whenAnchorGone = 'dismiss'
}: PopoverFrameOptions): PopoverFrame {
  const ref = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ top: number; left: number; side: PopoverSide } | null>(
    null
  );
  const [width, setWidth] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);
  /** Where a drag put it. Once set, the panel is no longer placed by anchor. */
  const [moved, setMoved] = useState<{ top: number; left: number } | null>(null);
  /** What a resize made it. Once set, it overrides the width and the cap. */
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const [moving, setMoving] = useState(false);

  /*
   * Measured before paint from the panel's own size, then placed — the first
   * pass renders it hidden so this is a measurement rather than a guess, the
   * same way `PopupMenu` does.
   *
   * Two passes on purpose. The width has to be on the element *before* the
   * height is read, or the height measured is the one the old width produced
   * and the panel is placed against a box it does not have. Setting it and
   * returning costs one more hidden render and avoids writing to the DOM node
   * behind React's back — which is the alternative, and the one that fights
   * the style prop the next time anything re-renders.
   */
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;
    // A panel somebody has dragged is where they put it. Re-placing it would
    // move it out from under the pointer the moment its contents changed.
    if (moved !== null) return;

    const within = anchorNode(anchor);
    const gone =
      within !== null && 'isConnected' in within && !(within as unknown as Node).isConnected;
    // A pinned panel has stopped being about its anchor, so the anchor going
    // is not news to it.
    if (gone && !pinned) {
      if (whenAnchorGone === 'dismiss') onDismiss();
      return;
    }

    const rect = anchorRect(anchor);
    const viewport = viewportNow();
    if (size === null) {
      const { popoverWidthMin, popoverWidthMax } = tuning();
      const want = popoverWidth(rect, viewport, { min: popoverWidthMin, max: popoverWidthMax });
      if (want !== width) {
        setWidth(want);
        return;
      }
    }

    const panel = node.getBoundingClientRect();
    setPlaced(placePopover(rect, { width: panel.width, height: panel.height }, viewport));
    /*
     * `measure` is the caller's own list of what makes the panel a different
     * size, spread in. Its **length must not change between renders** — React
     * compares dependency lists position by position — which is why it is
     * documented as a fixed list of values rather than accepted as "anything
     * that changed".
     */
  }, [anchor, moved, onDismiss, pinned, size, whenAnchorGone, width, ...measure]);

  useEffect(() => {
    const away = (event: PointerEvent): void => {
      // A pinned panel is dismissed by Escape and by its own close glyph, and
      // by nothing else. That is the whole of what pinning means.
      if (pinned) return;
      const target = event.target as Node | null;
      if (target && ref.current?.contains(target)) return;
      if (!(target instanceof Element)) {
        onDismiss();
        return;
      }
      /*
       * The copy menu is a portal outside the panel, and choosing an entry in
       * it must not put the panel away. A *containment* test, not "is the menu
       * open": with the flag alone, a click on the console made to put the
       * menu away closed the menu and left the panel stranded, so the player
       * clicked twice for one dismissal.
       */
      if (target.closest('.popup-menu') !== null) return;
      /*
       * A press on anything that *opens* a panel is left to its own click,
       * which replaces this one rather than toggling it. Without this the
       * press dismissed and the click re-opened, so choosing somebody on the
       * other listing unmounted the panel, flashed it at the origin for a
       * frame and slid it in again.
       */
      if (target.closest('[data-opens]') !== null) return;
      // The name this hangs off is what opened it; a second press there is the
      // opener's, which replaces rather than toggles.
      if (anchor instanceof HTMLElement && anchor.contains(target)) return;
      onDismiss();
    };
    /*
     * Capture, and the panel owns its own Escape: `useHotkeys` listens in
     * capture too and would otherwise hand a bare Escape to whatever else is
     * open — the diagnostics rail, say — leaving this panel over the game. The
     * terminal keeps focus throughout, so this cannot go through focus. While
     * the copy menu is open Escape belongs to it.
     */
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || menuOpen) return;
      event.preventDefault();
      event.stopPropagation();
      (onEscape ?? onDismiss)();
    };
    /*
     * A scroll closes the panel only when it moved the name it hangs off —
     * `scrollMovesAnchor` has the whole reason. Captured at the window, every
     * scroller in the client reports here, and the loudest of them is the
     * console: a pinned terminal scrolls to the bottom on each write, so
     * dismissing on any scroll took the realm's answer away the moment the
     * game printed anything.
     */
    const scrolled = (event: Event): void => {
      if (pinned) return;
      if (!scrollMovesAnchor(event.target, anchorNode(anchor))) return;
      onDismiss();
    };
    /*
     * A window resize moves the anchor, so an anchored panel goes rather than
     * chasing it. A pinned one has stopped being anchored — it is where
     * somebody put it — so it is kept inside the window instead, or a window
     * dragged narrower would leave it off screen with its own close glyph out
     * of reach.
     */
    const resized = (): void => {
      if (!pinned) {
        onDismiss();
        return;
      }
      const node = ref.current;
      if (node === null) return;
      const panel = node.getBoundingClientRect();
      setMoved((at) =>
        clampPanel(at ?? { top: panel.top, left: panel.left }, panel, viewportNow())
      );
    };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', resized);
    window.addEventListener('scroll', scrolled, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', resized);
      window.removeEventListener('scroll', scrolled, true);
    };
  }, [anchor, menuOpen, onDismiss, onEscape, pinned]);

  /*
   * Both gestures, in one pair of handlers on the window.
   *
   * Captured on the window rather than on the grip, because a pointer moving
   * faster than the panel follows leaves the grip behind — and the panel is in
   * a portal over the console, where the element under the pointer is the
   * game. `setPointerCapture` would do it too; a window listener also survives
   * the panel re-rendering under the pointer, which it does whenever the thing
   * it is about publishes anything.
   */
  useEffect(() => {
    if (!moving) return;
    const { popoverWidthMin, popoverMinHeight, popoverMargin } = tuning();
    const move = (event: PointerEvent): void => {
      const g = gesture.current;
      if (g === null) return;
      const dx = event.clientX - g.fromX;
      const dy = event.clientY - g.fromY;
      const node = ref.current;
      if (node === null) return;
      if (g.kind === 'move') {
        const panel = node.getBoundingClientRect();
        setMoved(clampPanel({ top: g.top + dy, left: g.left + dx }, panel, viewportNow()));
        return;
      }
      const viewport = viewportNow();
      const panel = node.getBoundingClientRect();
      setSize({
        width: Math.max(
          popoverWidthMin,
          Math.min(g.width + dx, viewport.width - panel.left - popoverMargin)
        ),
        height: Math.max(
          popoverMinHeight,
          Math.min(g.height + dy, viewport.height - panel.top - popoverMargin)
        )
      });
    };
    const end = (): void => {
      gesture.current = null;
      setMoving(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [moving]);

  const begin = useCallback((event: ReactPointerEvent<HTMLElement>, kind: Gesture['kind']) => {
    if (event.button !== 0) return;
    const node = ref.current;
    if (node === null) return;
    // A press on a grip is not a press on the panel's contents, and it must
    // not reach the click-away listener either.
    event.preventDefault();
    event.stopPropagation();
    const panel = node.getBoundingClientRect();
    gesture.current =
      kind === 'move'
        ? { kind, fromX: event.clientX, fromY: event.clientY, top: panel.top, left: panel.left }
        : {
            kind,
            fromX: event.clientX,
            fromY: event.clientY,
            width: panel.width,
            height: panel.height
          };
    /*
     * A panel taken hold of is one somebody means to keep. Moving or sizing it
     * is a deliberate arrangement, and having it vanish on the next click
     * anywhere would throw that arrangement away — the same reason a card
     * dragged off the rail is exempt from the group toggles.
     */
    setPinned(true);
    /*
     * **Both gestures fix the panel where it is**, not only the move.
     *
     * `size` is a dependency of the placement effect, so with `moved` left null
     * a resize re-placed the panel against its anchor on every pointer move —
     * and `placePopover` is not idempotent under a growing box. It clamps the
     * top up once the panel would run off the bottom, which lets the next
     * move's height ceiling grow, which moves the top again: the panel walks
     * upward while the pointer drags downward. A panel opened near the right
     * edge and dragged wider flips to the other side of its anchor mid-gesture
     * for the same reason.
     *
     * Fixing the top-left is also what a bottom-right corner grip *means*.
     */
    setMoved({ top: panel.top, left: panel.left });
    setMoving(true);
  }, []);

  const onGrab = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => begin(event, 'move'),
    [begin]
  );
  const onSize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => begin(event, 'size'),
    [begin]
  );

  const at = moved ?? placed;
  const style: CSSProperties = {
    top: at?.top ?? 0,
    left: at?.left ?? 0,
    ...(size !== null
      ? { width: size.width, height: size.height }
      : width !== null
        ? { width }
        : {}),
    // Hidden until it has been measured and placed, so the first paint is not
    // a panel at the top-left corner sliding across the window.
    visibility: at === null ? 'hidden' : 'visible'
  };

  return {
    props: {
      ref,
      style,
      'data-side': placed?.side ?? 'right',
      ...(pinned ? { 'data-pinned': 'true' as const } : {}),
      ...(size !== null ? { 'data-sized': 'true' as const } : {}),
      ...(moving ? { 'data-moving': 'true' as const } : {})
    },
    pinned,
    togglePin: useCallback(() => setPinned((on) => !on), []),
    onGrab,
    onSize,
    onSizeReset: useCallback(() => setSize(null), [])
  };
}
