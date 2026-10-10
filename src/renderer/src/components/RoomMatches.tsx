/**
 * The rooms a room search found, as the list under its field: the rooms walked
 * to before under *Recent*, newest first and saying when, then the realm's
 * other rooms (user, 2026-10-10). Main orders them so (`Invoke.searchRooms`);
 * the route panel, the Map card's fields and the loop builder all draw this.
 */
import type { ReactNode } from 'react';

import type { ListNavigation } from '../hooks/useListNavigation';
import { t } from '../lib/i18n';
import { foundRoomHint } from '../lib/visited';
import { wasVisited, type FoundRoom } from '@shared/destinations';

export interface RoomMatchesProps {
  className: string;
  matches: FoundRoom[];
  list: ListNavigation<FoundRoom>;
  onChoose(room: FoundRoom): void;
  /** Drawn as the one row when nothing matched. */
  empty?: ReactNode;
}

export default function RoomMatches({
  className,
  matches,
  list,
  onChoose,
  empty
}: RoomMatchesProps) {
  const now = Date.now();
  const recent = matches.some(wasVisited);
  /* A heading opens each group, once any room listed was walked to before. */
  const heading = (room: FoundRoom, index: number): ReactNode => {
    const opens = index === 0 || (!wasVisited(room) && wasVisited(matches[index - 1]!));
    if (!recent || !opens) return null;
    return groupLabel(wasVisited(room) ? 'recent' : 'others');
  };
  return (
    <ul className={className} ref={list.listRef}>
      {matches.length === 0
        ? empty
        : matches.flatMap((room, index) => [
            heading(room, index),
            <li
              data-active={list.isActive(index) ? 'true' : 'false'}
              data-visited={wasVisited(room) ? 'true' : undefined}
              key={`${room.map}/${room.room}`}
              {...list.hover(index)}
            >
              <button
                onClick={() => onChoose(room)}
                // The list is driven from the field, which keeps the caret:
                // clicking a room must not move focus out of it.
                onMouseDown={(event) => event.preventDefault()}
                type="button"
              >
                <span>{room.name}</span>
                <span className="hint">{foundRoomHint(room, now)}</span>
              </button>
            </li>
          ])}
    </ul>
  );
}

function groupLabel(group: 'recent' | 'others'): ReactNode {
  return (
    <li
      className="room-matches-group"
      data-group={group}
      key={`group:${group}`}
      role="presentation"
    >
      {group === 'recent' ? t('rooms.groups.recent') : t('rooms.groups.others')}
    </li>
  );
}
