/**
 * The game view's player bar (todo 140): name and level; HP and mana or kai as
 * stacked bars with the totals on them and Run and Rest marked on the HP bar;
 * exp with what is owed and the time to level; status icons; exp rate and the
 * coins carried. An unknown figure is shown as unknown, never as 0.
 */
import { memo } from 'react';

import type { CharacterState } from '@shared/character';
import { experienceOf } from '@shared/experience';
import { experienceRate, levelIn, statsScope, type CombatTally } from '@shared/tally';
import { coinText } from '../../lib/coins';
import { t } from '../../lib/i18n';
import { compact } from '../../lib/rates';
import { duration } from '../../lib/stats';
import { tuning } from '../../lib/tuning';
import StatusIcons from './StatusIcons';

export interface PlayerBarProps {
  character: CharacterState;
  statsBase: CombatTally | null;
  /** Run and Rest, as shares of health; null while unknown. */
  runBelow: number | null;
  restBelow: number | null;
  /** The character's name as its file states it, until the realm says it. */
  profileName: string | null;
}

const share = (value: number | null, max: number | null): number | null =>
  value === null || max === null || max <= 0 ? null : Math.max(0, Math.min(1, value / max));

const figure = (value: number | null): string => (value === null ? '?' : String(value));

function Meter({
  label,
  value,
  max,
  tone,
  small,
  marks
}: {
  label: string;
  value: number | null;
  max: number | null;
  tone: 'hp' | 'mana' | 'kai';
  small?: boolean;
  marks?: Array<{ at: number; tone: 'run' | 'rest'; title: string }>;
}) {
  const filled = share(value, max);
  return (
    <div
      className="gv-meter"
      data-tone={tone}
      data-size={small === true ? 'small' : undefined}
      data-unknown={filled === null ? 'true' : undefined}
    >
      <i className="gv-meter-fill" style={{ width: `${(filled ?? 0) * 100}%` }} />
      {marks?.map((mark) => (
        <i
          className="gv-meter-mark"
          data-tone={mark.tone}
          key={mark.tone}
          style={{ left: `${mark.at * 100}%` }}
          title={mark.title}
        />
      ))}
      <span className="gv-meter-text">
        <span>{label}</span>
        <span>
          {figure(value)}
          <small> / {figure(max)}</small>
        </span>
      </span>
    </div>
  );
}

function PlayerBar({ character, statsBase, runBelow, restBelow, profileName }: PlayerBarProps) {
  const name = character.name ?? profileName;
  const { vitals, progress } = character;
  const { standing, owed } = experienceOf(progress);
  const now = Date.now();
  const perHour = experienceRate(statsScope(character.tally, statsBase), now, tuning().rateFloorMs);
  const toLevel = levelIn(owed.value, perHour);
  const nextAt = standing?.next ?? null;
  const row = (level: number | null) =>
    level === null ? undefined : progress.expTable?.rows.find((one) => one.level === level);
  const from = row(standing?.level ?? null)?.experience ?? null;
  const to = row(nextAt)?.experience ?? null;
  const expShare =
    progress.exp === null || from === null || to === null || to <= from
      ? null
      : Math.max(0, Math.min(1, (progress.exp - from) / (to - from)));
  const pool = vitals.manaType === 'KAI' ? 'kai' : 'mana';
  const marks = [
    ...(restBelow === null
      ? []
      : [
          {
            at: restBelow,
            tone: 'rest' as const,
            title: t('game.bar.restMark', { percent: Math.round(restBelow * 100) })
          }
        ]),
    ...(runBelow === null
      ? []
      : [
          {
            at: runBelow,
            tone: 'run' as const,
            title: t('game.bar.runMark', { percent: Math.round(runBelow * 100) })
          }
        ])
  ];
  const coins = coinText(character.inventory.coins, 2);

  return (
    <header className="gv-hud gv-glass gv-player">
      <div className="gv-player-id">
        <div className="gv-avatar">{(name ?? '?')[0]}</div>
        <div>
          <b>{name ?? t('game.bar.unknownName')}</b>
          <span>
            {[character.className, progress.level === null ? null : String(progress.level)]
              .filter((one) => one !== null)
              .join(' ')}
          </span>
        </div>
      </div>
      <div className="gv-vitals">
        <Meter
          label={t('game.bar.hp')}
          marks={marks}
          max={vitals.hpMax}
          tone="hp"
          value={vitals.hp}
        />
        {vitals.manaType !== null && (
          <Meter
            label={vitals.manaType === 'KAI' ? t('game.bar.kai') : t('game.bar.mana')}
            max={vitals.manaMax}
            small
            tone={pool}
            value={vitals.mana}
          />
        )}
      </div>
      <div className="gv-exp">
        <div className="gv-exp-row">
          <b>
            {expShare === null ? '?' : Math.floor(expShare * 100)}
            <small>{t('game.bar.expShare')}</small>
          </b>
          <span>
            {owed.value === null
              ? t('game.bar.expOwedUnknown')
              : nextAt === null
                ? t('game.bar.expOwed', { owed: owed.value.toLocaleString() })
                : t('game.bar.expOwedTo', { owed: owed.value.toLocaleString(), level: nextAt })}
            {toLevel === null ? '' : ` · ${duration(toLevel)}`}
          </span>
        </div>
        <div className="gv-thin" data-unknown={expShare === null ? 'true' : undefined}>
          <i style={{ width: `${(expShare ?? 0) * 100}%` }} />
        </div>
      </div>
      <StatusIcons character={character} />
      <div className="gv-figures">
        <div>
          <span>{t('game.bar.expRate')}</span>
          <b>{perHour === null ? '—' : t('game.bar.perHour', { value: compact(perHour) })}</b>
        </div>
        <div>
          <span>{t('game.bar.coins')}</span>
          <b>
            {character.inventory.wealth === null
              ? '?'
              : coins.length > 0
                ? coins
                : t('game.bar.noCoins')}
          </b>
        </div>
      </div>
    </header>
  );
}

export default memo(PlayerBar);
