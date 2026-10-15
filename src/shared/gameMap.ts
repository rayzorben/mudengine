/**
 * The game view's world map (todo 140): what main sends the renderer to draw.
 *
 * Every room of a map sits on one plane, laid out once per map in main
 * (`world/realmLayout.ts`). Its look comes from the world's theme pack
 * (`resources/world/<world>.theme.json`, written by an AI pass over the world
 * database), and a room the pack does not cover takes the motif its name
 * suggests (`guessMotif`). Reasons: `mudengine-world` › *The game view's map*.
 */
import type { MapCell } from './map';
import type { Direction, RoomId } from './world';

/** What each tile carries as its small drawing. Runtime list beside the type. */
export const MOTIFS = [
  'town',
  'road',
  'forest',
  'field',
  'farm',
  'garden',
  'grave',
  'cave',
  'mine',
  'sewer',
  'dungeon',
  'castle',
  'temple',
  'building',
  'swamp',
  'hills',
  'mountain',
  'desert',
  'beach',
  'water',
  'snow',
  'jungle',
  'ruins',
  'fire',
  'astral',
  'bridge',
  'ship',
  'tower'
] as const;
export type Motif = (typeof MOTIFS)[number];

export function isMotif(value: unknown): value is Motif {
  return typeof value === 'string' && (MOTIFS as readonly string[]).includes(value);
}

/** What a place's icon says it is or sells. Runtime list beside the type. */
export const SHOP_ICONS = [
  'bank',
  'temple',
  'tavern',
  'inn',
  'trainer',
  'weapons',
  'bows',
  'armour',
  'shields',
  'clothing',
  'magic',
  'songs',
  'jewels',
  'goods',
  'potions',
  'food',
  'boats',
  'keys',
  'deeds',
  'recycler',
  'oddities',
  'furniture',
  'guild'
] as const;
export type ShopIcon = (typeof SHOP_ICONS)[number];

export function isShopIcon(value: unknown): value is ShopIcon {
  return typeof value === 'string' && (SHOP_ICONS as readonly string[]).includes(value);
}

/** A plane cell's key, for looking a room up by where it sits. */
export const cellKey = (gx: number, gy: number): string => `${gx},${gy}`;

/** Where the game view's console sits when it is open. Runtime list beside the type. */
export const GAME_DOCKS = ['bottom', 'float', 'left', 'right'] as const;
export type GameDock = (typeof GAME_DOCKS)[number];

export function isGameDock(value: unknown): value is GameDock {
  return typeof value === 'string' && (GAME_DOCKS as readonly string[]).includes(value);
}

/** An area's four colours, as `#rrggbb`. */
export interface AreaPalette {
  /** The tile fill: dark, carrying the place's hue. */
  ground: string;
  /** The tile outline and its motif drawing. */
  edge: string;
  /** The area's label and highlights. */
  glow: string;
  /** The corridors between its rooms. */
  path: string;
}

export interface MapArea {
  id: string;
  name: string;
  motif: Motif;
  palette: AreaPalette;
  /** False for an area guessed from a room's name, with no name of its own to show. */
  named: boolean;
}

/** One room on the plane. `gx`/`gy` are the map's own plane coordinates, not the centre's. */
export interface GameCell extends MapCell {
  /** Index into `GameMapWindow.areas`. */
  area: number;
  /** What the place is or sells, when it is one. */
  icon?: ShopIcon;
  /** The realm records the room as dark. */
  dark?: true;
  /**
   * Where each exit leads, for the exits the grid cannot join to a neighbour.
   * An exit whose cast scatters is absent: it reaches no particular room.
   */
  to: Partial<Record<Direction, RoomId>>;
  /** The room's name is labelled on its own: no other room of its stretch shares it. */
  named?: true;
}

export type MapLabelKind = 'area' | 'stretch' | 'landmark';

export interface MapLabel {
  kind: MapLabelKind;
  text: string;
  gx: number;
  gy: number;
  /** Index into `GameMapWindow.areas`, for the label's colour. */
  area: number;
}

