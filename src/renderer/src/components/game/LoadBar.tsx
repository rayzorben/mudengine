/**
 * The pack panel's load bar (todo 20261018-2032-01): the encumbrance the
 * server printed, split into worn gear, carried items and what the item table
 * cannot weigh, against the most the character can carry.
 */
import { memo } from 'react';

import { t } from '../../lib/i18n';
import type { Load } from '../../lib/packGroups';

const share = (part: number, max: number): string =>
  `${max > 0 ? Math.min(100, (100 * part) / max).toFixed(2) : 0}%`;

function LoadBar({ load }: { load: Load | null }) {
  if (load === null) return <div className="gv-quiet">{t('game.pack.loadUnknown')}</div>;
  const parts: Array<[string, number, string]> = [
    ['worn', load.worn, t('game.pack.loadWorn')],
    ['carried', load.carried, t('game.pack.loadCarried')],
    ['rest', load.rest, t('game.pack.loadRest')]
  ];
  return (
    <div className="gv-load">
      <div
        className="gv-load-bar"
        role="img"
        aria-label={t('game.pack.loadAria', { now: load.now, max: load.max })}
      >
        {parts.map(([part, value]) => (
          <i data-part={part} key={part} style={{ width: share(value, load.max) }} />
        ))}
      </div>
      <div className="gv-load-key">
        {parts.map(([part, value, label]) => (
          <span data-part={part} key={part}>
            <i />
            {label} <b>{value.toLocaleString()}</b>
          </span>
        ))}
        <span>
          {t('game.pack.loadFree')} <b>{Math.max(0, load.max - load.now).toLocaleString()}</b>
        </span>
        <span className="gv-load-total">
          <b>{load.now.toLocaleString()}</b> / {load.max.toLocaleString()}
          {load.word !== null && <em>{load.word}</em>}
        </span>
      </div>
    </div>
  );
}

export default memo(LoadBar);
