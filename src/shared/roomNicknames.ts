/**
 * MegaMUD's names for rooms, from its goto list (`ROOMS.md`), as the client
 * ships them in `resources/rooms/megamud.yaml` (`npm run build:rooms`). Each
 * names one realm room by the realm's own name and address, so a realm whose
 * room there is called something else keeps none of it
 * (`world/RoomNicknames.ts`). See `mudengine-world` › `parts/realm.md`.
 */
import { splitStop } from './loops';
import type { RoomReference } from './world';

export interface RoomNickname {
  /** MegaMUD's code for it, `VXDF`: what its goto list and `@goto` take. */
  code: string;
  /** MegaMUD's name for it, `Darkwood Forest Vortex`. */
  name: string;
  /** The realm room it was built against: the realm's name for it, and where it is. */
  room: { name: string; at: RoomReference };
  /** MegaMUD's "Stop before entering room": its boss rooms. */
  stopBefore: boolean;
  /** MegaMUD's "Avoid this room". */
  avoid: boolean;
  /** MegaMUD's "Hide in goto list": a fork or a waypoint, found by its code only. */
  hidden: boolean;
  /** The level range MegaMUD records for it; null where it records none. */
  minLevel: number | null;
  maxLevel: number | null;
}

/** A code, case ignored: `vxdf` is `VXDF`. */
export const codeKey = (code: string): string => code.trim().toUpperCase();

const CODE = /^[^\s:]{1,8}$/;

/**
 * The entries of a parsed `rooms:` list that are whole, in order. An entry
 * missing its code, name or `Name map/room` is left out rather than guessed at,
 * and so is a code met again (case ignored), which `repeated` hears: the first
 * keeps it, since a code names one room.
 */
export function asRoomNicknames(
  value: unknown,
  repeated: (code: string) => void = () => undefined
): RoomNickname[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry: unknown): RoomNickname[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const { code, name, room } = row;
    if (typeof code !== 'string' || !CODE.test(code)) return [];
    if (typeof name !== 'string' || name.trim().length === 0) return [];
    if (typeof room !== 'string') return [];
    const stop = splitStop({ room });
    if (stop.at === null || stop.name.length === 0) return [];
    if (seen.has(codeKey(code))) {
      repeated(code);
      return [];
    }
    seen.add(codeKey(code));
    return [
      {
        code,
        name: name.trim(),
        room: { name: stop.name, at: stop.at },
        stopBefore: row['stopBefore'] === true,
        avoid: row['avoid'] === true,
        hidden: row['hidden'] === true,
        minLevel: level(row['minLevel']),
        maxLevel: level(row['maxLevel'])
      }
    ];
  });
}

const level = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
