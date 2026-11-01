/**
 * The pack's encumbrance as one bar cut into what makes it up: worn gear,
 * carried things, and what the item table cannot weigh (coins, unknown rows),
 * against the most the character can carry. The figure and the server's own
 * word sit beside it from medium; the key under it is drawn from large.
 * The parts are `loadOf`'s, shared with the game view's pack panel.
 */
import { memo } from 'react';

import { t } from '../lib/i18n';
import type { Load } from '../lib/packGroups';
import { LOAD_PART_LABEL, LOAD_PARTS, loadFree, loadWidth } from '../lib/packLoad';

/** The pack's own grading: heavy from 70% of the maximum, near the limit from 90%. */
function levelOf(share: number): 'ok' | 'caution' | 'critical' {
  return share >= 0.9 ? 'critical' : share >= 0.7 ? 'caution' : 'ok';
}

function PackLoad({ load }: { load: Load }) {
  return (
    <div className="pack-load" data-level={levelOf(load.now / load.max)}>
      <div className="meter">
        <span
          aria-label={t('game.pack.loadAria', { now: load.now, max: load.max })}
          className="track"
          role="img"
        >
          {LOAD_PARTS.map((part) => (
            <span
              className="fill"
              data-part={part}
              key={part}
              style={{ width: loadWidth(load[part], load.max) }}
            />
          ))}
        </span>
        <span className="figures">
          {load.now.toLocaleString()}/{load.max.toLocaleString()}
          {load.word !== null && <em className="from-medium"> {load.word}</em>}
        </span>
      </div>
      <ul className="pack-load-key from-large">
        {LOAD_PARTS.map((part) => (
          <li data-part={part} key={part}>
            <i />
            {LOAD_PART_LABEL[part]} <b>{load[part].toLocaleString()}</b>
          </li>
        ))}
        <li data-part="free">
          <i />
          {t('game.pack.loadFree')} <b>{loadFree(load).toLocaleString()}</b>
        </li>
      </ul>
    </div>
  );
}

export default memo(PackLoad);
