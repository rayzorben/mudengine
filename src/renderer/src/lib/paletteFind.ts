/**
 * What a typed palette query reaches past the client's own commands: the
 * rooms it names (*Go to*), then what the realm knows by it (*In the realm*),
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
import { ago } from './players';
import type { PopoverAnchor } from './popover';
import { entryNumber, entryWord, flattenLookup } from './reference';
import { tuning } from './tuning';
import { entityNumber } from '@shared/entities';
import type { IpcApi, SessionId } from '@shared/ipc';
import { roomId, type WorldRoom } from '@shared/world';

export interface PaletteFindDeps {
  api: Pick<IpcApi, 'searchRooms' | 'routeTo' | 'walkRoute' | 'lookup'>;
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
 * **This is the one path that walks without the plan being read first**, and
 * it is deliberate rather than an oversight of the rule the map click keeps.
 * The difference is what was chosen: a map click is a click on a picture, and
 * the easiest possible way to send a character somewhere by accident; this
 * row was typed, read and picked out of a list that names the room and its
 * reference. What cannot be walked still opens the panel — a blocked route
 * has conditions to read, and a refusal has a reason — so nothing silently
 * fails, and stopping is a keystroke away either way.
 *
 * The rows are `transient`: they exist for as long as the query, and a shelf
 * entry naming one would be a row nobody could reach from the shelf.
 */
export async function roomRows(query: string, deps: PaletteFindDeps): Promise<Command[]> {
  const { api, session, openRouteOn } = deps;
  const rooms = await api.searchRooms(session, query);
  const now = Date.now();
  return rooms.map((room) => ({
    id: `goto:${roomId(room.map, room.room)}`,
    icon: 'route' as const,
    transient: true,
    label: t('palette.navigate.gotoLabel', { roomName: room.name }),
    /*
     * A room already walked to says so, and says when.
     *
     * Main puts the recent ones on top; without the hint saying which they
     * are, the reordering is invisible and reads as the realm answering in
     * a different order each time. The id stays on the row either way --
     * it is how two rooms of the same name are told apart, and dropping it
     * for the very rows most likely to be duplicates would be backwards.
     */
    hint:
      room.visitedAt === null
        ? roomId(room.map, room.room)
        : t('palette.navigate.gotoVisitedHint', {
            roomReference: roomId(room.map, room.room),
            agoText: ago(room.visitedAt, now)
          }),
    run: () => {
      void api
        .routeTo(session, room.map, room.room)
        .then(async (route) => {
          // Nothing to walk, or nothing that *can* be walked: the panel is
          // where a blocked route states its conditions and where a room
          // already stood in says so. Opening it is the honest answer, and
          // it is the same surface every other room click reaches.
          if (route.blocked || route.steps.length === 0) return route;
          // And a way through what the player keeps out of: the panel is
          // where the way through and the way round are chosen between.
          if (route.keptOut !== undefined) return route;
          /*
           * The plan was drawn from here a moment ago, so main has nothing
           * to redraw — but if the character moved in that moment it comes
           * back redrawn, and the panel is where a plan is read. Opening it
           * plans afresh from here, which is the same answer arrived at by
           * the surface that exists to show one.
           */
          const answer = await api.walkRoute(session, route);
          return 'started' in answer ? null : route;
        })
        .then((unwalked) => {
          if (unwalked === null) return;
          openRouteOn(room, null);
        })
        .catch(() => {
          // A route that could not be planned at all: the panel says why,
          // rather than a click that does nothing.
          openRouteOn(room, null);
        });
    }
  }));
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

/** Both answers to a typed query, rooms first: Enter on a room query means what it did. */
export async function paletteFind(query: string, deps: PaletteFindDeps): Promise<Found[]> {
  const [rooms, realm] = await Promise.all([roomRows(query, deps), realmRows(query, deps)]);
  return [
    { key: 'rooms', label: t('palette.groups.found'), items: rooms },
    { key: 'realm', label: t('palette.groups.realm'), items: realm }
  ];
}
