import type { RoomId } from '../../shared/world';

/**
 * What each room's lair costs one character, remembered until the character
 * changes.
 *
 * The router asks about every room it expands, and weighing a lair means
 * building its monsters' entities and running the combat arithmetic against
 * the sheet — cheap once, expensive fifty-seven thousand times a route. The
 * answer depends on the character as they stand (level, health, armour, the
 * weapon in hand, the class row, the server's family), so the memo is keyed on
 * a *fitness* string built from exactly those figures: when any of them moves
 * — a level gained, a helm put on — the whole table is dropped and the rooms
 * are weighed afresh as the router reaches them. Nothing is written to disk;
 * the figures are derived and the sheet is re-read every session anyway.
 *
 * Null is remembered too: a room with no lair, or one nothing can price, is
 * asked about as often as any other.
 */
export class LairCosts {
  private fitness = '';
  private readonly rooms = new Map<RoomId, number | null>();

  constructor(private readonly weigh: (room: RoomId) => number | null) {}

  /** The share for one room under the character described by `fitness`. */
  at(fitness: string, room: RoomId): number | null {
    if (fitness !== this.fitness) {
      this.fitness = fitness;
      this.rooms.clear();
    }
    const held = this.rooms.get(room);
    if (held !== undefined) return held;
    const share = this.weigh(room);
    this.rooms.set(room, share);
    return share;
  }

  /** How many rooms are remembered under the current fitness. */
  get size(): number {
    return this.rooms.size;
  }
}
