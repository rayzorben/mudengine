/**
 * The target's card in the game view (todo 140): its name and wound band, the
 * realm's HP and exp for it, and whether it is attacking this character. The
 * wound band is what the server said (`look`, a blow's line); unsaid is
 * unknown, never unwounded.
 */
import { memo } from 'react';

import type { CharacterState } from '@shared/character';
import { woundRange } from '@shared/wounds';
import { t } from '../../lib/i18n';

function TargetCard({ character, target }: { character: CharacterState; target: string | null }) {
  if (target === null) return <aside className="gv-hud gv-glass gv-target" data-shown="false" />;
  const { combat } = character;
  const fighting = combat.target === target;
  const observed = fighting ? (combat.health?.observed ?? null) : null;
  const [lo, hi] = observed === null ? [0, 0] : woundRange(observed);
  const occupant = character.room.occupants.find((one) => one.name === target);
  const entity = fighting ? (combat.targetEntity ?? occupant?.mob) : occupant?.mob;
  const onYou = combat.attackers.some((name) => name.toLowerCase() === target.toLowerCase());
  const facts = [
    entity?.hp === undefined ? null : t('game.target.hp', { hp: entity.hp }),
    entity?.experience === undefined
      ? null
      : t('game.target.exp', { exp: entity.experience.toLocaleString() })
  ].filter((one): one is string => one !== null);
  return (
    <aside className="gv-hud gv-glass gv-target" data-shown="true">
      <div className="gv-target-row">
        <b>{target}</b>
        <span>{observed ?? t('game.target.unknown')}</span>
      </div>
      <div className="gv-wound" data-unknown={observed === null ? 'true' : undefined}>
        <i className="gv-wound-sure" style={{ width: `${lo * 100}%` }} />
        <i
          className="gv-wound-maybe"
          style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }}
        />
      </div>
      <div className="gv-target-row gv-quiet">
        <span>{facts.length > 0 ? facts.join(' · ') : t('game.target.notInData')}</span>
        <span>
          {onYou
            ? t('game.target.onYou')
            : occupant?.disposition === 'hostile'
              ? t('game.target.hostile')
              : t('game.target.notOnYou')}
        </span>
      </div>
    </aside>
  );
}

export default memo(TargetCard);
