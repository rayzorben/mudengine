/**
 * A name line's mark with or without the room it was printed for: what a
 * click on the name in the backscroll routes to (`TerminalMark.room`).
 */
import type { TerminalMark } from '../../shared/types';
import type { RoomReference } from '../../shared/world';
import { pressless } from './markFile';

/** A line's mark with the room it was printed for; a plain room is a mark with nothing to draw. */
export const withRoom = (
  mark: TerminalMark | null,
  label: string,
  room: RoomReference
): TerminalMark => ({
  ...(mark ?? { label }),
  room
});

/** A line's mark with its room taken off; null when nothing is left to draw. */
export function withoutRoom(mark: TerminalMark | null): TerminalMark | null {
  if (mark === null) return null;
  const { room: _room, ...rest } = mark;
  return pressless(rest);
}
