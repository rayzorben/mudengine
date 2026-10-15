/**
 * The game view's glyphs (todo 140): an icon for every kind of place, the
 * lair's skull and a player's figure, as 24-unit SVG paths drawn by both the
 * canvas (`Path2D`) and the HUD (`<path>`). The prototype's, agreed with the
 * user on 2026-10-14; glyphs stay in code.
 */
import type { ShopIcon } from '@shared/gameMap';

const COIN =
  'M12 2.5a9.5 9.5 0 1 0 0 19a9.5 9.5 0 1 0 0-19Zm0 3.5a6 6 0 1 1 0 12a6 6 0 1 1 0-12Z M10.8 8h2.4v8h-2.4Z';
const SWORD =
  'M18.5 2.5 21.5 5.5 11 16l-3-3Z M5.5 11.5l7 7-1.6 1.6-1.9-1.9-2.6 2.6-2.2-2.2 2.6-2.6-1.9-1.9Z';
const SHIELD = 'M12 2.5 20 5.5V11c0 5-3.4 8.6-8 10.5C7.4 19.6 4 16 4 11V5.5Z';
const STAR = 'M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4Z';
const GEM = 'M7 4h10l4 5-9 12L3 9Z';
const BAG =
  'M5 8.5h14l-1.3 12H6.3Z M8.6 8.5V7a3.4 3.4 0 0 1 6.8 0v1.5h-1.8V7a1.6 1.6 0 0 0-3.2 0v1.5Z';
const CROSS = 'M10.5 2.5h3v5.5H19v3h-5.5v10h-3v-10H5V8h5.5Z';
const MUG =
  'M4.5 5h10v15h-10Z M14.5 8h2.6A2.9 2.9 0 0 1 20 10.9v2.7a2.9 2.9 0 0 1-2.9 2.9h-2.6v-2.2h2.6a.7.7 0 0 0 .7-.7v-2.7a.7.7 0 0 0-.7-.7h-2.6Z';
const CAP = 'M12 3l10 5-10 5L2 8Z M6 10.6V15c0 1.7 2.7 3.2 6 3.2s6-1.5 6-3.2v-4.4l-6 3Z';
const BED =
  'M3 8h2v5h14a2 2 0 0 1 2 2v4h-2v-2H5v2H3Z M7 9.5a2 2 0 1 1 4 0a2 2 0 1 1-4 0Z M12 9h6a2 2 0 0 1 2 2v1h-8Z';
const BOW =
  'M6 2.5c6 2.5 9 6 9 9.5s-3 7-9 9.5l-.8-1.8c5-2.2 7.8-5 7.8-7.7S10.2 6.5 5.2 4.3Z M5.8 3.4 7 20.6h-1.6L4.2 3.4Z M8 11h13l-2.5-2v4.5L21 11.5';
const CLOAK = 'M9 2.5h6l1 3 4 15H4l4-15Z M10.2 5 12 8l1.8-3Z';
const NOTE = 'M9 4.5 20 2.5v13.2a3 3 0 1 1-2-2.8V6.6l-7 1.3v10a3 3 0 1 1-2-2.8Z';
const FLASK =
  'M9 2.5h6v2h-1v5.2l5.4 8.4A2.6 2.6 0 0 1 17.2 22H6.8a2.6 2.6 0 0 1-2.2-3.9L10 9.7V4.5H9Z';
const BREAD = 'M4 13a8 5 0 0 1 16 0v5.5H4Z M8 9.6l1.4 3M12 8.6v3.2M16 9.6l-1.4 3';
const BOAT = 'M3 14h18l-3 6H6Z M11 3h2v10h-2Z M13 4l6 7h-6Z';
const KEY =
  'M8 4.5a5 5 0 1 0 4.6 7H15l1.5 1.5L18 11.5l1.5 1.5L22 10.5 19.5 8h-6.9A5 5 0 0 0 8 4.5Zm-1 3.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3Z';