/** Where on the plane to look: around a room, or around a point once the map is dragged. */
export type GameMapAsk =
  | { kind: 'room'; map: number; room: number; half: number }
  | { kind: 'point'; map: number; gx: number; gy: number; half: number };

export interface GameMapWindow {
  map: number | null;
  /** The asked room's place on the plane; null when it was not asked or is not on it. */
  centre: { room: RoomId; gx: number; gy: number } | null;
  /** The square of the plane the window covers, inclusive. */
  box: { x0: number; y0: number; x1: number; y1: number };
  cells: GameCell[];
  areas: MapArea[];
  labels: MapLabel[];
}

export const EMPTY_GAME_MAP: GameMapWindow = {
  map: null,
  centre: null,
  box: { x0: 0, y0: 0, x1: -1, y1: -1 },
  cells: [],
  areas: [],
  labels: []
};

/**
 * The motif a room's name suggests, for a room no theme pack covers.
 *
 * The prototype's terrain guess (todo 140), widened to every motif. First
 * match wins, so the narrower words come before the broader ones.
 */
const GUESSES: ReadonlyArray<readonly [RegExp, Motif]> = [
  [/sewer|drain|culvert/i, 'sewer'],
  [/mine|shaft|quarry|ore\b/i, 'mine'],
  [/cave|cavern|tunnel|grotto|burrow|lair|underground|chasm/i, 'cave'],
  [/crypt|tomb|grave|cemetery|mausoleum|barrow|catacomb/i, 'grave'],
  [/dungeon|cell\b|prison|jail|torture|oubliette/i, 'dungeon'],
  [/temple|shrine|chapel|church|cathedral|monastery|altar|abbey/i, 'temple'],
  [/castle|fort|keep|citadel|bailey|rampart|battlement|stronghold|palace|throne/i, 'castle'],
  [/tower|spire|turret/i, 'tower'],
  [/ruin|rubble|crumbl/i, 'ruins'],
  [/bridge/i, 'bridge'],
  [/ship|deck|hold\b|galley|boat|cabin/i, 'ship'],
  [/river|lake|sea\b|ocean|stream|pool|water|underwater|harbour|harbor|dock|pier/i, 'water'],
  [/beach|shore|coast|sand dune/i, 'beach'],
  [/swamp|marsh|bog|fen|mire/i, 'swamp'],
  [/desert|dune|waste|badland/i, 'desert'],
  [/snow|ice|glacier|frozen|tundra|frost/i, 'snow'],
  [/lava|volcan|magma|fire|flame|inferno|burning|ash/i, 'fire'],
  [/plane|astral|void|ether|dream|limbo|abyss|nexus/i, 'astral'],
  [/jungle|rainforest/i, 'jungle'],
  [/mountain|peak|cliff|crag|pass\b|summit|ridge/i, 'mountain'],
  [/hill|highland|moor|downs/i, 'hills'],
  [/forest|wood|grove|thicket|glade|copse|trees/i, 'forest'],
  [/orchard|garden|park/i, 'garden'],
  [/farm|barn|pasture|cottage|mill\b|stable|field/i, 'farm'],
  [/plain|meadow|grass|prairie|steppe/i, 'field'],
  [/road|path|trail|track|highway|way\b/i, 'road'],
  [/street|alley|square|lane|avenue|market|gate|intersection/i, 'town'],
  [/shop|store|inn\b|tavern|hall|room|house|guild|bank|manor|chamber|office|library/i, 'building']
];

export function guessMotif(name: string): Motif {
  for (const [pattern, motif] of GUESSES) if (pattern.test(name)) return motif;
  return 'town';
}

