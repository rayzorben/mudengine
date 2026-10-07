/**
 * Where each card stands on the card rail (todo 06, 2026-10-05): the box each
 * is preferred in, how a layout's kept spots and sizes are drawn on a rail of
 * any width, and when the rail is too narrow and stacks. Pure; `RailGrid`,
 * auto layout, the drag and the corner grip read it, and `placed` writes
 * through it. See `mudengine-ui` › `parts/cards.md`, *Every card has a
 * preferred box, and a narrower rail draws it narrower*.
 */
import { LEAST_CARD, type CardId, type CardLayout } from './cards';
import {
  inWantedOrder,
  scaled,
  squeezed,
  type GridBox,
  type GridCard,
  type GridSize,
  type GridSpot,
  type RailWidth
} from './railGrid';

/**
 * The card rail's narrowest, in cells: one card column, 260px of card and the
 * 12px between two, which is what a card was drawn at before it had a
 * preferred box. The rail's track keeps it (`--card-columns`).
 */
export const NARROWEST_RAIL = 17;

/**
 * The narrowest a card stands where it was put, in cells: 11 is 164px of card
 * at the widest gap, over `--card-size-medium` (160px). The rail stacks once a
 * card's width in proportion rounds under it (`railFor`). Until then,
 * rounding both sides can lose a cell and draw a card 10 wide, which is small.
 */
export const NARROWEST_CARD = 11;

/** How wide the rail `PREFERRED` was drawn on is, in cells. */
const PREFERRED_COLUMNS = 49;

/**
 * Where each card is wanted on the rail and how big, before anybody moves or
 * sizes it (todo 06, 2026-10-05): the rail with every card open, on festus's
 * rail as the player arranged it, 49 cells across. The six festus keeps open
 * are where festus has them; the rest are under them in the same two columns,
 * a table that needs the room on the left. Across is in proportion to the
 * rail (`scaled`); down, a card takes the highest free cells in its own
 * columns, in the order these rows give, so a card that is not open leaves
 * no gap. A card with more to say scrolls inside its box: a card that grows
 * moves the cards around it, and **Stop walking** is reached for while the
 * thing moving it is running.
 */
const PREFERRED: Record<CardId, GridBox> = {
  map: { x: 0, y: 0, w: 29, h: 27 },
  vitals: { x: 29, y: 0, w: 20, h: 14 },
  // A name, a bar, a legend and up to three readout rows.
  combat: { x: 29, y: 14, w: 20, h: 13 },
  stats: { x: 0, y: 27, w: 29, h: 22 },
  // A loop's name, its bar, four figures and the stops.
  navigation: { x: 29, y: 27, w: 20, h: 22 },
  conversation: { x: 0, y: 49, w: 49, h: 22 },
  room: { x: 0, y: 71, w: 29, h: 14 },
  // Two ranks with a member each, the commonest party there is.
  party: { x: 29, y: 71, w: 20, h: 14 },
  // The sheet is thirty rows and the pack face has a meter, the purse, a find
  // field and chips before its table, whose number column needs 285px of card
  // (`npm run smoke`, 2026-10-03: 25px over at 260), so it is in the wide
  // column; under 20 cells the number column is cut off at the right (a table
  // never scrolls sideways). Carrying is that table.
  self: { x: 0, y: 85, w: 29, h: 21 },
  notifications: { x: 29, y: 85, w: 20, h: 15 },
  // Matched to Realm: they are read together.
  players: { x: 29, y: 100, w: 20, h: 14 },
  realm: { x: 0, y: 106, w: 29, h: 14 },
  reference: { x: 29, y: 114, w: 20, h: 13 },
  inventory: { x: 0, y: 120, w: 29, h: 16 },
  hunting: { x: 29, y: 127, w: 20, h: 13 },
  // The budget, a slot table and the plan's press, under Banks.
  gear: { x: 29, y: 165, w: 20, h: 18 },
  // A five-column table, Carrying's width for the same reason.
  shops: { x: 0, y: 136, w: 29, h: 14 },
  gang: { x: 29, y: 140, w: 20, h: 13 },
  // Two vaults and a total, which is more banking than most characters do.
  banks: { x: 29, y: 153, w: 20, h: 12 },
  // A row's progress figure sits after the quest's name, outside its column
  // at 260px (`npm run smoke`, 2026-10-03).
  quests: { x: 0, y: 150, w: 29, h: 27 },
  extension: { x: 0, y: 177, w: 29, h: 31 },
  // A map with a list under it and controls under that. It ships as a float.
  builder: { x: 0, y: 208, w: 29, h: 33 },
  session: { x: 0, y: 241, w: 29, h: 13 },
  link: { x: 29, y: 241, w: 20, h: 14 },
  automation: { x: 0, y: 254, w: 29, h: 14 },
  stream: { x: 29, y: 255, w: 20, h: 15 },
  // One band high, the height of the rail head and the put-away chips. It
  // ships docked above the console (`DEFAULT_ABOVE`).
  toolbar: { x: 0, y: 270, w: 49, h: 4 }
};

