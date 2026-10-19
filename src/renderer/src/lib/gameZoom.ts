/**
 * Combat zoom (todo 20261019-1358-01): a setting, off by default
 * (`gameView.combatZoom`, 0 or 0.1 to 0.9). On, while the character fights and
 * the map follows it, the arena grows by that share of its resting size, the
 * map comes nearer in step and fades behind it. Sized from the arena, not the
 * window: a share of the window drew a 400 px arena on a large screen.
 * `fight` is how far in, 0 to 1, eased by the canvas as the arena's dock is.
 */

import { COMBAT_ZOOM_MOST } from '@shared/gameViewConfig';

/** How much of the map fades out at the largest zoom: the prototype drew it at 40% there. */
const MAP_FADE_AT_MOST = 0.6;

/** Whether the view zooms in: the zoom is on, the character fights, and the map follows it. */
export const zoomsIn = (grow: number, engaged: boolean, following: boolean): boolean =>
  grow > 0 && engaged && following;

/** The arena's radius `fight` of the way from its resting size to `grow` bigger. */
export const arenaRadiusAt = (resting: number, grow: number, fight: number): number =>
  resting * (1 + grow * fight);

/** The camera's zoom `fight` of the way in, over the player's own, in step with the arena. */
export const zoomAt = (z: number, grow: number, fight: number): number => z * (1 + grow * fight);

/** How opaque the map draws `fight` of the way in. */
export const mapAlphaAt = (grow: number, fight: number): number =>
  1 - MAP_FADE_AT_MOST * (Math.min(grow, COMBAT_ZOOM_MOST) / COMBAT_ZOOM_MOST) * fight;
