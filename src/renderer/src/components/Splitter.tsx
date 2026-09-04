import { memo, useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { clampWidth, keyAdjust, type SplitRange } from '../lib/splitter';

/**
 * The edge between two panes, and the only thing in the chrome that is dragged
 * to change the *grid*.
 *
 * It occupies the gap track itself rather than sitting beside it: the gap is
 * already where a person expects a divider to be, and a separate track would
 * double the seam. The hit area is 24px wide (WCAG 2.5.8) whatever the gap;
 * the visible seam is a hairline that appears on hover, focus and drag, per
 * docs/ui-design.md §9 — a border is a seam, often absent.
 *
 * `role="separator"` with a value is the WAI-ARIA window-splitter pattern:
 * focusable, arrows move it, Home and End go to the ends. A press keeps the
 * caret in the terminal (`keepFocus`) — this is clicked, never typed into —
 * and keyboard focus still reaches it by Tab.
 *
 * Every move is clamped by the caller's `range`, which is computed when the
 * gesture starts so the console's measured floor is what bounds it (see
 * `lib/splitter.ts`). A double-click resets to the density's default.
 *
 * **The pane is measured when the answer is needed, never during a render.**
 * `value` used to be a number the window computed for every render of its
 * root — `getBoundingClientRect` on the pane, three panes, every commit —
 * which forced a synchronous layout in the middle of React's work each time
 * anything in the window changed. Measured with `npm run profile:ui`
 * (2026-09-04): sixty milliseconds of forced layout in a five-second fight,
 * for a figure read only by the accessibility tree and by a gesture. The
 * caller now hands in `measure`, a gesture or a key reads it as it starts, and
 * the ARIA figures are written after the commit, when layout is already clean.
 */
export interface SplitterProps {
  /** Which pane this edge belongs to, for the accessible name. */
  label: string;
  /** The pane's current width in px, as laid out — read when a gesture or a key needs it. */
  measure(): number;
  /** Where the pane sits; decides which way a drag grows it, and the axis. */
  edge: 'left' | 'right' | 'top' | 'bottom';
  /** Called with the range in force when a gesture starts. */
  rangeFor(): SplitRange;
  onChange(px: number): void;
  onReset(): void;
  onDragging?(active: boolean): void;
}

function Splitter({
  label,
  measure,
  edge,
  rangeFor,
  onChange,
  onReset,
  onDragging
}: SplitterProps) {
  const gesture = useRef<{
    startX: number;
    startWidth: number;
    range: SplitRange;
    frame: number | null;
  } | null>(null);
  const element = useRef<HTMLDivElement | null>(null);

  const vertical = edge === 'top' || edge === 'bottom';
  const along = useCallback(
    (event: { clientX: number; clientY: number }): number =>
      vertical ? event.clientY : event.clientX,
    [vertical]
  );

  /*
   * The ARIA figures, written after the commit, again when the window
   * resizes, and a frame after every move this handle makes — the moment the
   * grid has taken the new width. Written onto the element rather than
   * rendered, because rendering them would mean measuring during a render,
   * which is the forced layout this component exists not to cause — and a
   * state set from an effect would be a second render of the whole thing for
   * three attributes nobody sees.
   */
  const announce = useCallback((): void => {
    const node = element.current;
    if (!node) return;
    const range = rangeFor();
    node.setAttribute('aria-valuemin', String(Math.round(range.min)));
    node.setAttribute('aria-valuemax', String(Math.round(Math.max(range.min, range.max))));
    node.setAttribute('aria-valuenow', String(Math.round(measure())));
  }, [measure, rangeFor]);
  const announced = useRef<number | null>(null);
  const announceAfterLayout = useCallback((): void => {
    if (announced.current !== null) return;
    announced.current = requestAnimationFrame(() => {
      announced.current = null;
      announce();
    });
  }, [announce]);
  const apply = useCallback(
    (pos: number) => {
      const g = gesture.current;
      if (!g) return;
      const d = pos - g.startX;
      const next = g.startWidth + (edge === 'left' || edge === 'top' ? d : -d);
      onChange(clampWidth(next, g.range));
      announceAfterLayout();
    },
    [announceAfterLayout, edge, onChange]
  );

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = {
        startX: along(event),
        startWidth: measure(),
        range: rangeFor(),
        frame: null
      };
      onDragging?.(true);
    },
    [along, measure, onDragging, rangeFor]
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const g = gesture.current;
      if (!g) return;
      // One layout per frame, however many pointer events arrive: every width
      // change re-fits the terminal, and a fit is not free.
      if (g.frame !== null) cancelAnimationFrame(g.frame);
      const x = along(event);
      g.frame = requestAnimationFrame(() => {
        if (gesture.current) gesture.current.frame = null;
        apply(x);
      });
    },
    [along, apply]
  );

  const end = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const g = gesture.current;
      if (!g) return;
      if (g.frame !== null) cancelAnimationFrame(g.frame);
      apply(along(event));
      gesture.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      onDragging?.(false);
    },
    [along, apply, onDragging]
  );

  useEffect(
    () => () => {
      if (gesture.current?.frame !== null && gesture.current?.frame !== undefined) {
        cancelAnimationFrame(gesture.current.frame);
      }
    },
    []
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const grows =
        edge === 'left'
          ? 'ArrowRight'
          : edge === 'right'
            ? 'ArrowLeft'
            : edge === 'top'
              ? 'ArrowDown'
              : 'ArrowUp';
      const adjust = keyAdjust(event.key, event.shiftKey, grows);
      if (adjust === null) return;
      event.preventDefault();
      const range = rangeFor();
      if (adjust === 'min') onChange(range.min);
      else if (adjust === 'max') onChange(clampWidth(range.max, range));
      else onChange(clampWidth(measure() + adjust, range));
      announceAfterLayout();
    },
    [announceAfterLayout, edge, measure, onChange, rangeFor]
  );

  useEffect(() => {
    announce();
    window.addEventListener('resize', announce);
    return () => {
      window.removeEventListener('resize', announce);
      if (announced.current !== null) cancelAnimationFrame(announced.current);
    };
  }, [announce]);

  return (
    <div
      aria-label={label}
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      className="splitter"
      data-edge={edge}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      onLostPointerCapture={() => {
        if (gesture.current) {
          gesture.current = null;
          onDragging?.(false);
        }
      }}
      onMouseDown={keepFocus}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      ref={element}
      role="separator"
      tabIndex={0}
      title={t('splitter.tooltip', { paneName: label })}
    />
  );
}

const Memoised = memo(Splitter);
export { Memoised as Splitter };
