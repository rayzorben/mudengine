import { memo, useEffect, useState, type CSSProperties } from 'react';

import Icon from './Icon';
import KonamiOdds from './KonamiOdds';
import { clock } from '../lib/clock';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import {
  doingText,
  goalDetail,
  goalIcon,
  goalName,
  goalText,
  kindText,
  layerRows,
  lessonDetail,
  outcomeIcon,
  outcomeText,
  outcomeTone,
  shareText,
  tookText,
  triggerText
} from '../lib/konami';
import { compact } from '../lib/rates';
import { tuning } from '../lib/tuning';
import type { KonamiSnapshot } from '@shared/konamiRecords';

export interface KonamiNowProps {
  konami: KonamiSnapshot;
  onChoose(key: string): void;
  /** Opens a decision on the Decisions face. */
  onOpenDecision(id: string): void;
  onSeeLessons(): void;
}

/** How long the plan has run, redrawn on its own clock so the card does not tick. */
const Elapsed = memo(function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), tuning().clockTickMs);
    return () => window.clearInterval(id);
  }, []);
  return <span className="konami-meta-item">{tookText(now - since)}</span>;
});

/**
 * How sure the provider was of its choice: an arc of the circle, tinted from
 * `--danger` to `--ok` by the share itself, so no threshold is chosen
 * anywhere. While it asks, the arc turns.
 */
function ConfidenceRing({ p, asking }: { p: number | null; asking: boolean }) {
  const radius = 26;
  const round = 2 * Math.PI * radius;
  const share = asking ? 0.28 : (p ?? 0);
  return (
    <div
      className="konami-ring"
      data-asking={asking}
      style={{ '--share': p ?? 0 } as CSSProperties}
    >
      <svg aria-hidden viewBox="0 0 64 64">
        <circle className="konami-ring-track" cx="32" cy="32" r={radius} />
        <circle
          className="konami-ring-arc"
          cx="32"
          cy="32"
          r={radius}
          strokeDasharray={`${share * round} ${round}`}
        />
      </svg>
      <div className="konami-ring-text">
        {asking ? (
          <span className="konami-pulse" />
        ) : p === null ? (
          <span className="konami-ring-none">–</span>
        ) : (
          <>
            <strong>{shareText(p)}</strong>
            <span>{t('cards.konami.sure')}</span>
          </>
        )}
      </div>
    </div>
  );
}

