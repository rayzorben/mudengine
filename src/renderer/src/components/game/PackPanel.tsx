/**
 * The game view's pack panel, on `i` (todo 20261018-2032-01, the user's pick
 * of prototype B): the load bar, a card per section of what is carried, and
 * cash, keys and tokens along the bottom. Until the pack has been listed it
 * says so, rather than showing an empty pack. Esc or × closes it.
 */
import { memo, useMemo } from 'react';

import type { CharacterState } from '@shared/character';
import { useItemArt } from '../../hooks/useItemArt';
import { t } from '../../lib/i18n';
import { loadOf, packOf, PACK_GROUPS, type PackGroup } from '../../lib/packGroups';
import LoadBar from './LoadBar';
import PackCard from './PackCard';
import PackTray from './PackTray';

const GROUP_LABEL: Record<PackGroup, string> = {
  gear: t('game.pack.group.gear'),
  use: t('game.pack.group.use'),
  scroll: t('game.pack.group.scroll'),
  other: t('game.pack.group.other')
};

function PackPanel({ character, onClose }: { character: CharacterState; onClose(): void }) {
  const art = useItemArt();
  const { inventory, realm } = character;
  const pack = useMemo(() => packOf(inventory), [inventory]);
  const load = useMemo(() => loadOf(inventory), [inventory]);
  return (
    <aside aria-label={t('game.pack.aria')} className="gv-hud gv-glass gv-panel gv-pack">
      <button
        aria-label={t('game.pack.close')}
        className="gv-icon-button gv-panel-close"
        onClick={onClose}
        type="button"
      >
        ×
      </button>
      <h3>{t('game.pack.title')}</h3>
      {pack === null ? (
        <p className="gv-quiet">{t('game.pack.notListed')}</p>
      ) : (
        <>
          <LoadBar load={load} />
          <div className="gv-pack-cards">
            {PACK_GROUPS.map((group) => (
              <PackCard
                art={art}
                group={group}
                items={pack.groups[group]}
                key={group}
                label={GROUP_LABEL[group]}
                realm={realm}
              />
            ))}
          </div>
          <PackTray art={art} inventory={inventory} realm={realm} tokens={pack.tokens} />
        </>
      )}
    </aside>
  );
}

export default memo(PackPanel);
