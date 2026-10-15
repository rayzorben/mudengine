/**
 * The world map's theme pack (todo 140): `resources/world/<world>.theme.json`,
 * written by an AI pass over the world database, never by hand or a script.
 * It names the areas, their colours and motifs, the landmarks and each shop's
 * icon. Code only parses it here and draws it.
 *
 * An area claims rooms by map and number *and* name, so Paradigm's pack serves
 * MajorMUD's and a converted realm's rooms wherever they are the same room,
 * and nowhere else. A pack that fails to parse is reported and the map falls
 * back to the motif each room's name suggests (`guessMotif`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { contrast, isHexColour } from '../../shared/colour';
import {
  isMotif,
  isShopIcon,
  type AreaPalette,
  type MapArea,
  type ShopIcon
} from '../../shared/gameMap';
import { roomId, type RoomId, type WorldRoom } from '../../shared/world';
import { t } from '../app/i18n';

export const THEME_PACK_VERSION = 1;

/** The least contrast an area's label may have against its own tiles. */
export const GLOW_CONTRAST = 3;

/** The most rooms one range may claim: more than any map holds, so a typo cannot stall a load. */
export const RANGE_ROOMS = 20_000;

const PALETTE_KEYS = ['ground', 'edge', 'glow', 'path'] as const;

export interface ThemePack {
  readonly areas: readonly MapArea[];
  /** The area claiming this room, by number and name; null when none does. */
  areaOf(room: WorldRoom): number | null;
  /** The room's own label on the map, when the pass made it a landmark. */
  landmarkOf(room: WorldRoom): string | null;
  /** What a shop's icon is, by its row. */
  iconOf(shop: number): ShopIcon | null;
}

export const NO_THEME_PACK: ThemePack = {
  areas: [],
  areaOf: () => null,
  landmarkOf: () => null,
  iconOf: () => null
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isWhole = (value: unknown): value is number => Number.isInteger(value);

function readPalette(value: unknown, where: string): AreaPalette | string {
  if (!isObject(value)) return `${where}: palette is not an object`;
  for (const key of PALETTE_KEYS)
    if (!isHexColour(value[key])) return `${where}: palette.${key} is not #rrggbb`;
  const palette = value as unknown as AreaPalette;
  if (contrast(palette.glow, palette.ground) < GLOW_CONTRAST)
    return `${where}: glow on ground is under ${GLOW_CONTRAST}:1`;
  return { ground: palette.ground, edge: palette.edge, glow: palette.glow, path: palette.path };
}

/** The pack, or the first thing wrong with it. */
export function parseThemePack(raw: unknown): ThemePack | string {
  if (!isObject(raw)) return 'not an object';
  if (raw.v !== THEME_PACK_VERSION)
    return `version ${String(raw.v)}, expected ${THEME_PACK_VERSION}`;
  if (!Array.isArray(raw.areas)) return 'areas is not a list';

  const areas: MapArea[] = [];
  const ids = new Set<string>();
  /** Which areas claim a room, each with the names it claims it under. */
  const claims = new Map<RoomId, Array<{ area: number; names: ReadonlySet<string> }>>();
  for (const [index, entry] of raw.areas.entries()) {
    const where = `area ${index}`;
    if (!isObject(entry)) return `${where}: not an object`;
    const { id, name, motif, rooms, names } = entry;
    if (typeof id !== 'string' || id.length === 0) return `${where}: no id`;
    if (ids.has(id)) return `${where}: id ${id} twice`;
    ids.add(id);
    if (typeof name !== 'string' || name.trim().length === 0) return `${id}: no name`;
    if (!isMotif(motif)) return `${id}: unknown motif ${String(motif)}`;
    const palette = readPalette(entry.palette, id);
    if (typeof palette === 'string') return palette;
    if (!Array.isArray(names) || !names.every((n) => typeof n === 'string'))
      return `${id}: names is not a list of names`;
    if (!Array.isArray(rooms) || rooms.length === 0) return `${id}: no rooms`;
    const claimed = { area: areas.length, names: new Set(names as string[]) };
    for (const range of rooms) {
      if (!Array.isArray(range) || range.length !== 3 || !range.every(isWhole))
        return `${id}: a room range is not [map, from, to]`;
      const [map, from, to] = range as [number, number, number];
      if (to < from) return `${id}: room range ${map}/${from}-${to} runs backwards`;
      if (to - from >= RANGE_ROOMS)
        return `${id}: room range ${map}/${from}-${to} is over ${RANGE_ROOMS} rooms`;
      for (let room = from; room <= to; room += 1) {
        const key = roomId(map, room);
        const list = claims.get(key);
        if (list) list.push(claimed);
        else claims.set(key, [claimed]);
      }
    }
    areas.push({ id, name: name.trim(), motif, palette, named: true });
  }

  const areaOf = (room: WorldRoom): number | null =>
    claims.get(roomId(room.map, room.room))?.find((claim) => claim.names.has(room.name))?.area ??
    null;

  const landmarks = new Map<RoomId, string>();
  if (!Array.isArray(raw.landmarks)) return 'landmarks is not a list';
  for (const entry of raw.landmarks) {
    if (
      !Array.isArray(entry) ||
      !isWhole(entry[0]) ||
      !isWhole(entry[1]) ||
      typeof entry[2] !== 'string'
    )
      return 'a landmark is not [map, room, label]';
    const key = roomId(entry[0], entry[1]);
    if (!claims.has(key)) return `landmark ${key} is in no area`;
    landmarks.set(key, entry[2]);
  }

  const icons = new Map<number, ShopIcon>();
  if (!isObject(raw.shops)) return 'shops is not an object';
  for (const [shop, icon] of Object.entries(raw.shops)) {
    if (!isShopIcon(icon)) return `shop ${shop}: unknown icon ${String(icon)}`;
    icons.set(Number(shop), icon);
  }

  return {
    areas,
    areaOf,
    landmarkOf: (room) =>
      areaOf(room) === null ? null : (landmarks.get(roomId(room.map, room.room)) ?? null),
    iconOf: (shop) => icons.get(shop) ?? null
  };
}

/** The pack in `dir` for a world, or none with the reason said. */
export function loadThemePack(
  dir: string,
  file: string,
  notify?: (message: string) => void
): ThemePack {
  const full = path.join(dir, file);
  const refuse = (message: string): ThemePack => {
    notify?.(t('notices.world.themePack.readError', { file: full, message }));
    return NO_THEME_PACK;
  };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
  const pack = parseThemePack(raw);
  return typeof pack === 'string' ? refuse(pack) : pack;
}
