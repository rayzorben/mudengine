/**
 * The Loops tab: the loop running with its Stop, then every loop there is,
 * found by name, area or a room it visits (`LoopRow.search`). Choosing a row
 * goes where the Loops modal's choice goes (`useLoopJoin`), unfiled.
 */
import { memo, useEffect, useMemo, useState } from 'react';

import type { LoopProgress } from '@shared/loops';
import { t } from '../../lib/i18n';
import { loopMatches, type LoopChoice, type LoopDestination, type LoopRow } from '../../lib/loops';

/** Rows drawn at once: a shelf is hundreds, and a phone reads a screenful. */
const SHOWN = 40;

export interface PhoneLoopsProps {
  rows: readonly LoopRow[];
  loading: boolean;
  progress: LoopProgress;
  choose(choice: LoopChoice, destination: LoopDestination): void;
  stop(): void;
  /** Asks for the shelf: this tab has no modal whose opening would. */
  load(): void;
}

function PhoneLoops({ rows, loading, progress, choose, stop, load }: PhoneLoopsProps) {
  const [query, setQuery] = useState('');
  useEffect(load, [load]);
  const found = useMemo(() => loopMatches(rows, query), [rows, query]);
  return (
    <div className="phone-loops">
      {progress.status === 'running' && (
        <section className="phone-glass phone-running" aria-label={t('phone.loops.runningAria')}>
          <div>
            <b>{progress.name ?? t('phone.loops.unnamed')}</b>
            <small>
              {progress.stopName === null
                ? t('phone.loops.stop', { stop: progress.stop, stops: progress.stops })
                : t('phone.loops.stopAt', {
                    stop: progress.stop,
                    stops: progress.stops,
                    name: progress.stopName
                  })}
            </small>
          </div>
          <button className="phone-danger" onClick={stop} type="button">
            {t('phone.loops.stopButton')}
          </button>
        </section>
      )}
      <input
        aria-label={t('phone.loops.findAria')}
        className="phone-glass phone-find"
        enterKeyHint="search"
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('phone.loops.find')}
        type="search"
        value={query}
      />
      {loading && <p className="phone-quiet">{t('phone.loops.loading')}</p>}
      {!loading && found.length === 0 && <p className="phone-quiet">{t('phone.loops.none')}</p>}
      <ul>
        {found.slice(0, SHOWN).map((row) => (
          <li className="phone-glass phone-row" key={row.key}>
            <div>
              <b>{row.shortName}</b>
              <small>{t('phone.loops.rowDetail', { area: row.category, stops: row.stops })}</small>
            </div>
            <button onClick={() => choose(row.choice, 'none')} type="button">
              {t('phone.loops.run')}
            </button>
          </li>
        ))}
      </ul>
      {found.length > SHOWN && (
        <p className="phone-quiet">{t('phone.loops.more', { count: found.length - SHOWN })}</p>
      )}
    </div>
  );
}

export default memo(PhoneLoops);
