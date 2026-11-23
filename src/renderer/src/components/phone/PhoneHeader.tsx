/**
 * The phone shell's header: health and mana as rings, the character's name and
 * where it stands. Collapsed to one line while a keyboard is up. An unknown
 * pool draws an empty ring marked `?`, never a full or a zero one.
 */
import { memo, type CSSProperties } from 'react';

import type { CharacterState } from '@shared/character';
import { t } from '../../lib/i18n';
import { fraction } from '../../lib/phone';

function Ring({
  kind,
  value,
  max
}: {
  kind: 'hp' | 'mana';
  value: number | null;
  max: number | null;
}) {
  const share = fraction(value, max);
  const figures = { value: value ?? '?', max: max ?? '?' };
  return (
    <span
      aria-label={kind === 'hp' ? t('phone.ring.hp', figures) : t('phone.ring.mana', figures)}
      className="phone-ring"
      data-kind={kind}
      data-unknown={share === null ? 'true' : undefined}
      role="img"
      style={{ '--phone-fill': `${Math.round((share ?? 0) * 100)}%` } as CSSProperties}
    >
      <span>{value ?? '?'}</span>
    </span>
  );
}

function PhoneHeader({
  character,
  compact,
  onPick
}: {
  character: CharacterState;
  compact: boolean;
  /** Opens the character switcher. */
  onPick(): void;
}) {
  const { vitals, room } = character;
  return (
    <header className="phone-header phone-glass" data-compact={compact ? 'true' : undefined}>
      <Ring kind="hp" max={vitals.hpMax} value={vitals.hp} />
      <button
        aria-haspopup="true"
        className="phone-who"
        title={t('phone.pick')}
        onClick={onPick}
        type="button"
      >
        <b>{character.name ?? t('phone.noName')}</b>
        {!compact && <small>{room.name ?? t('phone.noRoom')}</small>}
      </button>
      {vitals.mana !== null && <Ring kind="mana" max={vitals.manaMax} value={vitals.mana} />}
    </header>
  );
}

export default memo(PhoneHeader);