/** How wide the rail a fresh arrangement is kept on is: `PREFERRED`'s. */
export const KEPT_COLUMNS = PREFERRED_COLUMNS;

/** What a layout keeps of the rail: spots and sizes in cells of a rail `columns` wide. */
export type RailKept = Pick<CardLayout, 'spots' | 'sizes' | 'columns'>;

/** A card's place and size as nobody has put or sized it: where each is wanted. */
export const NOTHING_KEPT: RailKept = { spots: {}, sizes: {}, columns: KEPT_COLUMNS };

/** How big a card is wanted on a rail kept `columns` wide, in its cells. */
export function preferredSize(id: CardId, columns: number): GridSize {
  const { w, h } = PREFERRED[id];
  return { w: Math.round((w * columns) / PREFERRED_COLUMNS), h };
}

/** Where a card is wanted on a rail, and how big. */
export function preferredOn(id: CardId, rail: RailWidth): GridBox {
  return scaled(PREFERRED[id], PREFERRED_COLUMNS, rail);
}

/**
 * A card's box as kept, and the width of the rail it is cells of: where it
 * was put at the size it was given or is wanted at, else where it is wanted.
 */
function keptOf(id: CardId, kept: RailKept): { box: GridBox; from: number } {
  const spot = kept.spots[id];
  const size = kept.sizes[id];
  if (spot) {
    return { box: { ...spot, ...(size ?? preferredSize(id, kept.columns)) }, from: kept.columns };
  }
  if (size) {
    const at = scaled(PREFERRED[id], PREFERRED_COLUMNS, { columns: kept.columns, stacked: false });
    return { box: { ...at, ...size }, from: kept.columns };
  }
  return { box: PREFERRED[id], from: PREFERRED_COLUMNS };
}

/**
 * The rail `columns` wide that `cards` are drawn on: stacked when it would
 * draw any of them narrower than it stands (`NARROWEST_CARD`, or `LEAST_CARD`
 * for one given fewer), so the narrowest rail is one column of whole-width
 * cards rather than narrow ones beside a gap.
 */
export function railFor(cards: Iterable<CardId>, kept: RailKept, columns: number): RailWidth {
  for (const id of cards) {
    const { box, from } = keptOf(id, kept);
    const stands = box.w < NARROWEST_CARD ? LEAST_CARD.w : NARROWEST_CARD;
    if (squeezed(box, from, columns, stands)) return { columns, stacked: true };
  }
  return { columns, stacked: false };
}

/**
 * The rail's order with the cards that have a spot in the order they are read
 * in, top row first; a card with none keeps its place. The order a stacked
 * rail draws them in.
 */
export function inReadingOrder<Id extends string>(
  cards: readonly Id[],
  spots: Partial<Record<Id, GridSpot>>
): Id[] {
  const slots = cards.flatMap((card, i) => (spots[card] ? [i] : []));
  const read = inWantedOrder(
    slots.map((i) => cards[i]!),
    (card) => spots[card]!
  );
  const out = [...cards];
  slots.forEach((slot, k) => (out[slot] = read[k]!));
  return out;
}

/** A card's box as kept, drawn on `rail`: the whole width on a stacked one. */
export function drawnOn(id: CardId, kept: RailKept, rail: RailWidth): GridBox {
  const { box, from } = keptOf(id, kept);
  return scaled(box, from, rail);
}

/**
 * Where a card stands on a rail `columns` wide, in proportion: never the
 * whole width a stacked rail draws it at. Its box from what was kept, or
 * where it is wanted with the row it is wanted at.
 */
export function standsOn(id: CardId, kept: RailKept, columns: number): GridBox {
  return drawnOn(id, kept, { columns, stacked: false });
}

/**
 * Every rail card as `arrange` takes it on a rail `columns` wide, `cards`
 * given in the rail's own order, and the rail they are drawn on. A card
 * stands where it was put and at the size it was given, as far as it has
 * been, else it is wanted where it is preferred. A stacked rail is the cards
 * in the rail's order, one under another, whatever was kept.
 */
export function onRail(
  cards: readonly CardId[],
  kept: RailKept,
  columns: number
): { width: RailWidth; cards: GridCard<CardId>[] } {
  const width = railFor(cards, kept, columns);
  return {
    width,
    cards: cards.map((id, order): GridCard<CardId> => {
      const at = drawnOn(id, kept, width);
      const size = { w: at.w, h: at.h };
      if (width.stacked) return { id, size, wanted: { x: 0, y: order } };
      const wanted = { x: at.x, y: PREFERRED[id].y };
      return kept.spots[id]
        ? { id, size, spot: { x: at.x, y: at.y }, wanted }
        : { id, size, wanted };
    })
  };
}
