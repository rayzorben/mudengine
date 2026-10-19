/**
 * The game view's character panel, on `c` (todo 20261018-2032-01, the user's
 * pick of prototype A): the portrait and name, the paper doll with what is
 * worn in each slot, and the figures beside it. Esc or × closes it. Once the
 * art server has drawn the character, the drawing stands where the doll was,
 * and a press on the small portrait shows it whole (todo 20261019-0931-01).
 */
import { memo, useCallback, useMemo, useRef, useState } from 'react';

import type { CharacterState } from '@shared/character';
import type { IpcApi, SessionId } from '@shared/ipc';
import { useItemArt } from '../../hooks/useItemArt';
import { usePortrait } from '../../hooks/usePortrait';
import { t } from '../../lib/i18n';
import { wornSlotsOf } from '../../lib/wornSlots';
import { DOLL_BOX } from '../../lib/paperDoll';
import PortraitHead from './PortraitHead';
import PortraitViewer from './PortraitViewer';
import StatBlock from './StatBlock';
import WornSlots from './WornSlots';

function CharacterPanel({
  character,
  api,
  session,
  onClose
}: {
  character: CharacterState;
  api: Pick<IpcApi, 'portrait' | 'onPortrait' | 'copyImage' | 'savePortrait'>;
  session: SessionId;
  onClose(): void;
}) {
  const art = useItemArt();
  const portrait = usePortrait(api, session);
  const worn = useMemo(() => wornSlotsOf(character.inventory), [character.inventory]);
  const [whole, setWhole] = useState(false);
  const panel = useRef<HTMLElement>(null);
  // From the top of the panel, which holds still under the viewer while it is open.
  const open = useCallback(() => {
    panel.current?.scrollTo(0, 0);
    setWhole(true);
  }, []);
  // Back on the small portrait, so the panel's own Esc still reaches the game view.
  const shut = useCallback(() => {
    setWhole(false);
    panel.current?.querySelector<HTMLElement>('.gv-portrait[data-drawn]')?.focus();
  }, []);
  const name = character.fullName ?? character.name ?? t('game.bar.unknownName');
  return (
    <aside
      aria-label={t('game.sheet.aria')}
      className="gv-hud gv-glass gv-panel gv-character"
      data-viewing={whole ? 'true' : undefined}
      ref={panel}
    >
      <button
        aria-label={t('game.sheet.close')}
        className="gv-icon-button gv-panel-close"
        onClick={onClose}
        type="button"
      >
        ×
      </button>
      <PortraitHead art={art} character={character} onOpen={open} portrait={portrait} />
      <div className="gv-character-body">
        {portrait.picture === null ? (
          <WornSlots art={art} realm={character.realm} worn={worn} />
        ) : (
          <img
            alt={name}
            className="gv-figure"
            draggable={false}
            onClick={open}
            src={portrait.picture}
            style={{ height: DOLL_BOX.height }}
          />
        )}
        <StatBlock character={character} />
      </div>
      {whole && portrait.picture !== null && (
        <PortraitViewer
          api={api}
          name={name}
          onClose={shut}
          session={session}
          src={portrait.picture}
        />
      )}
    </aside>
  );
}

export default memo(CharacterPanel);
