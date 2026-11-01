/**
 * The head of the Self card's sheet: the character's picture beside who it is
 * (class and race) and the three figures read at a glance, level, lives and
 * experience. The picture is the bundled one for the race and class, else the
 * initial (`useCharacterPicture`); the art server's drawing needs the IPC
 * port, which a card does not hold. Drawn at every size, larger from large.
 */
import { memo } from 'react';

import type { Progress } from '@shared/character';
import { NO_PORTRAIT } from '@shared/portrait';
import { useCharacterPicture } from '../hooks/useCharacterPicture';
import { useItemArt } from '../hooks/useItemArt';
import { t } from '../lib/i18n';
import { figure } from '../lib/stats';

function SelfHero({
  progress,
  race,
  className,
  title
}: {
  progress: Progress;
  race: string | null;
  className: string | null;
  title: string;
}) {
  const { src, failed, initial } = useCharacterPicture(
    useItemArt(),
    NO_PORTRAIT,
    race,
    className,
    title
  );
  return (
    <div className="self-hero">
      <span aria-hidden="true" className="self-portrait" data-picture={src !== null}>
        {src === null ? initial : <img alt="" onError={failed} src={src} />}
      </span>
      <div className="self-hero-facts">
        <span className={`self-hero-who${className ? '' : ' inert'}`}>
          {className ?? '—'}
          {race ? ` · ${race}` : ''}
        </span>
        <div className="self-hero-cells">
          <div className="stat-cell">
            <em>{t('cards.vitals.labels.level')}</em>
            <b className={progress.level === null ? 'inert' : undefined}>
              {figure(progress.level)}
            </b>
          </div>
          <div className="stat-cell">
            <em>{t('cards.self.labels.lives')}</em>
            <b className={progress.lives === null ? 'inert' : undefined}>
              {figure(progress.lives)}
              {progress.cp !== null ? ` / ${progress.cp}` : ''}
            </b>
          </div>
          {/* The one figure that runs to seven digits, so it takes what is left. */}
          <div className="stat-cell self-hero-exp">
            <em>{t('cards.self.labels.exp')}</em>
            <b className={progress.exp === null ? 'inert' : undefined}>{figure(progress.exp)}</b>
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(SelfHero);
