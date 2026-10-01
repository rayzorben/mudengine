import { memo } from 'react';

import Icon from './Icon';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import {
  goalIcon,
  goalText,
  hoursText,
  roadAfter,
  roadEndText,
  roadStepDetail,
  roadStepIcon,
  roadStepTitle,
  startsText
} from '../lib/konami';
import type { KonamiGoal } from '@shared/konami';
import { goalKey } from '@shared/konamiLessons';
import type { KonamiSnapshot } from '@shared/konamiRecords';
import type { RoadStep } from '@shared/konamiRoad';

export interface KonamiRoadProps {
  konami: KonamiSnapshot;
  /** The player's no to a goal, by `goalKey`; `bad` also tells the provider. */
  onDecline(key: string, bad: boolean): void;
  onRestore(key: string): void;
}

/** The goals reached most recently, oldest first: the road behind. */
const BEHIND = 2;

/** The level the road reaches: the last training on it, else where the character stands. */
function reached(steps: readonly RoadStep[], from: number): number {
  return steps.reduce((level, step) => (step.kind === 'train' ? step.level : level), from);
}

/** *Not this* and *Bad*, for a goal that can be said no to. */
function Verdicts({
  goal,
  onDecline
}: {
  goal: KonamiGoal;
  onDecline(key: string, bad: boolean): void;
}) {
  if (goal.kind !== 'hunt' && goal.kind !== 'buy') return null;
  const key = goalKey(goal);
  return (
    <span className="konami-road-verdicts">
      <button
        className="quiet konami-road-verdict"
        onClick={() => onDecline(key, false)}
        onMouseDown={keepFocus}
        title={t('cards.konami.road.declineHint')}
        type="button"
      >
        <Icon name="close" />
        {t('cards.konami.road.decline')}
      </button>
      <button
        className="quiet konami-road-verdict"
        data-tone="bad"
        onClick={() => onDecline(key, true)}
        onMouseDown={keepFocus}
        title={t('cards.konami.road.badHint')}
        type="button"
      >
        <Icon name="flag" />
        {t('cards.konami.road.bad')}
      </button>
    </span>
  );
}

/**
 * The road ahead (todo 68), in the progression's three words: the goals just
 * reached at the quietest ink, the goal in hand as the one loud row, and every
 * goal projected after it at ordinary ink, each with when it starts and what
 * it costs or brings. Any hunt or purchase on it can be turned down, or
 * marked bad, before the planner gets there; what was said no to is listed at
 * the foot, each with a way back.
 */
function KonamiRoad({ konami, onDecline, onRestore }: KonamiRoadProps) {
  const road = konami.road;
  const plan = konami.plan;
  const projected = road?.steps ?? [];
  const { inHand, ahead: steps } = roadAfter(projected, plan?.goal ?? null);
  const behind = konami.decisions
    .flatMap((row) =>
      row.outcome === 'done' && row.plan !== null ? [{ id: row.id, goal: row.plan.goal }] : []
    )
    .slice(0, BEHIND)
    .reverse();
  const from = konami.level;
  const to = from === null ? null : reached(projected, from);
  const last = projected.at(-1);
  const hours = last === undefined ? 0 : last.at + (last.kind === 'hunt' ? last.hours : 0);
  const end = road === null || to === null ? null : roadEndText(road.end, to);

  return (
    <div className="scroller konami-road">
      <section className="konami-road-hero">
        <div className="konami-eyebrow">{t('cards.konami.road.eyebrow')}</div>
        {from !== null && to !== null && projected.length > 0 ? (
          <div className="konami-road-summary">
            {t('cards.konami.road.summary', { from, to, time: hoursText(hours) })}
          </div>
        ) : (
          <div className="konami-road-summary quiet">{t('cards.konami.road.empty')}</div>
        )}
      </section>

      <ol className="progression konami-road-steps">
        {behind.map((row) => (
          <li data-progress="done" key={row.id}>
            <span className="step-name">{goalText(row.goal)}</span>
          </li>
        ))}
        {plan !== null && plan.goal.kind !== 'wait' && (
          <li data-progress="now">
            <span className="konami-road-icon">
              <Icon name={goalIcon(plan.goal)} />
            </span>
            <div className="konami-road-main">
              <span className="step-name">{goalText(plan.goal)}</span>
              {inHand !== null && (
                <span className="konami-road-detail">{roadStepDetail(inHand)}</span>
              )}
            </div>
            <span className="konami-road-when">{t('cards.konami.road.now')}</span>
            <Verdicts goal={plan.goal} onDecline={onDecline} />
          </li>
        )}
        {steps.map((step, index) => (
          <li
            data-kind={step.kind}
            data-progress="left"
            key={`${index}-${step.kind}-${step.kind === 'train' ? step.level : goalKey(step.goal)}`}
          >
            <span className="konami-road-icon">
              <Icon name={roadStepIcon(step)} />
            </span>
            <div className="konami-road-main">
              <span className="step-name">{roadStepTitle(step)}</span>
              <span className="konami-road-detail">{roadStepDetail(step)}</span>
            </div>
            <span className="konami-road-when">{startsText(step.at)}</span>
            {step.kind !== 'train' && <Verdicts goal={step.goal} onDecline={onDecline} />}
          </li>
        ))}
      </ol>
      {end !== null && <p className="konami-hint">{end}</p>}

      {road !== null && road.marks.length > 0 && (
        <section className="konami-section">
          <header className="konami-section-head">
            <span>{t('cards.konami.road.marks')}</span>
            <span className="konami-count">{road.marks.length}</span>
          </header>
          <ul className="konami-road-marks">
            {road.marks.map((mark) => (
              <li data-bad={mark.bad} key={mark.key}>
                <Icon name={mark.bad ? 'flag' : 'close'} />
                <span className="konami-road-mark-goal">{goalText(mark.goal)}</span>
                {mark.bad && <span className="chip bad">{t('cards.konami.road.markedBad')}</span>}
                <button
                  className="quiet konami-link"
                  onClick={() => onRestore(mark.key)}
                  onMouseDown={keepFocus}
                  title={t('cards.konami.road.restoreHint')}
                  type="button"
                >
                  <Icon name="undo" />
                  {t('cards.konami.road.restore')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export default memo(KonamiRoad);
