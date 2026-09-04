/**
 * The room being assembled, until `Obvious exits:` completes it.
 *
 * The fifth and last cluster out of `CharacterTracker` (2026-08-29), and the
 * smallest: a name, the items and occupants listed under it, and the prose in
 * between. What it carries is not the fields but the rule about them — a
 * draft is **completed or discarded, never carried across rooms**. The
 * description has no marker: it is whatever the server prints between the
 * name and the lines that do have markers, so the only safe place to collect
 * it is inside the same draft that the exits line either completes or throws
 * away. `megamind-client` accumulated it in a mutable field across rooms and
 * leaked fragments of one room into the next; the ten places the tracker used
 * to reset two fields by hand are one `discard()` now, and the shape a
 * completed room takes is built in one place.
 *
 * Resolving the completed room against the realm data stays with the tracker:
 * that asks the realm graph, the expectation queue and the previous room,
 * which are the tracker's to hold.
 */
import { emptyRoom, type Room, type RoomOccupant } from '../../shared/character';
import type { CurrencyEntity, ExitEntity, ItemEntity } from '../../shared/entities';
import { tuning } from '../app/tuning';

export class RoomDraft {
  private draft: Room = emptyRoom();
  private description: string[] = [];

  /**
   * A name starts a new draft. Anything half-collected belongs to a room we
   * never finished seeing, and keeping it would leak into this one.
   */
  begin(name: string | null): void {
    this.draft = { ...emptyRoom(), name };
    this.description = [];
  }

  /**
   * `You notice … here.` — already hydrated, because resolving a name against
   * the realm asks the world graph, which is the tracker's to hold.
   */
  items(items: ItemEntity[]): void {
    this.draft.items = items;
  }

  /**
   * Coins on the floor.
   *
   * Folded rather than appended: `18 gold drop to the ground.` and a `You
   * notice` listing are two statements about the same pile, and the coins used
   * to be pushed into `items` as the string `18 gold` — which put them in the
   * encumbrance count and in the paste of what is lying here.
   */
  cash(cash: CurrencyEntity | null): void {
    this.draft.cash = cash;
  }

  /** `Also here:`, already classified — that asks the realm table and the roster. */
  occupants(occupants: RoomOccupant[]): void {
    this.draft.occupants = occupants;
  }

  /**
   * A line of prose between the name and the exits. A blank line is nothing,
   * and past the limit the rest is let go — see `tuning.parse.descriptionLines`.
   */
  describe(text: string): void {
    if (this.description.length >= tuning().parse.descriptionLines) return;
    const line = text.trim();
    if (line.length === 0) return;
    this.description.push(line);
  }

  /**
   * Exits complete a room. Everything before this was provisional; what comes
   * back is unresolved — no map, no number, no confidence — because locating
   * it against the realm is the tracker's job, done with what only it holds.
   * The draft itself stands until the tracker discards it: a room the
   * resolver refuses is still the room on screen.
   */
  complete(exits: ExitEntity[]): Room {
    return {
      ...this.draft,
      description: this.description.length > 0 ? this.description.join(' ') : null,
      exits,
      map: null,
      number: null,
      resolvedBy: null,
      confidence: 0,
      ambiguous: 0,
      candidates: []
    };
  }

  /** The room is done with — completed, superseded, or left behind. */
  discard(): void {
    this.draft = emptyRoom();
    this.description = [];
  }
}
