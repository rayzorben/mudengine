/**
 * The pack panel's load bar (todo 20261018-2032-01): the encumbrance the
 * server printed, split into worn gear, carried items and what the item table
 * cannot weigh, against the most the character can carry.
 */
import { memo } from 'react';

import { t } from '../../lib/i18n';
import type { Load } from '../../lib/packGroups';
import { widthOf } from '../../lib/widths';
import { LOAD_PART_LABEL, LOAD_PARTS, loadFree } from '../../lib/packLoad';

function LoadBar({ load }: { load: Load | null }) {
  if (load === null) return <div className="gv-quiet">{t('game.pack.loadUnknown')}</div>;
  return (
    <div className="gv-load">
      <div
        className="gv-load-bar"
        role="img"
        aria-label={t('game.pack.loadAria', { now: load.now, max: load.max })}
      >
        {LOAD_PARTS.map((part) => (
          <i data-part={part} key={part} style={{ width: widthOf(load[part], load.max) }} />
        ))}
      </div>
      <div className="gv-load-key">
        {LOAD_PARTS.map((part) => (
          <span data-part={part} key={part}>
            <i />
            {LOAD_PART_LABEL[part]} <b>{load[part].toLocaleString()}</b>
          </span>
        ))}
        <span>
          {t('game.pack.loadFree')} <b>{loadFree(load).toLocaleString()}</b>
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
