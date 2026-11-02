/**
 * One place this client saw an item, as an item's lookup carries it
 * (`WorldLookup.seen`, joined by `main/world/itemSeen.ts`). See
 * `mudengine-world` › `parts/lore.md` › *What lies on a floor is kept per realm*.
 */
import type { RoomId } from './world';

export type ItemSeen =
  | { where: 'floor'; room: RoomId; roomName: string; first: number; at: number }
  | {
      where: 'shop';
      room: RoomId;
      roomName: string;
      at: number;
      /** As the counter printed it. */
      price: string;
      quantity: number | null;
    }
  | { where: 'search'; room: RoomId; roomName: string; at: number; seen: number };
