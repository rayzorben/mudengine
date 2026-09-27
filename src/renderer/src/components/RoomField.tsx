/**
 * A field that finds a room by name or by `map/room` and holds the one
 * picked. Typing searches the realm's index (`useRoomSearch`); the matches
 * open over whatever is under the field, so the card below does not move.
 * The Map card's route preview has two, a start and a destination.
 */
import { memo, useState } from 'react';

import ClearField from './ClearField';
import { useListNavigation } from '../hooks/useListNavigation';
import { useRoomSearch } from '../hooks/useRoomSearch';
import type { PickedRoom } from '../hooks/useRoutePreview';
import { roomId, type WorldRoom } from '@shared/world';

export interface RoomFieldProps {
  label: string;
  placeholder: string;
  picked: PickedRoom | null;
  onPick(room: PickedRoom | null): void;
  search(query: string): Promise<WorldRoom[]>;
  /** Where the caret goes once a room is picked or the field is left. */
  onDone?: () => void;
}

function RoomField({ label, placeholder, picked, onPick, search, onDone }: RoomFieldProps) {
  const [query, setQuery] = useState('');
  const { matches, failed } = useRoomSearch(search, query);
  const choose = (room: WorldRoom): void => {
    onPick({ id: roomId(room.map, room.room), name: room.name });
    setQuery('');
    onDone?.();
  };
  const list = useListNavigation<WorldRoom>({
    items: matches,
    onChoose: choose,
    onCancel: () => {
      setQuery('');
      onDone?.();
    }
  });
  const value = picked === null ? query : `${picked.id} ${picked.name}`;

  return (
    <div className="room-field">
      <ClearField
        label={label}
        onClear={() => {
          setQuery('');
          onPick(null);
        }}
        query={value}
      >
        <input
          aria-label={label}
          onChange={(event) => {
            if (picked !== null) onPick(null);
            setQuery(event.target.value);
          }}
          onFocus={(event) => event.target.select()}
          onKeyDown={list.onKeyDown}
          placeholder={placeholder}
          spellCheck={false}
          title={failed ?? undefined}
          value={value}
        />
      </ClearField>
      {matches.length > 0 && (
        <ul className="route-matches room-field-matches" ref={list.listRef}>
          {matches.map((room, index) => (
            <li
              data-active={list.isActive(index) ? 'true' : 'false'}
              key={`${room.map}/${room.room}`}
              onMouseEnter={() => list.point(index)}
            >
              <button
                onClick={() => choose(room)}
                onMouseDown={(event) => event.preventDefault()}
                type="button"
              >
                <span>{room.name}</span>
                <span className="hint">
                  {room.map}/{room.room}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default memo(RoomField);
