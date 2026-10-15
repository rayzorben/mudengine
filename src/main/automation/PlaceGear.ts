/**
 * The armour the room the character stands in calls for, and putting back
 * what it replaced once the character is somewhere that calls for none
 * (todo 69). Composed into `EquipmentManager`, whose kit it is laid into
 * (`kitFor`'s `place`): above the `always` set, below any set the player
 * wrote for the situation. The choice is `placeChoice`'s and pure.
 *
 * Room-spell areas are contiguous (98% of their rooms have every exit into
 * the same element, `todo/69-element-census.txt`), so dressing room by room
 * swaps at the edge of one and not in the middle.
 */
import type { CharacterState } from '../../shared/character';
import type { PlaceLayer } from '../../shared/gear';
import { sameItem } from '../../shared/items';
import { placeChoice, type Exposure, type PlaceItem } from '../../shared/placeGear';
import { roomAddress, type RoomId } from '../../shared/world';

export interface PlaceGearSources {
  /** What the room deals by element, or null where the realm cannot place it. */
  exposureAt(room: RoomId): Exposure | null;
  /** A carried item as the choice reads it, or null where the realm has no slot for it. */
  placeItem(item: CharacterState['inventory']['items'][number]): PlaceItem | null;
}

export class PlaceGear {
  /** Slot → the item worn there before this module put the place's armour on. */
  private readonly replaced = new Map<string, string>();
  /** Slot → what this module last asked to wear there. */
  private wore = new Map<string, string>();
  /** The pack as last read, kept while the listing is the same object: `onCharacter` runs per line. */
  private read: { pack: CharacterState['inventory']['items']; items: PlaceItem[] } | null = null;
  /** The last room's exposure: realm data, asked once a room rather than once a line. */
  private exposed: { room: RoomId; exposure: Exposure | null } | null = null;

  constructor(private readonly sources: PlaceGearSources) {}

  reset(): void {
    this.replaced.clear();
    this.wore = new Map();
    this.exposed = null;
    this.read = null;
  }

  private itemsOf(pack: CharacterState['inventory']['items']): PlaceItem[] {
    if (this.read?.pack !== pack) {
      const items = pack.flatMap((item) => {
        const read = this.sources.placeItem(item);
        return read === null ? [] : [read];
      });
      this.read = { pack, items };
    }
    return this.read.items;
  }

  private exposureAt(room: RoomId): Exposure | null {
    if (this.exposed?.room !== room) {
      this.exposed = { room, exposure: this.sources.exposureAt(room) };
    }
    return this.exposed.exposure;
  }

  /**
   * Forget a replaced item the pack no longer holds (sold, dropped, lost in a
   * death), and adopt what someone else put in a dressed slot: better gear off
   * the floor (todo 77) or the player's own `wear` is what goes back there.
   */
  private followChanges(items: readonly PlaceItem[]): void {
    for (const [slot, was] of [...this.replaced]) {
      const worn = items.find((item) => item.equipped && item.slot === slot);
      const ours = this.wore.get(slot);
      if (
        worn !== undefined &&
        !sameItem(worn.name, was) &&
        (ours === undefined || !sameItem(worn.name, ours))
      ) {
        this.replaced.set(slot, worn.name);
      } else if (!items.some((item) => sameItem(item.name, was))) {
        this.replaced.delete(slot);
      }
    }
  }

  /**
   * The layer for the kit now. Nothing is put back while a fight is running:
   * a swap back mid-fight is a round spent on the wrong side of the edge.
   * `minSaved` is the hit points a round a swap has to save
   * (`automation.gear.resistMinSaved`).
   */
  layer(state: CharacterState, fighting: boolean, minSaved: number): PlaceLayer {
    const here = roomAddress(state.room);
    const exposure = here === null ? null : this.exposureAt(here);
    const items = this.itemsOf(state.inventory.items);
    this.followChanges(items);
    // Chosen against what was on before this module dressed the slot, so the
    // place's armour, once worn, is chosen again rather than swapped back.
    const baseline = items.map((item) => {
      const was = this.replaced.get(item.slot);
      return was === undefined ? item : { ...item, equipped: sameItem(item.name, was) };
    });
    const wear =
      exposure === null ? new Map<string, string>() : placeChoice(exposure, baseline, minSaved);
    for (const [slot] of wear) {
      if (this.replaced.has(slot)) continue;
      const worn = items.find((item) => item.equipped && item.slot === slot);
      if (worn !== undefined) this.replaced.set(slot, worn.name);
    }
    this.wore = wear;
    // An unplaced room or a running fight keeps what is on: neither undresses.
    if (exposure === null || fighting) return { wear, putBack: new Map() };
    const putBack = new Map<string, string>();
    for (const [slot, name] of this.replaced) {
      if (wear.has(slot)) continue;
      const back = items.find((item) => sameItem(item.name, name) && item.equipped);
      if (back !== undefined) this.replaced.delete(slot);
      else putBack.set(slot, name);
    }
    return { wear, putBack };
  }
}
