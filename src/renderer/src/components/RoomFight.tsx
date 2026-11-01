/**
 * The Room card's answer to *can I fight this room?*: the room's fight run
 * (`RoomVerdict.survival`) as a ring of the share survived, and the health
 * clearing it is expected to cost held against the health the character has,
 * as one bar cut into what is left and what it costs. Unknown is said as
 * itself: a dashed ring, and the words with no bar. The same `Verdict`
 * auto-combat ranks on, so the card and the engine cannot disagree.
 */
import { useMemo } from 'react';

import { t } from '../lib/i18n';
import { percent } from '../lib/outlook';
import Ring from './viz/Ring';
import SplitBar from './viz/SplitBar';
import type { VitalLevel } from '@shared/character';
import type { SurvivalLevel } from '@shared/survival';
import type { RoomVerdict } from '@shared/verdict';

const LEVEL: Record<SurvivalLevel, VitalLevel> = {
  safe: 'ok',
  risky: 'caution',
  deadly: 'critical'
};

/** The chip a share of fights survived wears: the meter's three hues, in the chip register. */
export const SURVIVAL_CHIP: Record<SurvivalLevel, string> = {
  safe: 'chip on',
  risky: 'chip warn',
  deadly: 'chip bad'
};

function wholeHp(value: number): string {
  return String(Math.round(value));
}

/** The room's fight as one chip, the small card's glance at it; nothing where the room holds no fight. */
export function FightChip({ verdict }: { verdict: RoomVerdict }) {
  if (verdict.monsters.length === 0) return null;
  const { survival } = verdict;
  if (survival === null) {
    return (
      <span className="chip quiet" title={t('cards.combat.survival.unknown')}>
        —
      </span>
    );
  }
  const share = percent(survival.survives);
  return (
    <span
      className={SURVIVAL_CHIP[survival.level]}
      title={t('cards.combat.survival.walkOut', { percent: share })}
    >
      {t('cards.combat.survival.figure', { percent: share })}
    </span>
  );
}

export default function RoomFight({ verdict, hp }: { verdict: RoomVerdict; hp: number | null }) {
  const { survival, cost } = verdict;
  const survives = survival === null ? null : percent(survival.survives);
  // A bound, so *up to*; loud only when it reaches the character's own health.
  const deadly = cost !== null && hp !== null && cost.value >= hp;
  // Held by value: the card redraws on every status line, the figures far less often.
  const share = survival === null ? null : survival.survives;
  const level = survival === null ? null : LEVEL[survival.level];
  const arcs = useMemo(() => [{ fraction: share, tone: 'hp' as const, level }], [share, level]);
  const costValue = cost === null ? null : cost.value;
  const parts = useMemo(
    () =>
      costValue === null || hp === null || hp <= 0
        ? null
        : [
            {
              key: 'left',
              label: t('cards.room.fight.left'),
              value: Math.max(0, hp - costValue),
              tone: 'hp' as const
            },
            {
              key: 'cost',
              label: t('cards.room.fight.cost'),
              value: Math.min(hp, costValue),
              tone: 'bad' as const
            }
          ],
    [costValue, hp]
  );
  return (
    <div className="room-fight">
      <Ring
        arcs={arcs}
        label={
          survives === null
            ? t('cards.combat.survival.unknown')
            : t('cards.combat.survival.walkOut', { percent: survives })
        }
      >
        {survives === null ? '—' : survives}
      </Ring>
      <div className="room-fight-words">
        <span className="room-fight-label">{t('cards.verdict.label')}</span>
        {cost === null ? (
          <span className="quiet-note">{t('cards.verdict.roomUnknown')}</span>
        ) : (
          <span>
            <span className={deadly ? 'chip bad' : undefined}>
              {cost.from === 'bound'
                ? t('cards.verdict.roomCostBound', { hp: Math.round(cost.value) })
                : t('cards.verdict.roomCostAbout', { hp: Math.round(cost.value) })}
            </span>
            {hp !== null && (
              <span className="quiet-note"> {t('cards.verdict.ofYours', { hp })}</span>
            )}
          </span>
        )}
        {parts !== null && hp !== null && (
          <SplitBar
            format={wholeHp}
            label={t('cards.verdict.ofYours', { hp })}
            legend={false}
            parts={parts}
          />
        )}
      </div>
    </div>
  );
}
