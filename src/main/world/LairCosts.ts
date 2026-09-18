import type { RoomId } from '../../shared/world';
import type { LairPass } from '../../shared/verdict';

/**
 * What one pass through each room's lair takes from one character — the hit
 * points and whether the wire settles that it happens (`LairPass`) —
 * remembered until the character changes.
 *
 * The router asks about every room it expands, and weighing a lair means
 * building its monsters' entities and running the combat arithmetic against
 * the sheet — cheap once, expensive fifty-seven thousand times a route. The
 * answer depends on the character as they stand (level, armour, standing, the
 * weapon in hand, the class row, the server's family), so the memo is keyed on
 * a *fitness* string built from exactly those figures: when any of them moves
 * — a level gained, a helm put on — the whole table is dropped and the rooms
 * are weighed afresh as the router reaches them. Health is deliberately not
 * among them: the damage is what is remembered, and the share of the health
 * the character has now is taken at every call. Nothing is written to disk;
 * the figures are derived and the sheet is re-read every session anyway.
 *
 * Null is remembered too: a room with no lair, or one nothing can price, is
 * asked about as often as any other.
 */
export class LairCosts {
  private fitness = '';
  private readonly rooms = new Map<RoomId, LairPass | null>();

  constructor(private readonly weigh: (room: RoomId) => LairPass | null) {}

  /** The pass for one room under the character described by `fitness`. */
  at(fitness: string, room: RoomId): LairPass | null {
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
