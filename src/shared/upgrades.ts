/**
 * The better gear the realm sells for a slot, as `gearUpgrades` lists it: what
 * is worn, and each better item with the counter selling it and its price.
 */

/** One better item for a slot, and where it is sold. */
export interface GearOffer {
  /** The realm's `Items` row. */
  item: number;
  name: string;
  /** Damage a round (or the mean blow) for a weapon, armour class otherwise. */
  figure: number | null;
  ac: number | null;
  dr: number | null;
  minLevel: number | null;
  shop: string;
  at: { map: number; room: number };
  moves: number;
  /** The counter's price before charm; null where the realm does not say. */
  copper: number | null;
}

/** One slot: what is worn and what the realm sells that is better. */
export interface SlotUpgrade {
  slot: string;
  /** The weakest worn there, which an upgrade replaces; null where nothing is worn. */
  worn: string | null;
  wornFigure: number | null;
  /**
   * Places in the slot nothing is worn in (a second ring finger): an offer
   * there fills one and replaces nothing.
   */
  free: number;
  /** The worn item's damage resistance as the realm states it; null where it does not. */
  wornDr: number | null;
  ranking: 'armour' | 'weapon';
  /** Best first; the cheapest this character can wear now comes last where it is not among them. */
  offers: GearOffer[];
}
