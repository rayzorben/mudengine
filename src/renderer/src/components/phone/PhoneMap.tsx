/**
 * The Map tab and its Go to: the search field first, the rooms it finds under
 * it (the rooms walked to before, then the realm's), the neighbourhood the
 * character is in, and a pad for single steps. A name several rooms share lists
 * every one with its address; none is picked for the player. Walking is
 * `walkTo`, through the one navigation engine.
 */
import { memo, useMemo, useState } from 'react';

import type { CharacterState } from '@shared/character';
import type { FoundRoom } from '@shared/destinations';
import type { MapLoader } from '@shared/map';
import { roomAddress, type WorldRoom } from '@shared/world';
import { useRoomSearch } from '../../hooks/useRoomSearch';
import { t } from '../../lib/i18n';
import { tuning } from '../../lib/tuning';
import MapView from '../MapView';

/** Matches listed at once: a phone reads a screenful, and the field narrows the rest. */
const RESULTS = 12;
/** The directions the pad steps, the world database's own short forms. */
const PAD = ['n', 'w', 'e', 's'] as const;

export interface PhoneMapProps {
  character: CharacterState;
  load: MapLoader;
  search(query: string): Promise<FoundRoom[]>;
  goTo(room: WorldRoom): void;
  step(direction: string): void;
  /** Takes the keyboard off the search field once a room is chosen. */
  onChosen(): void;
}

function PhoneMap({ character, load, search, goTo, step, onChosen }: PhoneMapProps) {
  const [query, setQuery] = useState('');
  const [zoom, setZoom] = useState(() => tuning().mapRoomPixelsSparse);
  const { matches, failed } = useRoomSearch(search, query, true);
  const here = roomAddress(character.room);
  const empty = useMemo(
    () => (
      <div className="phone-quiet">
        {here === null ? t('phone.map.noLocation') : t('phone.map.noData')}
      </div>
    ),
    [here]
  );
  return (
    <div className="phone-map">
      <input
        aria-label={t('phone.map.goAria')}
        className="phone-glass phone-find"
        enterKeyHint="go"
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('phone.map.goTo')}
        type="search"
        value={query}
      />
      {failed !== null && <p className="phone-quiet">{failed}</p>}
      <ul className="phone-found">
        {matches.slice(0, RESULTS).map((found) => (
          <li className="phone-glass phone-row" key={`${found.map}/${found.room}`}>
            <div>
              <b>{found.name}</b>
              <small>{`${found.map}/${found.room}`}</small>
            </div>
            <button
              onClick={() => {
                goTo(found);
                onChosen();
              }}
              type="button"
            >
              {t('phone.map.go')}
            </button>
          </li>
        ))}
      </ul>
      <div className="phone-map-view">
        <MapView
          centre={here}
          empty={empty}
          load={load}
          name="phone"
          onZoom={setZoom}
          zoom={zoom}
        />
      </div>
      <div className="phone-pad" role="group" aria-label={t('phone.map.padAria')}>
        {PAD.map((direction) => (
          <button
            data-direction={direction}
            key={direction}
            onClick={() => step(direction)}
            type="button"
          >
            {direction}
          </button>
        ))}
      </div>
    </div>
  );
}

export default memo(PhoneMap);
