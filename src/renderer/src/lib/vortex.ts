/**
 * A teleport's mark (todo 147): two arms turning in to a dot, the one spiral
 * the Map card's SVG and the game view's canvas both draw. The arms are
 * stroked, the dot filled. `mudengine-ui` › `parts/map.md` has the sizes.
 */

/** The two arms, as an SVG path about (`x`, `y`) with outer radius `size`. */
export function vortexArms(x: number, y: number, size: number): string {
  const arm = (turn: 1 | -1): string =>
    `M ${x + turn * size} ${y} ` +
    `A ${size * 0.75} ${size * 0.75} 0 0 0 ${x - turn * size * 0.5} ${y - turn * size * 0.25} ` +
    `A ${size * 0.4} ${size * 0.4} 0 0 0 ${x + turn * size * 0.15} ${y + turn * size * 0.3}`;
  return `${arm(1)} ${arm(-1)}`;
}

/** The dot's radius, as a share of the vortex's. */
export const VORTEX_DOT = 0.18;
