/**
 * A field that finds a room by name or by `map/room` and holds the one
 * picked. Typing searches the realm's index (`useRoomSearch`); the matches
 * open over whatever is under the field, so the card below does not move.
 * Focused and empty, it lists the latest rooms walked to.
 * The Map card's route preview has two, a start and a destination.
 */
import { memo, useState } from 'react';

import ClearField from './ClearField';
import RoomMatches from './RoomMatches';
import { useListNavigation } from '../hooks/useListNavigation';
import { useRoomSearch } from '../hooks/useRoomSearch';
import type { PickedRoom } from '../hooks/useRoutePreview';
import type { FoundRoom } from '@shared/destinations';
import { roomId } from '@shared/world';

export interface RoomFieldProps {
  label: string;
  placeholder: string;
  picked: PickedRoom | null;
  onPick(room: PickedRoom | null): void;
  search(query: string): Promise<FoundRoom[]>;
  /** Where the caret goes once a room is picked or the field is left. */
  onDone?: () => void;
  /** Take the caret when drawn, for a field opened by a press elsewhere. */
  autoFocus?: boolean;
}

function RoomField({
  label,
  placeholder,
  picked,
  onPick,
  search,
  onDone,
  autoFocus
}: RoomFieldProps) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const { matches, failed } = useRoomSearch(search, query, focused && picked === null);
  const choose = (room: FoundRoom): void => {
    onPick({ id: roomId(room.map, room.room), name: room.name });
    setQuery('');
    onDone?.();
  };
  const list = useListNavigation<FoundRoom>({
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
          autoFocus={autoFocus}
          onChange={(event) => {
            if (picked !== null) onPick(null);
            setQuery(event.target.value);
          }}
          onBlur={() => setFocused(false)}
          onFocus={(event) => {
            setFocused(true);
            event.target.select();
          }}
          onKeyDown={list.onKeyDown}
          placeholder={placeholder}
          spellCheck={false}
          title={failed ?? undefined}
          value={value}
        />
      </ClearField>
      {matches.length > 0 && (
        <RoomMatches
          className="route-matches room-field-matches"
          list={list}
          matches={matches}
          onChoose={choose}
        />
      )}
    </div>
  );
}

export default memo(RoomField);
