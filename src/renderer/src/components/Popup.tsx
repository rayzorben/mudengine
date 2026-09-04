import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { menuPosition, type MenuAlign } from '../lib/menu';
import { anchorNode, scrollMovesAnchor } from '../lib/popover';

/** Where a popup hangs off: a control, or the point a right-click landed on. */
export type MenuAnchor = HTMLElement | { x: number; y: number };

export interface PopupProps {
  at: MenuAnchor;
  onDismiss(): void;
  /**
   * `menu` for a list of actions, `dialog` for a small panel of controls.
   *
   * The two behave identically — that is the point of this component — and
   * differ only in what assistive technology is told they are. A grid of
   * colour swatches with a checkbox under it is not a menu, and calling it one
   * would make it unusable for anybody reading it through a screen reader.
   */
  role: 'menu' | 'dialog';
  /** Named for the dialog case, where there are no menu items to read out. */
  label?: string;
  className: string;
  children: ReactNode;
}

/** The anchor as a rectangle, plus which of its edges the popup lines up with. */
function anchorBox(at: MenuAnchor): {
  box: { top: number; right: number; bottom: number; left: number };
  align: MenuAlign;
} {
  if (at instanceof HTMLElement) {
    const rect = at.getBoundingClientRect();
    return { box: rect, align: 'end' };
  }
  // A point has no width to hang off, so the popup starts where the click did.
  return { box: { top: at.y, right: at.x, bottom: at.y, left: at.x }, align: 'start' };
}

/**
 * The shell every popup in this client comes out of: a tab's kebab, the
 * terminal's right-click, a card's settings panel.
 *
 * In a portal, positioned from its anchor's own rectangle, because **what it
 * belongs to may clip it**: `overflow` on the tab list cuts off anything
 * absolutely positioned inside a tab, and on a left rail that is every menu on
 * the last character — the one furthest down is exactly the one that would be
 * invisible. The terminal has the same problem for the same reason.
 *
 * A popup is driven by the arrow keys, so unlike most chrome it *takes* the
 * caret, and hands it straight back on any exit. That is the contract the
 * command palette honours (docs/ui-design.md §3.6); the difference from a card
 * tab or a map room is that those are clicked and never navigated.
 *
 * Anything that moves under it — a scroll, a resize — closes it rather than
 * being chased. A popup that follows a moving anchor is more code than one
 * that gets out of the way, and the gesture is over in a second either way.
 *
 * **It is a component and not a copied block** because everything above had
 * already been got wrong once each: the measure-then-clamp (a menu on the last
 * tab of a left rail opened off screen), the focus latch (focusing a
 * `visibility: hidden` element silently does nothing, so Escape went to the
 * game), the Escape ownership (`useHotkeys` listens in capture, so the
 * diagnostics rail ate it), and the scroll rule (`scrollMovesAnchor`, which the
 * reference panel had the naive version of and lost its answer to every line
 * the game printed). A second copy would be the next place each of those is
 * found again.
 */
export default function Popup({ at, onDismiss, role, label, className, children }: PopupProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  /*
   * Measured before paint, from the popup's own size rather than a guess at it,
   * and clamped to the window so a tab at the bottom of a full rail — or a
   * right-click in the last row of the console — still opens something
   * readable.
   */
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    const anchor = anchorBox(at);
    setPosition(
      menuPosition(
        anchor.box,
        // Rendered hidden on the first pass precisely so this is a measurement
        // rather than a guess; the fallbacks are for a node that never mounted.
        { width: box?.width ?? 200, height: box?.height ?? 80 },
        { width: window.innerWidth, height: window.innerHeight },
        anchor.align
      )
    );
  }, [at]);

  /*
   * Focused once it has somewhere to be, not on mount.
   *
   * The first pass renders the popup hidden so its size can be measured rather
   * than guessed at — and a `visibility: hidden` element cannot take focus, so
   * focusing on mount silently did nothing and Escape went to the game instead
   * of closing it. The latch keeps this to the first position rather than
   * stealing focus back on every reposition.
   */
  const focused = useRef(false);
  useEffect(() => {
    if (position === null || focused.current) return;
    focused.current = true;
    ref.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [position]);

  useEffect(() => {
    const away = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && ref.current?.contains(target)) return;
      // The control a popup hangs off toggles it, so a click there is its own
      // dismissal and must not be counted twice. A point anchor has no such
      // control, and every click outside the popup closes it.
      if (target && at instanceof HTMLElement && at.contains(target)) return;
      onDismiss();
    };
    /*
     * A scroll dismisses the popup only when it moved the thing it hangs off —
     * `scrollMovesAnchor` states the rule once, for this and for the reference
     * panel, which had the naive version and lost its answer to every line the
     * game printed.
     *
     * A right-click's anchor is the pointer, which is a fixed point in the
     * window that no scroll can move, so nothing scrolling closes it now. It
     * used to: the console's own auto-scroll shut the terminal's context menu
     * on the next line of output, which is the same complaint one surface
     * further along.
     */
    const scrolled = (event: Event): void => {
      if (!scrollMovesAnchor(event.target, anchorNode(at))) return;
      onDismiss();
    };
    // Capture, so a click on the game underneath dismisses the popup instead of
    // being swallowed by it.
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('resize', onDismiss);
    window.addEventListener('scroll', scrolled, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('scroll', scrolled, true);
    };
  }, [at, onDismiss]);

  const move = (delta: number): void => {
    const focusable = [
      ...(ref.current?.querySelectorAll('button:not([disabled]), input:not([disabled])') ?? [])
    ];
    if (focusable.length === 0) return;
    const from = focusable.indexOf(document.activeElement as HTMLElement);
    // Wraps, so Up from the first entry reaches the last rather than doing
    // nothing and reading as a popup that has stopped responding.
    const next = (from + delta + focusable.length) % focusable.length;
    (focusable[next] as HTMLElement | undefined)?.focus();
  };

  return createPortal(
    <div
      aria-label={label}
      className={`surface ${className}`}
      /*
       * This popup owns its own Escape.
       *
       * `useHotkeys` listens in capture and stops propagation, so a window
       * hotkey sees the key first — and with the diagnostics rail open, Escape
       * closed the rail instead of the popup, leaving something nobody could
       * dismiss over a rail nobody asked to close. Same rule as a dialog, and
       * the same reason.
       */
      data-owns-keys="true"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          move(event.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        // Tab out of a popup is a dismissal everywhere else, and leaving it
        // open behind a caret that has moved on is how one becomes litter.
        if (event.key === 'Tab') onDismiss();
      }}
      ref={ref}
      role={role}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position === null ? 'hidden' : 'visible'
      }}
    >
      {children}
    </div>,
    document.body
  );
}
