/**
 * The Navigation card's loops while nothing moves, a tile each: the lap's
 * stops as a ring, its name and how many stops it has. A press picks the tile
 * as what play will start, the picker's choice drawn larger; play stays the
 * heading's. See `mudengine-ui` › `parts/cards.md`, *Routing, looping or
 * stopped*.
 */
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import LapRing from './viz/LapRing';

export default function LoopTiles({
  loops,
  chosen,
  onChoose
}: {
  loops: ReadonlyArray<{ name: string; stops: number }>;
  /** The picker's value: a loop's name, or `''` for the resume entry. */
  chosen: string;
  onChoose(name: string): void;
}) {
  if (loops.length === 0) return null;
  return (
    <ul aria-label={t('cards.navigation.loop.loopsCaption')} className="loop-tiles">
      {loops.map((entry) => {
        const stops =
          entry.stops === 1
            ? t('cards.navigation.loop.stopsLine.one')
            : t('cards.navigation.loop.stopsLine.many', { stops: entry.stops });
        return (
          <li key={entry.name}>
            <button
              aria-pressed={chosen === entry.name}
              onClick={() => onChoose(entry.name)}
              onMouseDown={keepFocus}
              type="button"
            >
              <LapRing at={0} label={stops} stops={entry.stops} />
              <span className="loop-tile-name">{entry.name}</span>
              <span className="loop-tile-stops">{stops}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
