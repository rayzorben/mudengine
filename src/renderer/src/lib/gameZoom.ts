/**
 * Combat zoom (todo 20261018-1314-01): while the character fights and the map
 * follows it, the view zooms in on its room, the arena grows to most of the
 * view and the map fades behind it. `fight` is how far in, 0 to 1, eased by the
 * canvas as the arena's dock is. The figures are the prototype the user chose
 * (`todo/20261018-1314-01-combat-zoom.html`, a 720 by 500 view).
 */

/** The arena's radius as a share of the view's short side: 188 of 500. */
const ARENA_SHARE = 0.38;
/** How much nearer the map draws: a room 205 px from the next against 105. */
const MAP_ZOOM = 1.95;
/** How much of the map fades out: it draws at 32%. */
const MAP_FADE = 0.68;

/** Whether the view zooms in: the character is fighting and the map follows it. */
export const zoomsIn = (engaged: boolean, following: boolean): boolean => engaged && following;

/** The arena's radius `fight` of the way from its resting size to the zoomed one. */
export function arenaRadiusAt(
  width: number,
  height: number,
  resting: number,
  fight: number
): number {
  const zoomed = Math.max(resting, Math.min(width, height) * ARENA_SHARE);
  return resting + (zoomed - resting) * fight;
}

/** The camera's zoom `fight` of the way in, over the player's own. */
export const zoomAt = (z: number, fight: number): number => z * (1 + (MAP_ZOOM - 1) * fight);

/** How opaque the map draws `fight` of the way in. */
export const mapAlphaAt = (fight: number): number => 1 - MAP_FADE * fight;
