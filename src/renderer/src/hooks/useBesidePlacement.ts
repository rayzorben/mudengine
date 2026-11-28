/**
 * Where a panel's companion sits: beside the panel the way the panel sits
 * beside its name, the panel's box as the anchor. As wide as the room beside
 * the panel allows (`popoverWidth`) and placed by `placePopover`: right where
 * there is room, else left, else under or above it; over it only in a window
 * with no room on any side. Follows
 * the panel as it is dragged or sized, and re-places on a window resize. See
 * `mudengine-ui` › tables.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { placePopover, popoverWidth, type PopoverPlacement } from '../lib/popover';
import { tuning } from '../lib/tuning';

const viewportNow = () => ({ width: window.innerWidth, height: window.innerHeight });

export function useBesidePlacement(
  panel: RefObject<HTMLDivElement | null>,
  /** What moves or resizes the panel or the companion, as a fixed-length list. */
  measure: readonly unknown[]
): { ref: RefObject<HTMLDivElement>; style: CSSProperties } {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [placed, setPlaced] = useState<PopoverPlacement | null>(null);
  // Never taller than the window, so a card of many rows scrolls inside it.
  const [tallest, setTallest] = useState<number | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const beside = panel.current;
      const element = ref.current;
      if (beside === null || element === null) return;
      const anchor = beside.getBoundingClientRect();
      const viewport = viewportNow();
      const { popoverWidthMin, popoverWidthMax, popoverMargin } = tuning();
      // Measured at the height it will be drawn at, so it is capped first.
      const cap = viewport.height - popoverMargin * 2;
      if (cap !== tallest) {
        setTallest(cap);
        return;
      }
      const want = popoverWidth(anchor, viewport, { min: popoverWidthMin, max: popoverWidthMax });
      // Sized first and measured after, as the panel is: the height read is
      // the one this width produces.
      if (want !== width) {
        setWidth(want);
        return;
      }
      setPlaced(placePopover(anchor, { width, height: element.offsetHeight }, viewport));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [panel, width, tallest, ...measure]);

  return {
    ref,
    style: {
      top: placed?.top ?? 0,
      left: placed?.left ?? 0,
      ...(width === null ? {} : { width }),
      ...(tallest === null ? {} : { maxHeight: tallest }),
      visibility: placed === null ? 'hidden' : 'visible'
    }
  };
}
