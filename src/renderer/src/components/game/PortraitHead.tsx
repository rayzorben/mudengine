/**
 * The character panel's head (todo 20261018-2032-01): the portrait drawn for
 * the character's race and class, else its initial; the name; race, class and
 * level; lives and CP, and experience.
 */
import { memo } from 'react';

import type { CharacterState } from '@shared/character';
import { t } from '../../lib/i18n';
import { figure } from '../../lib/stats';
import { portraitOf, type ItemArtIndex } from '../../lib/itemArt';

function PortraitHead({ character, art }: { character: CharacterState; art: ItemArtIndex | null }) {
  const name = character.fullName ?? character.name ?? t('game.bar.unknownName');
  const portrait = art === null ? null : portraitOf(art, character.race, character.className);
  const p = character.progress;
  return (
    <div className="gv-portrait-head">
      <div className="gv-portrait">
        {portrait === null ? (
          <span aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
        ) : (
          <img
            alt={t('game.sheet.portrait', {
              race: character.race ?? '',
              className: character.className ?? ''
            })}
            src={portrait}
          />
        )}
      </div>
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
      </div>
    </div>
  );
}

export default memo(PortraitHead);
