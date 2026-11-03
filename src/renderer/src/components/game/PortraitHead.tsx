/**
 * The character panel's head (todo 20261018-2032-01): the portrait the art
 * server drew of this character (todo 20261019-0931-01), else the picture for
 * its race and class, else its initial, with why it is not the drawn one; the
 * name; race, class and level; lives and CP, and experience.
 */
import { memo } from 'react';

import type { CharacterState } from '@shared/character';
import EntityName, { type Inspect } from '../EntityName';
import { NameList } from '../Sentence';
import type { PortraitStatus, PortraitView } from '@shared/portrait';
import { useCharacterPicture } from '../../hooks/useCharacterPicture';
import { t } from '../../lib/i18n';
import { figure } from '../../lib/stats';
import type { ItemArtIndex } from '../../lib/itemArt';

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
  onOpen,
  inspect
}: {
  character: CharacterState;
  /** This character's class or race clicked: the realm's answer, as a stranger's opens. */
  inspect?: Inspect;
  art: ItemArtIndex | null;
  portrait: PortraitView;
  /** The drawn portrait pressed: shown whole. */
  onOpen(): void;
}) {
  const name = character.fullName ?? character.name ?? t('game.bar.unknownName');
  const { src, failed, drawn, initial } = useCharacterPicture(
    art,
    portrait,
    character.race,
    character.className,
    name
  );
  const why = statusLine(portrait.status);
  const p = character.progress;
  const picture =
    src === null ? (
      <span aria-hidden="true">{initial}</span>
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
          <NameList
            draw={(part) =>
              part.kind === 'name' ? <EntityName inspect={inspect} name={part.text} /> : part.text
            }
            items={[
              ...(character.race === null ? [] : [{ kind: 'name', text: character.race }]),
              ...(character.className === null
                ? []
                : [{ kind: 'name', text: character.className }]),
              ...(p.level === null
                ? []
                : [{ kind: 'level', text: t('game.sheet.level', { level: p.level }) }])
            ]}
            separator=" · "
          />
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