/** The colours a guessed area wears, one set per motif. */
export const MOTIF_PALETTES: Record<Motif, AreaPalette> = {
  town: { ground: '#1a1f27', edge: '#3a4658', glow: '#8fb2e8', path: '#262d38' },
  road: { ground: '#272219', edge: '#5d513c', glow: '#b08d4f', path: '#3a3226' },
  forest: { ground: '#14251a', edge: '#2c5238', glow: '#3f8a57', path: '#24382a' },
  field: { ground: '#28261a', edge: '#5e5a35', glow: '#b9a95a', path: '#3a3724' },
  farm: { ground: '#2a2416', edge: '#665632', glow: '#c9a35a', path: '#3d3421' },
  garden: { ground: '#162a22', edge: '#356f53', glow: '#5fd19b', path: '#233b30' },
  grave: { ground: '#1c1b25', edge: '#46435c', glow: '#8a80c8', path: '#2a2836' },
  cave: { ground: '#1d1b1a', edge: '#4a4440', glow: '#a8998b', path: '#2c2927' },
  mine: { ground: '#221c17', edge: '#5a4634', glow: '#c08a5a', path: '#33291f' },
  sewer: { ground: '#1b1f15', edge: '#454f30', glow: '#93a85a', path: '#282e1e' },
  dungeon: { ground: '#1e1718', edge: '#4f3a3c', glow: '#c27a80', path: '#2d2223' },
  castle: { ground: '#1d1f24', edge: '#4a505e', glow: '#a9b4cc', path: '#2b2e35' },
  temple: { ground: '#221d28', edge: '#584a68', glow: '#d8b4fe', path: '#322a3b' },
  building: { ground: '#221e1a', edge: '#55493d', glow: '#c9a982', path: '#322c26' },
  swamp: { ground: '#18201a', edge: '#3a5040', glow: '#7aa36a', path: '#232e25' },
  hills: { ground: '#1e2416', edge: '#4c5c34', glow: '#a3be6a', path: '#2c3520' },
  mountain: { ground: '#1f2124', edge: '#50555e', glow: '#b8c0cc', path: '#2e3136' },
  desert: { ground: '#2b2414', edge: '#6e5a2e', glow: '#e0b65a', path: '#3f351e' },
  beach: { ground: '#28251a', edge: '#6a603e', glow: '#e6d18a', path: '#3b3626' },
  water: { ground: '#121f2b', edge: '#2b4f6e', glow: '#5fb0e8', path: '#1c2e3f' },
  snow: { ground: '#1b2329', edge: '#4a6070', glow: '#cfe6f5', path: '#28333c' },
  jungle: { ground: '#112617', edge: '#2a6038', glow: '#4cc46a', path: '#1b3a23' },
  ruins: { ground: '#21201c', edge: '#565246', glow: '#b5ad92', path: '#302f29' },
  fire: { ground: '#2a1512', edge: '#6e2e24', glow: '#f2704a', path: '#3d1f1a' },
  astral: { ground: '#1c1530', edge: '#4a3a7a', glow: '#b39cf5', path: '#2a2045' },
  bridge: { ground: '#24201b', edge: '#5e5242', glow: '#c4a880', path: '#352f27' },
  ship: { ground: '#1f1c17', edge: '#57483a', glow: '#c99a6a', path: '#2e2922' },
  tower: { ground: '#1f1d26', edge: '#4f4a66', glow: '#b0a6e0', path: '#2d2a38' }
};

const isWhole = (value: unknown): value is number => Number.isInteger(value);

/** A window request off the wire: the typed ask, or null. */
export function asGameMapAsk(value: unknown): GameMapAsk | null {
  if (typeof value !== 'object' || value === null) return null;
  const ask = value as Record<string, unknown>;
  if (!isWhole(ask.map) || !isWhole(ask.half) || (ask.half as number) < 1) return null;
  const map = ask.map as number;
  const half = ask.half as number;
  if (ask.kind === 'room' && isWhole(ask.room))
    return { kind: 'room', map, room: ask.room as number, half };
  if (ask.kind === 'point' && isWhole(ask.gx) && isWhole(ask.gy))
    return { kind: 'point', map, gx: ask.gx as number, gy: ask.gy as number, half };
  return null;
}
