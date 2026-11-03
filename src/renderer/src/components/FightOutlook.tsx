/**
 * How the room's fight goes, read part way (todo 03), drawn under the odds
 * ring: a column per round the run was read at (won, still fighting, dead),
 * how the fights ended (won, run from, dead; todo 16), the worst single round
 * and each monster fought on its own, out of the odds book. The rounds stop
 * at the first that reads 100% won. Large, each round is said in words too.
 * See `mudengine-ui` › `parts/cards.md`.
 */
import { Fragment } from 'react';

import type { Odds, Survival } from '@shared/survival';
import type { RoomVerdict } from '@shared/verdict';
import { t } from '../lib/i18n';
import { horizonsShown, percent, survivalVital } from '../lib/outlook';
import EntityName, { type Inspect } from './EntityName';
import SplitBar, { type SplitPart } from './viz/SplitBar';
import StackChart, { type StackColumn } from './viz/StackChart';

/** A share of fights as the legend prints it. */
const share = (_: number, of: number): string =>
  t('cards.combat.survival.figure', { percent: percent(of) });

/** The chip class a level of odds wears, as the badge chips do. */
const CHIP: Record<ReturnType<typeof survivalVital>, string> = {
  ok: 'chip on',
  caution: 'chip warn',
  critical: 'chip bad',
  unknown: 'chip off'
};

/**
 * One monster fought on its own, as a chip: its odds when run, else the odds
 * book's state in the title. The name is drawn beside it by the caller, as the
 * control that opens the monster.
 */
export function AloneChip({ name, odds }: { name: string; odds: Odds }) {
  if (odds.kind === 'run') {
    return (
      <span className={CHIP[survivalVital(odds.survival.level)]} title={aloneFigure(name, odds)}>
        {t('cards.combat.survival.figure', { percent: percent(odds.survival.survives) })}
      </span>
    );
  }
  return (
    <span className="chip off" title={aloneWords(name, odds)}>
      …
    </span>
  );
}

/** One monster fought on its own, said for each state the odds book can be in. */
export function aloneFigure(name: string, odds: Odds): string {
  return odds.kind === 'run'
    ? t('cards.combat.outlook.alone', { name, percent: percent(odds.survival.survives) })
    : aloneWords(name, odds);
}

/** The odds book's state for a fight it has not run, in words. */
function aloneWords(name: string, odds: Exclude<Odds, { kind: 'run' }>): string {
  switch (odds.kind) {
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

/** The fights at one round, cut into won, still fighting and dead. */
function columnsOf(survival: Survival): StackColumn[] {
  return horizonsShown(survival.horizons).map((at) => {
    const parts: SplitPart[] = [
      { key: 'won', label: t('cards.combat.outlook.partWon'), value: at.won, tone: 'ok' },
      {
        key: 'fighting',
        label: t('cards.combat.outlook.partFighting'),
        value: Math.max(0, at.standing - at.won),
        tone: 'warn'
      },
      {
        key: 'dead',
        label: t('cards.combat.outlook.partDead'),
        value: Math.max(0, 1 - at.standing),
        tone: 'bad'
      }
    ];
    return {
      key: String(at.rounds),
      label: String(at.rounds),
      note: t('cards.combat.outlook.lostShort', { mean: Math.round(at.lost.mean) }),
      title: `${t('cards.combat.outlook.byRound', { rounds: at.rounds })}: ${horizonWords(at)}`,
      parts
    };
  });
}

function horizonWords(at: Survival['horizons'][number]): string {
  return `${t('cards.combat.outlook.standing', {
    standing: percent(at.standing),
    won: percent(at.won)
  })} · ${t('cards.combat.outlook.lost', { mean: Math.round(at.lost.mean), most: at.lost.most })}`;
}

/** How the fights ended. Still going at the cap counts as walked out of, and is drawn only when any were. */
function endOf(survival: Survival): SplitPart[] {
  const going = Math.max(0, survival.survives - survival.won - survival.ran);
  return [
    { key: 'won', label: t('cards.combat.outlook.partWon'), value: survival.won, tone: 'ok' },
    { key: 'ran', label: t('cards.combat.outlook.partRan'), value: survival.ran, tone: 'accent' },
    ...(percent(going) > 0
      ? [
          {
            key: 'fighting',
            label: t('cards.combat.outlook.partFighting'),
            value: going,
            tone: 'warn'
          } satisfies SplitPart
        ]
      : []),
    {
      key: 'dead',
      label: t('cards.combat.outlook.partDead'),
      value: Math.max(0, 1 - survival.survives),
      tone: 'bad'
    }
  ];
}

export default function FightOutlook({
  verdict,
  inspect
}: {
  verdict: RoomVerdict;
  /** A monster's name clicked: the realm's answer, beside it. */
  inspect?: Inspect;
}) {
  const survival = verdict.survival;
  const alone = verdict.monsters.flatMap(({ name, alone: odds }) =>
    odds === undefined ? [] : [{ name, odds }]
  );
  if (survival === null && alone.length === 0) return null;
  return (
    <div className="combat-outlook">
      {survival !== null && (
        <>
          <div className="combat-outlook-head">{t('cards.combat.outlook.chartHead')}</div>
          <StackChart columns={columnsOf(survival)} label={t('cards.combat.outlook.chartHead')} />
          <div className="combat-outlook-head">{t('cards.combat.outlook.endLabel')}</div>
          <SplitBar
            format={share}
            label={t('cards.combat.outlook.endFigure', {
              won: percent(survival.won),
              ran: percent(survival.ran)
            })}
            parts={endOf(survival)}
          />
        </>
      )}
      <dl className="readout">
        {survival !== null && (
          <>
            <dt>{t('cards.combat.outlook.worstLabel')}</dt>
            <dd>{t('cards.combat.outlook.worstFigure', { hp: survival.worstRound })}</dd>
          </>
        )}
        {alone.length > 0 && (
          <>
            <dt>{t('cards.combat.outlook.aloneLabel')}</dt>
            <dd className="combat-alone">
              {alone.map(({ name, odds }) => (
                <span className="combat-alone-one" key={name}>
                  <EntityName inspect={inspect} name={name} /> <AloneChip name={name} odds={odds} />
                </span>
              ))}
            </dd>
          </>
        )}
        {/* Large, every round in words: the most lost by then is said only here. */}
        {survival !== null &&
          horizonsShown(survival.horizons).map((at) => (
            <Fragment key={at.rounds}>
              <dt className="from-large">
                {t('cards.combat.outlook.byRound', { rounds: at.rounds })}
              </dt>
              <dd className="from-large">{horizonWords(at)}</dd>
            </Fragment>
          ))}
      </dl>
    </div>
  );
}
