/**
 * The character panel's head (todo 20261018-2032-01): the portrait the art
 * server drew of this character (todo 20261019-0931-01), else the picture for
 * its race and class, else its initial, with why it is not the drawn one; the
 * name; race, class and level; lives and CP, and experience.
 */
import { memo } from 'react';

import type { CharacterState } from '@shared/character';
import type { PortraitStatus, PortraitView } from '@shared/portrait';
import { useFirstPicture } from '../../hooks/useFirstPicture';
import { t } from '../../lib/i18n';
import { figure } from '../../lib/stats';
import { portraitOf, type ItemArtIndex } from '../../lib/itemArt';

/** Why the panel shows something other than the drawn portrait, or null when it is the drawn one. */
function statusLine(status: PortraitStatus): string | null {
  switch (status.kind) {
    case 'drawn':
      return null;
    case 'off':
      return t('game.sheet.portraitOff');
    case 'unavailable':
      return t('game.sheet.portraitUnavailable');
    case 'incomplete':
      return t('game.sheet.portraitIncomplete');
    case 'waiting':
      return t('game.sheet.portraitWaiting');
    case 'refused':
      return t('game.sheet.portraitRefused', { reason: status.reason });
    case 'unreachable':
      return t('game.sheet.portraitUnreachable', { reason: status.reason });
    default: {
      const never: never = status;
      return never;
    }
  }
}

function PortraitHead({
  character,
  art,
  portrait,
  onOpen
}: {
  character: CharacterState;
  art: ItemArtIndex | null;
  portrait: PortraitView;
  /** The drawn portrait pressed: shown whole. */
  onOpen(): void;
}) {
  const name = character.fullName ?? character.name ?? t('game.bar.unknownName');
  const kind = art === null ? null : portraitOf(art, character.race, character.className);
  const { src, failed } = useFirstPicture([portrait.picture, kind]);
  const why = statusLine(portrait.status);
  const drawn = src !== null && src === portrait.picture;
  const p = character.progress;
  const picture =
    src === null ? (
      <span aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
    ) : (
      <img
        alt={t('game.sheet.portrait', {
          race: character.race ?? '',
          className: character.className ?? ''
        })}
        onError={failed}
        src={src}
      />
    );
  return (
    <div className="gv-portrait-head">
      {drawn ? (
        <button
          aria-label={t('game.sheet.portraitOpen')}
          className="gv-portrait"
          data-drawn="true"
          onClick={onOpen}
          title={t('game.sheet.portraitOpen')}
          type="button"
        >
          {picture}
        </button>
      ) : (
        <div className="gv-portrait" title={why ?? undefined}>
          {picture}
        </div>
      )}
      <div>
        <h3>{name}</h3>
        <div className="gv-quiet">
          {[
            character.race,
            character.className,
            p.level === null ? null : t('game.sheet.level', { level: p.level })
          ]
            .filter((one) => one !== null)
            .join(' · ')}
        </div>
        <div className="gv-chips">
          <span>
            {t('game.sheet.livesCp')} <b>{`${figure(p.lives)}/${figure(p.cp)}`}</b>
          </span>
          <span>
            {t('game.sheet.exp')} <b>{figure(p.exp)}</b>
          </span>
        </div>
        {why !== null && <div className="gv-quiet gv-portrait-why">{why}</div>}
      </div>
    </div>
  );
}

export default memo(PortraitHead);
