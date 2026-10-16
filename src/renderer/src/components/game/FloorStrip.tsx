/**
 * The floor strip at the game view map's left edge (todo 151): the floor
 * shown and every floor a stair in the window reaches, highest first.
 * Pressing a floor shows it around the room the nearest stair to it reaches,
 * detached as a drag is; the character's own floor is marked while another is
 * shown. Not drawn when no stair reaches another floor.
 */
import { memo } from 'react';

import type { RoomId } from '@shared/world';
import type { FloorChoice } from '../../lib/gameFloors';
import { t } from '../../lib/i18n';

export interface FloorStripProps {
  floors: readonly FloorChoice[];
  /** The character's own floor, when known. */
  home: number | null;
  onShow(room: RoomId): void;
}

const signed = (floor: number): string => (floor > 0 ? `+${floor}` : String(floor));

function FloorStrip({ floors, home, onShow }: FloorStripProps) {
  if (floors.length === 0) return null;
  return (
    <div aria-label={t('game.map.floors')} className="gv-hud gv-glass gv-floors" role="group">
      <div className="gv-floors-label">{t('game.map.floors')}</div>
      {floors.map(({ floor, to }) => (
        <button
          aria-label={t('game.map.floorButton', { floor: signed(floor) })}
          data-floor={floor}
          data-home={floor === home ? 'true' : undefined}
          data-on={to === null ? 'true' : undefined}
          disabled={to === null}
          key={floor}
          onClick={to === null ? undefined : () => onShow(to)}
          title={floor === home && to !== null ? t('game.map.yourFloor') : undefined}
          type="button"
        >
          {signed(floor)}
        </button>
      ))}
    </div>
  );
}

export default memo(FloorStrip);
