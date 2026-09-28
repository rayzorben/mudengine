import { Fragment } from 'react';

import type { Odds } from '@shared/survival';
import type { RoomVerdict } from '@shared/verdict';
import { t } from '../lib/i18n';

/**
 * How the room's fight goes, read part way (todo 03): at each of the rounds
 * the run was read at, the share of fights the character is still alive in,
 * the share already won, and the health lost by then, on average and at
 * most; the worst single round; and each monster fought on its own, out of
 * the odds book. Beneath the survival meter, which is the fight's end.
 */
export default function FightOutlook({ verdict }: { verdict: RoomVerdict }) {
  const survival = verdict.survival;
  const alone = verdict.monsters.flatMap(({ name, alone: odds }) =>
    odds === undefined ? [] : [{ name, odds }]
  );
  if (survival === null && alone.length === 0) return null;
  return (
    <dl className="readout combat-outlook">
      {survival?.horizons.map((at) => (
        <Fragment key={at.rounds}>
          <dt>{t('cards.combat.outlook.byRound', { rounds: at.rounds })}</dt>
          <dd>
            {t('cards.combat.outlook.standing', {
              standing: Math.round(at.standing * 100),
              won: Math.round(at.won * 100)
            })}
            {' · '}
            {t('cards.combat.outlook.lost', {
              mean: Math.round(at.lost.mean),
              most: at.lost.most
            })}
          </dd>
        </Fragment>
      ))}
      {survival !== null && (
        <>
          <dt>{t('cards.combat.outlook.worstLabel')}</dt>
          <dd>{t('cards.combat.outlook.worstFigure', { hp: survival.worstRound })}</dd>
        </>
      )}
      {alone.length > 0 && (
        <>
          <dt>{t('cards.combat.outlook.aloneLabel')}</dt>
          <dd>{alone.map(({ name, odds }) => aloneFigure(name, odds)).join(' · ')}</dd>
        </>
      )}
    </dl>
  );
}

/** One monster fought on its own, said for each state the odds book can be in. */
function aloneFigure(name: string, odds: Odds): string {
  switch (odds.kind) {
    case 'run':
      return t('cards.combat.outlook.alone', {
        name,
        percent: Math.round(odds.survival.survives * 100)
      });
    case 'pending':
      return t('cards.combat.outlook.alonePending', { name });
    case 'unread':
      return t('cards.combat.outlook.aloneUnread', { name });
    case 'unrun':
      return t('cards.combat.outlook.aloneUnrun', { name });
    default: {
      const never: never = odds;
      return never;
    }
  }
}
