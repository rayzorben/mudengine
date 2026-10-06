/**
 * Selling at a counter: where an item can be sold and what it pays there, and
 * a sale under way as a card reads it. The counters are the realm's, the
 * copper the server's arithmetic (`soldForCopper`); the trip is `SellTrip`.
 */
import type { RoomId, RoomReference } from './world';

/** A counter that buys an item, and what one sale there pays. */
export interface SalePlace {
  shop: string;
  at: RoomReference;
  roomName: string;
  /** Moves from where the character stands. */
  moves: number;
  /** What selling one pays, in copper, the seller's charm counted. */
  copper: number;
}

/** A sale under way: walking to the counter, or selling there. */
export interface SaleTrip {
  room: RoomId;
  shop: string;
  items: readonly string[];
  stage: 'walking' | 'selling';
}
