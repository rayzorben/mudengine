/**
 * The palette's *Nearest* rows (todo 70): a query that names a kind of place,
 * `bank`, `trainer`, `armour`, answered with the places of that kind this
 * character can use, fewest moves first, each walked to as a *Goto* row is.
 * Transient like the other found rows. See `mudengine-ui` › `parts/input.md`.
 */
import type { Command } from '../components/CommandPalette';
import { t } from './i18n';
import { tuning } from './tuning';
import { walkTo, type WalkToDeps } from './walkTo';
import type { IpcApi } from '@shared/ipc';
import { PLACE_KINDS, type NearPlace, type PlaceKind } from '@shared/places';
import { roomId } from '@shared/world';

/** What a player types for each kind; the first is the kind's own word. Keywords stay in code. */
const PLACE_WORDS: Readonly<Record<PlaceKind, readonly string[]>> = {
  weapons: ['weapons', 'weaponsmith', 'smith', 'sword'],
  armour: ['armour', 'armor', 'armourer', 'armorer'],
  trainer: ['trainer', 'training', 'train', 'level'],
  bank: ['bank', 'vault'],
  temple: ['temple', 'healer', 'heal'],
  tavern: ['tavern', 'inn', 'pub']
};

/** Fewer letters name nothing, so `a` asks main for nothing; `inn` and `pub` are three. */
const LEAST_LETTERS = 3;

/**
 * The kinds a query names: the start of one of a kind's words, after an
 * optional `nearest`. `bank of godfrey` names none, so a room typed by name
 * stays a room query.
 */
export function placeKindsIn(query: string): PlaceKind[] {
  const asked = query
    .trim()
    .toLowerCase()
    .replace(/^nearest\s+/, '');
  if (asked.length < LEAST_LETTERS) return [];
  return PLACE_KINDS.filter((kind) => PLACE_WORDS[kind].some((word) => word.startsWith(asked)));
}

export interface NearestDeps extends WalkToDeps {
  api: WalkToDeps['api'] & Pick<IpcApi, 'nearestPlaces'>;
}

/** Each named kind's nearest places, as rows that walk there. */
export async function nearestRows(query: string, deps: NearestDeps): Promise<Command[]> {
  const kinds = placeKindsIn(query);
  const answers = await Promise.all(
    kinds.map((kind) => deps.api.nearestPlaces(deps.session, kind))
  );
  return answers.flatMap((places) =>
    places.slice(0, tuning().paletteFoundRows).map((place) => nearestRow(place, deps))
  );
}

function nearestRow(place: NearPlace, deps: NearestDeps): Command {
  const reference = roomId(place.room.map, place.room.room);
  return {
    // The row and the room: a trainer row placed in two rooms is two rows.
    id: `nearest:${place.kind}:${place.shop}:${reference}`,
    icon: 'route' as const,
    transient: true,
    label: t('palette.navigate.nearestLabel', { name: place.name, roomName: place.room.name }),
    hint:
      place.moves === 1
        ? t('palette.navigate.nearestHint.one', { moves: String(place.moves), reference })
        : t('palette.navigate.nearestHint.many', { moves: String(place.moves), reference }),
    run: () => walkTo(place.room, deps)
  };
}
