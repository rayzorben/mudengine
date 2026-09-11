/**
 * Where a movable panel sits over the workspace, and how a drag moves it.
 *
 * The settings screen used to be a modal over a scrim: it took the whole
 * window, took every click, and could not be got out of the way. Which is
 * wrong for the thing it actually is — somebody edits a setting to see what it
 * does, and what it does happens in the console behind it, sometimes while a
 * character is being hit. So the screen is a panel: moved by its heading,
 * resized from its corner, dismissed by its own close glyph or by Escape while
 * it holds the caret, and never in the way of a keystroke meant for the realm.
 *
 * **Fractions of the workspace, never pixels**, which is the rule a floating
 * card already follows (`useCardLayout`): a geometry stored in pixels on a
 * 3,000px display opens off-screen on a laptop, and one stored in fractions is
 * the same panel in the same place on both. Clamped on the way in and on the
 * way out, so a value from an older build or a resized window can always be
 * dragged back.
 *
 * Pure, and tested as such: the arithmetic of a drag is the half that goes
 * wrong, and it cannot be reached through a pointer in a unit test.
 */

/** A panel's box, every figure a fraction of the workspace. */
export interface PanelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The smallest a panel may be dragged to.
 *
 * The settings form is four columns of controls at its narrowest useful width
 * and its lists scroll, so a third of the window each way is the point below
 * which nothing on it can be read — smaller than a card's minimum, because
 * this holds a form rather than a readout.
 */
export const PANEL_MIN = { w: 0.3, h: 0.3 } as const;

/**
 * The box a panel takes when a drag first has to start from *somewhere*.
 *
 * Not what it opens as. **A panel that has never been dragged has no box at
 * all**: it keeps the size the stylesheet gives it, centred, exactly as the
 * dialog always looked. A fraction cannot serve both ends of the range — the
 * form wants about 750px for its four tracks of switches, which is 54% of a
 * wide window and 94% of a narrow one — so it is not asked to. The stylesheet
 * states the size in `min(1180px, 94vw)`, which already answers both, and the
 * fractions take over the moment somebody moves it, where what they want is
 * exactly what they dragged.
 */
export const DEFAULT_PANEL: PanelBox = { x: 0.03, y: 0.05, w: 0.94, h: 0.9 };

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

/**
 * A stored or dragged box, made legal.
 *
 * The size is clamped first and the position against the size, so a panel is
 * always wholly inside the workspace: clamping the position first would let a
 * later width push its right edge out with nothing to pull it back.
 */
export function normalizePanel(box: Partial<PanelBox> | null | undefined): PanelBox {
  const number = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const w = clamp(number(box?.w, DEFAULT_PANEL.w), PANEL_MIN.w, 1);
  const h = clamp(number(box?.h, DEFAULT_PANEL.h), PANEL_MIN.h, 1);
  return {
    w,
    h,
    x: clamp(number(box?.x, DEFAULT_PANEL.x), 0, 1 - w),
    y: clamp(number(box?.y, DEFAULT_PANEL.y), 0, 1 - h)
  };
}

/** The box a drag of `dx`/`dy` fractions from `from` lands on. */
export function movedPanel(from: PanelBox, dx: number, dy: number): PanelBox {
  return normalizePanel({ ...from, x: from.x + dx, y: from.y + dy });
}

/**
 * The box a resize of the bottom-right corner lands on.
 *
 * The corner alone, not eight handles: the panel is opened at the top left and
 * the one thing anybody wants of it is *smaller*, or *taller so the form fits*.
 * The position never moves, so a resize cannot walk the panel off the top of
 * the window while somebody drags the corner up.
 */
export function resizedPanel(from: PanelBox, dx: number, dy: number): PanelBox {
  const w = clamp(from.w + dx, PANEL_MIN.w, 1 - from.x);
  const h = clamp(from.h + dy, PANEL_MIN.h, 1 - from.y);
  return { ...from, w, h };
}

/**
 * The box as the style the panel is drawn with, or nothing while it has none.
 *
 * Null is *as it ships* — the stylesheet's own size, centred — and it is the
 * state a panel nobody has dragged is in. See `DEFAULT_PANEL`.
 */
export function panelStyle(box: PanelBox | null): Record<string, string> | undefined {
  if (box === null) return undefined;
  return {
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.w * 100}%`,
    height: `${box.h * 100}%`
  };
}