function KonamiNow({ konami, onChoose, onOpenDecision, onSeeLessons }: KonamiNowProps) {
  const plan = konami.plan;
  const current = plan === null ? undefined : konami.decisions[0];
  const sure = current?.options.find((option) => option.chosen)?.p ?? null;
  const settings = plan === null ? [] : layerRows(plan.layer);
  const applying = konami.lessons.filter((lesson) => lesson.applies);
  const detail = plan === null ? null : goalDetail(plan.goal);
  const running = konami.provider !== null && !konami.paused;
  return (
    <div className="scroller konami-now">
      <section
        className="konami-hero"
        data-kind={plan?.goal.kind ?? 'none'}
        data-state={konami.asking ? 'asking' : konami.paused ? 'paused' : 'running'}
      >
        <ConfidenceRing asking={konami.asking} p={sure} />
        <div className="konami-hero-text">
          {plan === null ? (
            <div className="konami-goal quiet">
              {konami.asking && konami.provider !== null
                ? t('cards.konami.emptyAsking', { provider: konami.provider })
                : t('cards.konami.emptyPlan')}
            </div>
          ) : (
            <>
              <div className="konami-eyebrow">
                <Icon name={goalIcon(plan.goal)} />
                <span>{kindText(plan.goal)}</span>
              </div>
              <div className="konami-goal" title={goalText(plan.goal)}>
                {goalName(plan.goal)}
              </div>
              {detail !== null && <div className="konami-goal-detail">{detail}</div>}
              {konami.activity !== null && (
                <div className="konami-doing">
                  <span className="konami-pulse" data-tone="on" />
                  <span>{doingText(konami.activity.doing)}</span>
                  {konami.activity.walk !== null && konami.activity.walk.total > 0 && (
                    <>
                      <span
                        aria-hidden
                        className="konami-bar walk"
                        style={
                          {
                            '--fill': konami.activity.walk.done / konami.activity.walk.total
                          } as CSSProperties
                        }
                      >
                        <span />
                      </span>
                      <span className="konami-when">
                        {t('cards.navigation.route.meterLabel', konami.activity.walk)}
                      </span>
                    </>
                  )}
                </div>
              )}
              {current !== undefined && (
                <div className="konami-meta">
                  <span className="konami-meta-item">
                    {t('cards.konami.chosenAt', { time: clock(current.at) })}
                  </span>
                  {current.outcome === 'applied' && <Elapsed since={current.at} />}
                  {konami.expSince !== null && konami.expSince !== 0 && (
                    <span
                      className="konami-meta-item"
                      data-tone={konami.expSince > 0 ? 'ok' : undefined}
                    >
                      {t('cards.konami.expSince', {
                        exp: `${konami.expSince > 0 ? '+' : ''}${compact(konami.expSince)}`
                      })}
                    </span>
                  )}
                  <span className="konami-meta-item">
                    {t('cards.konami.because', { trigger: triggerText(current.trigger) })}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {!konami.automation && (
        <div className="konami-banner" data-tone="bad">
          <Icon name="close" />
          <span>{t('cards.konami.automationOff')}</span>
        </div>
      )}
      {konami.pending !== null && (
        <div className="konami-banner" data-tone="pending">
          <span className="konami-pulse" />
          <span>{t('cards.konami.pending', { trigger: triggerText(konami.pending) })}</span>
        </div>
      )}
      {konami.refusal !== null && (
        <div className="konami-banner" data-tone="bad">
          <Icon name="close" />
          <span>{konami.refusal}</span>
        </div>
      )}

      {current !== undefined && current.options.length > 0 && (
        <section className="konami-section">
          <header className="konami-section-head" title={t('cards.konami.oddsHint')}>
            <span>{t('cards.konami.headings.odds')}</span>
            <span className="konami-count">{current.options.length}</span>
          </header>
          <KonamiOdds
            onChoose={running && current.outcome === 'applied' ? onChoose : undefined}
            options={current.options}
          />
        </section>
      )}

      {plan !== null && (
        <section className="konami-section">
          <header className="konami-section-head">
            <span>{t('cards.konami.headings.settings')}</span>
          </header>
          {settings.length > 0 && (
            <div className="konami-settings">
              {settings.map(([name, value]) => (
                <span className="konami-setting" key={name}>
                  <span>{name}</span>
                  <strong>{value}</strong>
                </span>
              ))}
            </div>
          )}
          <p className="konami-hint">{t('cards.konami.goalSwitches')}</p>
        </section>
      )}

      {konami.decisions.length > 0 && (
        <section className="konami-section">
          <header className="konami-section-head">
            <span>{t('cards.konami.headings.recent')}</span>
          </header>
          <div className="konami-streak">
            {[...konami.decisions].reverse().map((decision) => {
              const outcome = decision.outcome;
              return (
                <button
                  aria-label={`${clock(decision.at)} ${outcomeText(outcome)}`}
                  className="konami-streak-dot"
                  data-tone={outcomeTone(outcome)}
                  key={decision.id}
                  onClick={() => onOpenDecision(decision.id)}
                  onMouseDown={keepFocus}
                  title={`${clock(decision.at)} · ${
                    decision.plan === null ? (decision.refusal ?? '') : goalText(decision.plan.goal)
                  } · ${outcomeText(outcome)}`}
                  type="button"
                >
                  <Icon name={outcomeIcon(outcome)} />
                </button>
              );
            })}
          </div>
        </section>
      )}

      {applying.length > 0 && (
        <section className="konami-section">
          <header className="konami-section-head">
            <span>{t('cards.konami.headings.lessons')}</span>
            <span className="konami-count">{applying.length}</span>
            <button
              className="quiet konami-link"
              onClick={onSeeLessons}
              onMouseDown={keepFocus}
              type="button"
            >
              {t('cards.konami.seeAll')}
            </button>
          </header>
          <ul className="konami-lesson-lines">
            {applying.slice(0, tuning().konamiLessonsListed).map((lesson) => (
              <li data-tone={outcomeTone(lesson.outcome)} key={lesson.at}>
                <Icon name={outcomeIcon(lesson.outcome)} />
                <span className="konami-lesson-level">
                  {lesson.level === null ? '?' : t('cards.konami.level', { level: lesson.level })}
                </span>
                <span className="konami-lesson-goal">{goalName(lesson.goal)}</span>
                <span className="konami-lesson-why">{lessonDetail(lesson)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export default memo(KonamiNow);