const SCROLL =
  'M6 3h11a3 3 0 0 1 3 3v1h-3v11a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-1h3V6a3 3 0 0 1 1-3Z M8 8h6v1.6H8Zm0 3.4h6V13H8Z';
const CYCLE =
  'M12 3a9 9 0 0 1 8.5 6h-2.3A7 7 0 0 0 6.2 8.2L8.5 10.5H2.5v-6l2.3 2.3A9 9 0 0 1 12 3Z M12 21a9 9 0 0 1-8.5-6h2.3a7 7 0 0 0 12 .8l-2.3-2.3h6v6l-2.3-2.3A9 9 0 0 1 12 21Z';
const EYE =
  'M12 4.5a7.5 7.5 0 0 1 7.5 7.5c0 4.2-3.4 7.5-7.5 7.5S4.5 16.2 4.5 12 7.8 4.5 12 4.5Zm0 4a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7Z';
const CHAIR = 'M6 3h12v8H6Z M4 12h16v3H4Z M5 15h2v6H5Zm12 0h2v6h-2Z';
const BANNER = 'M5 2.5h2v19H5Z M7 3.5h12l-3 4.5 3 4.5H7Z';

export const PLACE_PATHS: Record<ShopIcon, string> = {
  bank: COIN,
  temple: CROSS,
  tavern: MUG,
  inn: BED,
  trainer: CAP,
  weapons: SWORD,
  bows: BOW,
  armour: SHIELD,
  shields: SHIELD,
  clothing: CLOAK,
  magic: STAR,
  songs: NOTE,
  jewels: GEM,
  goods: BAG,
  potions: FLASK,
  food: BREAD,
  boats: BOAT,
  keys: KEY,
  deeds: SCROLL,
  recycler: CYCLE,
  oddities: EYE,
  furniture: CHAIR,
  guild: BANNER
};

/** Which of the HUD's colour tokens a place wears: money, worship, drink, learning, or trade. */
export type PlaceTone = 'bank' | 'temple' | 'tavern' | 'trainer' | 'shop';

export function placeTone(icon: ShopIcon): PlaceTone {
  switch (icon) {
    case 'bank':
      return 'bank';
    case 'temple':
      return 'temple';
    case 'tavern':
    case 'inn':
    case 'food':
      return 'tavern';
    case 'trainer':
    case 'guild':
      return 'trainer';
    case 'weapons':
    case 'bows':
    case 'armour':
    case 'shields':
    case 'clothing':
    case 'magic':
    case 'songs':
    case 'jewels':
    case 'goods':
    case 'potions':
    case 'boats':
    case 'keys':
    case 'deeds':
    case 'recycler':
    case 'oddities':
    case 'furniture':
      return 'shop';
    default: {
      const never: never = icon;
      return never;
    }
  }
}

export const LAIR_PATH =
  'M12 2.5c-4.7 0-8.5 3.4-8.5 7.8 0 2.6 1.3 4.6 3.3 5.9V19a1.5 1.5 0 0 0 1.5 1.5h7.4a1.5 1.5 0 0 0 1.5-1.5v-2.8c2-1.3 3.3-3.3 3.3-5.9 0-4.4-3.8-7.8-8.5-7.8Zm-3.3 6.8a1.9 1.9 0 1 0 0 3.8a1.9 1.9 0 1 0 0-3.8Zm6.6 0a1.9 1.9 0 1 0 0 3.8a1.9 1.9 0 1 0 0-3.8ZM10.2 16.6h1.2v2.4h-1.2Zm2.4 0h1.2v2.4h-1.2Z';
export const PLAYER_PATH =
  'M12 3a4.2 4.2 0 1 1 0 8.4a4.2 4.2 0 1 1 0-8.4Z M3.8 21c0-4.6 3.7-7.8 8.2-7.8s8.2 3.2 8.2 7.8Z';
export const DROP_PATH =
  'M12 2.5C12 2.5 5.5 10.2 5.5 14.6a6.5 6.5 0 0 0 13 0C18.5 10.2 12 2.5 12 2.5Z';
