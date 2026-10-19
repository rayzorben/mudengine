/**
 * The game view's character panel, on `c` (todo 20261018-2032-01, the user's
 * pick of prototype A): the portrait and name, the paper doll with what is
 * worn in each slot, and the figures beside it. Esc or × closes it.
 */
import { memo, useMemo } from 'react';

import type { CharacterState } from '@shared/character';
import { useItemArt } from '../../hooks/useItemArt';
import { t } from '../../lib/i18n';
import { wornSlotsOf } from '../../lib/wornSlots';
import PortraitHead from './PortraitHead';
import StatBlock from './StatBlock';
import WornSlots from './WornSlots';

function CharacterPanel({ character, onClose }: { character: CharacterState; onClose(): void }) {
  const art = useItemArt();
  const worn = useMemo(() => wornSlotsOf(character.inventory), [character.inventory]);
  return (
    <aside aria-label={t('game.sheet.aria')} className="gv-hud gv-glass gv-panel gv-character">
      <button
        aria-label={t('game.sheet.close')}
        className="gv-icon-button gv-panel-close"
        onClick={onClose}
        type="button"
      >
        ×
      </button>
      <PortraitHead art={art} character={character} />
      <div className="gv-character-body">
        <WornSlots art={art} realm={character.realm} worn={worn} />
        <StatBlock character={character} />
      </div>
    </aside>
  );
}

export default memo(CharacterPanel);
