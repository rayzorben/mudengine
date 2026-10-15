/**
 * The game view's character sheet (todo 140), on `c`: who the character is and
 * the figures `st` printed. A figure the realm has not printed is `?`.
 */
import { memo } from 'react';

import type { CharacterState } from '@shared/character';
import { t } from '../../lib/i18n';

const figure = (value: number | null): string => (value === null ? '?' : String(value));

function CharacterSheet({ character, onClose }: { character: CharacterState; onClose(): void }) {
  const p = character.progress;
  const rows: Array<[string, number | null]> = [
    [t('game.sheet.strength'), p.strength],
    [t('game.sheet.intellect'), p.intellect],
    [t('game.sheet.willpower'), p.willpower],
    [t('game.sheet.agility'), p.agility],
    [t('game.sheet.health'), p.health],
    [t('game.sheet.charm'), p.charm],
    [t('game.sheet.armourClass'), p.armourClass],
    [t('game.sheet.damageResist'), p.damageResist],
    [t('game.sheet.magicRes'), p.magicRes],
    [t('game.sheet.spellcasting'), p.spellcasting],
    [t('game.sheet.perception'), p.perception],
    [t('game.sheet.stealth'), p.stealthSkill],
    [t('game.sheet.thievery'), p.thievery],
    [t('game.sheet.traps'), p.traps],
    [t('game.sheet.picklocks'), p.picklocks],
    [t('game.sheet.tracking'), p.tracking],
    [t('game.sheet.martialArts'), p.martialArts],
    [t('game.sheet.lives'), p.lives]
  ];
  return (
    <aside aria-label={t('game.sheet.aria')} className="gv-hud gv-glass gv-sheet">
      <div className="gv-sheet-head">
        <div>
          <h3>{character.fullName ?? character.name ?? t('game.bar.unknownName')}</h3>
          <div className="gv-quiet">
            {[
              character.race,
              character.className,
              p.level === null ? null : t('game.sheet.level', { level: p.level })
            ]
              .filter((one) => one !== null)
              .join(' · ')}
          </div>
        </div>
        <button
          aria-label={t('game.sheet.close')}
          className="gv-icon-button"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </div>
      <dl className="gv-sheet-grid">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{figure(value)}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

export default memo(CharacterSheet);
