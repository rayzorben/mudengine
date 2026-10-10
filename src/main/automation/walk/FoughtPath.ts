/**
 * The rooms a leg still owed when a fight stopped it, kept for the map while
 * that fight runs.
 *
 * A leg something else walks (a loop's lap, a supply trip, an area search)
 * ends when a fight starts, and its owner plans the next leg once the fight is
 * over. The character is still going there, so the map goes on drawing the
 * line until the fight ends or a new walk starts (user, 2026-10-10: the line
 * went off the map for every fight on a torch run). See `mudengine-automation`
 * › parts/walking.md.
 */
import type { RoomId } from '../../../shared/world';

export class FoughtPath {
  private rooms: RoomId[] = [];

  /** The walk stopped for a fight with these rooms still owed. True when something is kept. */
  keep(rooms: RoomId[]): boolean {
    this.rooms = rooms;
    return rooms.length > 0;
  }

  /** The fight is over, or a walk started. True when something was dropped. */
  clear(): boolean {
    if (this.rooms.length === 0) return false;
    this.rooms = [];
    return true;
  }

  get path(): RoomId[] {
    return this.rooms;
  }
}
