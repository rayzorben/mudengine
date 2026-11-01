/**
 * The Room card's ways out: a compass of the ten directions with the room's
 * picture or a dot at its hub, and, in words, every exit the compass cannot
 * say alone (one with a note such as `closed door`, one that is no compass
 * direction). Unseen exits and a room with none are said as chips, never as
 * an empty compass. See `mudengine-ui` › `parts/cards.md`, *The Room card*.
 */
import { useMemo, type ReactNode } from 'react';

import { t } from '../lib/i18n';
import { exitsUnseen } from '../lib/room';
import Compass, { COMPASS_POINTS, type CompassPoint, type CompassWay } from './viz/Compass';
import { DIRECTION_NAME, type Direction } from '@shared/world';
import type { Room, RoomExit } from '@shared/character';

/** Compass order, so exits always read in the same sequence whatever order the server listed them in. */
const ORDER = ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw', 'u', 'd'];

export function sortExits(exits: readonly RoomExit[]): RoomExit[] {
  return [...exits].sort((a, b) => {
    const ai = ORDER.indexOf(a.direction);
    const bi = ORDER.indexOf(b.direction);
    return (ai === -1 ? ORDER.length : ai) - (bi === -1 ? ORDER.length : bi);
  });
}

/** An exit in words: the direction's name, and its note where it has one. */
export function exitWords(exit: RoomExit): string {
  const name = DIRECTION_NAME[exit.direction as Direction] ?? exit.direction;
  return exit.note ? `${name} (${exit.note})` : name;
}

function compassPoint(direction: string): CompassPoint | null {
  return (COMPASS_POINTS as readonly string[]).includes(direction)
    ? (direction as CompassPoint)
    : null;
}

/** The compass of the room's ways out, with `hub` in its middle (a dot where none is given). */
export default function ExitCompass({
  room,
  hub
}: {
  room: Pick<Room, 'exits' | 'light'>;
  /** What sits in the compass's middle: the room's picture, or nothing. */
  hub?: ReactNode;
}) {
  const unseen = exitsUnseen(room);
  const sorted = sortExits(room.exits);
  /*
   * Held by value: a status line hands the card a new room object with the
   * same exits, and a fresh list each time would redraw all ten tiles.
   */
  const key = unseen ? null : sorted.map(exitWords).join(', ');
  const ways = useMemo(
    (): CompassWay[] | null =>
      key === null
        ? null
        : sorted.flatMap((exit) => {
            const point = compassPoint(exit.direction);
            return point === null
              ? []
              : [{ point, state: exit.note ? 'noted' : 'open', title: exitWords(exit) }];
          }),
    // `sorted` is read only when `key`, its value, has changed.
    [key]
  );
  const label = t('cards.room.copy.exitsLine', { exitList: key ?? t('cards.room.exits.unseen') });
  return (
    <Compass label={label} ways={ways}>
      {hub}
    </Compass>
  );
}

/**
 * What the compass cannot say alone, in words: an exit with a note, one that
 * is no compass direction, and exits unseen or none. Null is not zero: exits
 * the server would not print are unseen, and `no exits` would be a claim
 * nothing supports.
 */
export function ExitNotes({ room }: { room: Pick<Room, 'exits' | 'light'> }) {
  const unseen = exitsUnseen(room);
  const spoken = sortExits(room.exits).filter(
    (exit) => exit.note || compassPoint(exit.direction) === null
  );
  if (!unseen && room.exits.length > 0 && spoken.length === 0) return null;
  /*
   * Small, a noted way is the compass's tinted tile, its note on the tile's
   * hover text; a way with no tile (no compass direction) is always said.
   */
  const tiled =
    !unseen &&
    room.exits.length > 0 &&
    spoken.every((exit) => compassPoint(exit.direction) !== null);
  return (
    <div className={tiled ? 'exits from-medium' : 'exits'}>
      {unseen ? (
        <span className="chip warn">{t('cards.room.exits.unseen')}</span>
      ) : room.exits.length === 0 ? (
        <span className="chip bad">{t('cards.room.exits.none')}</span>
      ) : (
        // A blocked exit is still an exit; saying why beats hiding it.
        spoken.map((exit) => (
          <span
            className={`chip${exit.note ? ' warn' : ''}`}
            key={exit.direction}
            title={exit.note ?? undefined}
          >
            {DIRECTION_NAME[exit.direction as Direction] ?? exit.direction}
            {exit.note && <span className="exit-note"> {exit.note}</span>}
          </span>
        ))
      )}
    </div>
  );
}
