import { useCallback, useMemo, useRef, useState } from 'react';

import { movedPanel, normalizePanel, panelStyle, resizedPanel, type PanelBox } from '../lib/panel';

/**
 * Where the player dragged the settings panel, remembered per client.
 *
 * Per client rather than per character, like the pane widths and the theme: a
 * panel's place is a fact about this window on this display, not about who is
 * being played — and the panel is often opened with no character at all, which
 * is the case a per-character key could not answer for.
 *
 * The gesture is one pointer capture on whichever handle began it, with the
 * box at pointerdown held in a ref: a drag computed against the *current* box
 * accumulates its own rounding, so a slow circle with the pointer walks the
 * panel away from where it started.
 */
export interface SettingsPanel {
  /**
   * What to spread onto the panel, in percentages — or undefined while it has
   * never been dragged, where the stylesheet's own size is what it ships as.
   */
  style: Record<string, string> | undefined;
  /** Whether a box exists at all, for the rule that positions it. */
  placed: boolean;
  /** Begin a move, from the heading. */
  move(event: React.PointerEvent): void;
  /** Begin a resize, from the corner grip. */
  resize(event: React.PointerEvent): void;
  /** Forget the box, so it ships as it ships again. Double-click a handle. */
  reset(): void;
  /** True while a gesture is running, so the panel can drop its animation. */
  dragging: boolean;
}

const KEY = 'mudengine.settings.panel';

function read(): PanelBox | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return normalizePanel(parsed as Partial<PanelBox>);
  } catch {
    // A private window, cleared site data, or a value an older build wrote:
    // the panel opens as it ships rather than not opening.
    return null;
  }
}

function write(box: PanelBox): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(box));
  } catch {
    // Storage refused. The panel still moves; it forgets on the next launch,
    // which is the failure nobody has to be told about.
  }
}

export function useSettingsPanel(): SettingsPanel {
  const [box, setBox] = useState<PanelBox | null>(read);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ box: PanelBox; x: number; y: number; latest: PanelBox } | null>(null);

  const begin = useCallback(
    (event: React.PointerEvent, apply: (start: PanelBox, dx: number, dy: number) => PanelBox) => {
      // Only the primary button. A press on a control inside the heading never
      // reaches here — each of them stops it, so the row does not have to keep
      // a list of what is on it.
      if (event.button !== 0) return;
      /*
       * Measured against the **window**, not the handle's offset parent.
       *
       * The box is a fraction of the workspace and the layer it sits on is
       * `position: fixed; inset: 0`, so the window *is* the frame the fractions
       * are of. `offsetParent` here is the panel itself — it is positioned —
       * and a drag divided by the panel's own width moves it two or three
       * times as far as the hand went.
       */
      const width = window.innerWidth;
      const height = window.innerHeight;
      if (width <= 0 || height <= 0) return;
      event.preventDefault();
      const handle = event.currentTarget as HTMLElement;
      handle.setPointerCapture(event.pointerId);
      /*
       * A drag has to start from a box, and a panel that has never been moved
       * has none — so it starts from where it actually is, measured off the
       * panel itself. Reading the element rather than assuming a default is
       * what keeps the first drag from jumping: the stylesheet's size is
       * `min(1180px, 94vw)`, which is not a fixed fraction of anything.
       */
      const panel = handle.closest('.settings') ?? handle;
      const rect = panel.getBoundingClientRect();
      const start =
        box ??
        normalizePanel({
          x: rect.left / width,
          y: rect.top / height,
          w: rect.width / width,
          h: rect.height / height
        });
      gesture.current = { box: start, x: event.clientX, y: event.clientY, latest: start };

      const onMove = (moved: PointerEvent): void => {
        const start = gesture.current;
        if (start === null) return;
        const next = apply(
          start.box,
          (moved.clientX - start.x) / width,
          (moved.clientY - start.y) / height
        );
        start.latest = next;
        setBox(next);
      };
      const onUp = (): void => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        const start = gesture.current;
        gesture.current = null;
        setDragging(false);
        // Written once, at the end of the gesture: a drag is a few hundred
        // events and this is a JSON write on the thread drawing them.
        if (start !== null) write(start.latest);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
      setDragging(true);
    },
    [box]
  );

  const move = useCallback((event: React.PointerEvent) => begin(event, movedPanel), [begin]);
  const resize = useCallback((event: React.PointerEvent) => begin(event, resizedPanel), [begin]);
  const reset = useCallback(() => {
    setBox(null);
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      // As `write` does: the panel still moves, it forgets on the next launch.
    }
  }, []);

  const style = useMemo(() => panelStyle(box), [box]);
  return { style, placed: box !== null, move, resize, reset, dragging };
}
