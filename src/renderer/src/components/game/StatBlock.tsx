/**
 * The character panel's figures (todo 20261018-2032-01): the six attributes
 * large, then combat, then the skills. Everything `st` printed; a figure the
 * realm has not printed is a dash, and a zero is dimmed, never hidden.
 */
import { memo } from 'react';

import type { CharacterState } from '@shared/character';
import { t } from '../../lib/i18n';
import { figure } from '../../lib/stats';

const pair = (a: number | null, b: number | null): string => `${figure(a)}/${figure(b)}`;

function Rows({ rows }: { rows: ReadonlyArray<[string, string, boolean]> }) {
  return (
    <dl className="gv-stat-rows">
      {rows.map(([label, value, quiet]) => (
        <div data-quiet={quiet ? 'true' : undefined} key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const row = (label: string, value: number | null): [string, string, boolean] => [
  label,
  figure(value),
  value === 0
];

function StatBlock({ character }: { character: CharacterState }) {
  const p = character.progress;
  const v = character.vitals;
  const attributes: Array<[string, number | null]> = [
    [t('game.sheet.strength'), p.strength],
    [t('game.sheet.intellect'), p.intellect],
    [t('game.sheet.willpower'), p.willpower],
    [t('game.sheet.agility'), p.agility],
    [t('game.sheet.health'), p.health],
    [t('game.sheet.charm'), p.charm]
  ];
  return (
    <div className="gv-stats">
      <div className="gv-stat-label">{t('game.sheet.attributes')}</div>
      <div className="gv-attributes">
        {attributes.map(([label, value]) => (
          <div key={label}>
            <b>{figure(value)}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="gv-stat-label">{t('game.sheet.combat')}</div>
      <Rows
        rows={[
          [t('game.sheet.hits'), pair(v.hp, v.hpMax), false],
          [t('game.sheet.acDr'), pair(p.armourClass, p.damageResist), false],
          row(t('game.sheet.magicRes'), p.magicRes),
          row(t('game.sheet.spellcasting'), p.spellcasting),
          row(t('game.sheet.martialArts'), p.martialArts)
        ]}
      />
      <div className="gv-stat-label">{t('game.sheet.skills')}</div>
      <Rows
        rows={[
          row(t('game.sheet.perception'), p.perception),
          row(t('game.sheet.stealth'), p.stealthSkill),
          row(t('game.sheet.thievery'), p.thievery),
          row(t('game.sheet.traps'), p.traps),
          row(t('game.sheet.picklocks'), p.picklocks),
          row(t('game.sheet.tracking'), p.tracking)
        ]}
      />
    </div>
  );
}

export default memo(StatBlock);
