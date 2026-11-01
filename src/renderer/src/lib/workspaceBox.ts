/**
 * A box over the workspace made legal: a floating card or the settings panel,
 * every figure a fraction of the workspace. The size is clamped first and the
 * position against the size, so the whole box stays inside. A position clamped
 * on its own to 0..0.98 left festus's Combat Stats float at 0.98, 0.98 with
 * its head outside the window, where nothing could reach it (2026-10-31).
 */

/** A box in fractions of the workspace. */
export interface WorkspaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `value` held within `low..high`. */
export const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

/** `box` no smaller than `least`, no larger than the workspace, and wholly inside it. */
export function inWorkspace(box: WorkspaceBox, least: { w: number; h: number }): WorkspaceBox {
  const w = clamp(box.w, least.w, 1);
  const h = clamp(box.h, least.h, 1);
  return { x: clamp(box.x, 0, 1 - w), y: clamp(box.y, 0, 1 - h), w, h };
}
