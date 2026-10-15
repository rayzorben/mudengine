/**
 * The player bar's status icons (todo 140): the fight, sneaking, resting,
 * each spell on the character with what is left of it, and every affliction
 * the realm has said is on. Afflictions nothing has spoken of since login are
 * one quiet `?`, named in its title: unknown, never "not afflicted".
 */
import { memo } from 'react';

import { AFFLICTION_NAMES, type Afflictions, type CharacterState } from '@shared/character';
import { t } from '../../lib/i18n';
import Icon, { type IconName } from '../Icon';

const AFFLICTION_ICON: Record<keyof Afflictions, IconName> = {
  blind: 'eyeOff',
  poisoned: 'flame',
  diseased: 'flame',
  held: 'stop',
  confused: 'help',
  afraid: 'run'
};

function afflictionLabel(name: keyof Afflictions): string {
  switch (name) {
    case 'blind':
      return t('game.status.blind');
    case 'poisoned':
      return t('game.status.poisoned');
    case 'diseased':
      return t('game.status.diseased');
    case 'held':
      return t('game.status.held');
    case 'confused':
      return t('game.status.confused');
    case 'afraid':
      return t('game.status.afraid');
    default: {
      const never: never = name;
      return never;
    }
  }
}

function StatusIcons({ character }: { character: CharacterState }) {
  const now = Date.now();
  const unknown = AFFLICTION_NAMES.filter((name) => character.afflictions[name] === 'unknown');
  return (
    <div className="gv-status">
      {character.combat.engaged && (
        <span className="gv-chip" data-tone="combat" title={t('game.status.combat')}>
          <Icon name="sword" />
        </span>
      )}
      {character.stealth === 'sneaking' && (
        <span className="gv-chip" data-tone="sneak" title={t('game.status.sneaking')}>
          <Icon name="eye" />
        </span>
      )}
      {(character.vitals.resting || character.vitals.meditating) && (
        <span
          className="gv-chip"
          data-tone="rest"
          title={
            character.vitals.meditating ? t('game.status.meditating') : t('game.status.resting')
          }
        >
          <Icon name="moon" />
        </span>
      )}
      {character.buffs.map((buff) => {
        const left =
          buff.expiresAt === undefined
            ? null
            : Math.max(0, Math.round((buff.expiresAt - now) / 1000));
        return (
          <span
            className="gv-chip"
            data-tone="buff"
            key={`${buff.spell}:${buff.appliedAt}`}
            title={
              buff.by === null
                ? buff.spell
                : t('game.status.buffBy', { spell: buff.spell, by: buff.by })
            }
          >
            <Icon name="sparkle" />
            {left === null ? null : t('game.status.seconds', { seconds: left })}
          </span>
        );
      })}
      {AFFLICTION_NAMES.filter((name) => character.afflictions[name] === 'yes').map((name) => (
        <span
          className="gv-chip"
          data-tone={name === 'poisoned' ? 'poison' : 'combat'}
          key={name}
          title={afflictionLabel(name)}
        >
          <Icon name={AFFLICTION_ICON[name]} />
        </span>
      ))}
      {unknown.length > 0 && (
        <span
          className="gv-chip"
          data-tone="unknown"
          title={t('game.status.unknown', { names: unknown.map(afflictionLabel).join(', ') })}
        >
          ?
        </span>
      )}
    </div>
  );
}

export default memo(StatusIcons);
