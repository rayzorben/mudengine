/**
 * What a typed palette query reaches past the client's own commands: the
 * nearest places of a kind it names (*Nearest*, `nearestRows`), the
 * rooms it names (*Recent* for those walked to before, then *Go to*), then
 * what the realm knows by it (*In the realm*),
 * as headed `Found` blocks of `transient` rows, addressed at the shown
 * character. Functions of the bridge they are handed, so a test drives them
 * without rendering; a row reads the clock for its hint, and the window only when
 * a hotkey runs it with no box to open beside.
 *
 * Out of `App` (todo 733). See `mudengine-ui` › `parts/input.md`, *A typed
 * query reaches the realm's population; the shelf never does*.
 */
import type { Command, Found } from '../components/CommandPalette';
import type { IconName } from '../components/Icon';
import { t } from './i18n';
import type { PopoverAnchor } from './popover';
import { entryNumber, entryWord, flattenLookup } from './reference';
import { tuning } from './tuning';
import { nearestRows } from './nearestRows';
import { foundRoomHint } from './visited';
import { nicknamedLabel, withMarks } from './nicknames';
import { walkTo } from './walkTo';
import { wasVisited, type FoundRoom } from '@shared/destinations';
import { entityNumber } from '@shared/entities';
import type { IpcApi, SessionId } from '@shared/ipc';
import { roomId, type WorldRoom } from '@shared/world';

export interface PaletteFindDeps {
  api: Pick<IpcApi, 'searchRooms' | 'routeTo' | 'walkRoute' | 'lookup' | 'nearestPlaces'>;
  /** The character on screen, whose realm is asked. */
  session: SessionId;
  /** The route panel, on a room. */
  openRouteOn(room: WorldRoom, search: null): void;
  /** The quick view a clicked name opens, beside where the palette stood. */
  inspect(name: string, anchor: PopoverAnchor): void;
}

/**
 * Every room the palette's query reaches, as rows that walk there.
 *
 * The palette used to search one flat list of the client's own commands, so
 * the one thing somebody types a place name into a search box wanting — to go
 * there — was the one thing it could not answer. `Ctrl/Cmd K`, `1 297` or
 * `bank of god`, Enter, and the character is walking.
 *
 * This and the console's menu (`walkTo`) walk without the plan being read
 * first. A map click is a click on a picture and is easy to make by accident;
 * these rows were typed or picked from a list that names the room and its
 * reference. What cannot be walked still opens the panel, since a blocked
 * route has conditions to read and a refusal has a reason, and stopping is a
 * keystroke away either way.
 *
 * The rows are `transient`: they exist for as long as the query, and a shelf
 * entry naming one would be a row nobody could reach from the shelf.
 */
export async function roomRows(
  query: string,
  deps: PaletteFindDeps
): Promise<{ recent: Command[]; others: Command[] }> {
  const rooms = await deps.api.searchRooms(deps.session, query);
  const now = Date.now();
  const rows = (visited: boolean): Command[] =>
    rooms.filter((room) => wasVisited(room) === visited).map((room) => roomRow(room, deps, now));
  return { recent: rows(true), others: rows(false) };
}

function roomRow(room: FoundRoom, deps: PaletteFindDeps, now: number): Command {
  return {
    id: `goto:${roomId(room.map, room.room)}`,
    icon: 'route' as const,
    transient: true,
    label: t('palette.navigate.gotoLabel', { roomName: nicknamedLabel(room) }),
    /*
     * A room already walked to says so, and says when.
     *
     * Main puts the recent ones on top; without the hint saying which they
     * are, the reordering is invisible and reads as the realm answering in
     * a different order each time. The id stays on the row either way --
     * it is how two rooms of the same name are told apart, and dropping it
     * for the very rows most likely to be duplicates would be backwards.
     */
    hint: withMarks(foundRoomHint(room, now), room.nickname),
    run: () => walkTo(room, deps)
  };
}

/**
 * What the realm knows by a name typed into the palette: a monster, an item,
 * a spell, offered as rows that open the same quick view a clicked name does.
 *
 * The palette lists commands and never the realm's population — but that
 * rule is about the *shelf*: a row per monster while browsing is a wall. A
 * typed query is a different question, and these rows exist only for as
 * long as it does (`transient`), under their own heading below the rooms.
 * Choosing one puts the panel where the palette stood, because the name it
 * answers for was never drawn anywhere else on screen.
 */
export async function realmRows(query: string, deps: PaletteFindDeps): Promise<Command[]> {
  const { api, session, inspect } = deps;
  const entries = flattenLookup(await api.lookup(session, query));
  return entries.slice(0, tuning().paletteFoundRows).map((entry, index) => {
    const kindWord = entryWord(entry);
    const number = entityNumber(entryNumber(entry));
    const icon: IconName =
      entry.kind === 'mob'
        ? 'sword'
        : entry.kind === 'spell'
          ? 'bolt'
          : entry.kind === 'item'
            ? 'bag'
            : 'users';
    return {
      // Position, not name: the realm holds two `maelstrom` rows and four
      // `void sphere` rows, and a keyed list handed a duplicate keeps a corpse.
      id: `lookup:${entry.kind}:${index}`,
      icon,
      transient: true,
      label: t('palette.navigate.lookupLabel', { name: entry.name }),
      hint:
        number === null
          ? kindWord
          : t('palette.navigate.lookupNumberHint', { kindWord, number: String(number) }),
      run: (from?: PopoverAnchor) => {
        // A hotkey has no box to hand over; the palette always does.
        inspect(
          entry.name,
          from ?? {
            box: {
              top: 0,
              right: window.innerWidth / 2,
              bottom: 0,
              left: window.innerWidth / 2
            },
            within: document.body
          }
        );
      }
    };
  });
}

/**
 * Every answer to a typed query. *Nearest* goes first: `bank` typed is a
 * place wanted, and a query naming no kind leaves it empty, so Enter on a
 * room query means what it did.
 */
export async function paletteFind(query: string, deps: PaletteFindDeps): Promise<Found[]> {
  const [nearest, rooms, realm] = await Promise.all([
    nearestRows(query, deps),
    roomRows(query, deps),
    realmRows(query, deps)
  ]);
  return [
    { key: 'nearest', label: t('palette.groups.nearest'), items: nearest },
    { key: 'recent', label: t('rooms.groups.recent'), items: rooms.recent },
    { key: 'rooms', label: t('palette.groups.found'), items: rooms.others },
    { key: 'realm', label: t('palette.groups.realm'), items: realm }
  ];
}
