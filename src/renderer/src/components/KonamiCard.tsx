import { memo, useState } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import { clock } from '../lib/clock';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { SessionId } from '@shared/ipc';
import type { KonamiGoal, KonamiLayer, KonamiQuestionName, KonamiTrigger } from '@shared/konami';
import type { KonamiIncidentKind, KonamiOutcome, KonamiSnapshot } from '@shared/konamiRecords';

export interface KonamiCardProps extends CardChrome {
  konami: KonamiSnapshot;
  session: SessionId;
}

/** A goal in one line. */
function goalText(goal: KonamiGoal): string {
  switch (goal.kind) {
    case 'hunt':
      return t('cards.konami.goal.hunt', { name: goal.name });
    case 'buy':
      return t('cards.konami.goal.buy', { item: goal.name, shop: goal.shop, copper: goal.copper });
    case 'train':
      return t('cards.konami.goal.train');
    case 'wait':
      return t('cards.konami.goal.wait');
    default: {
      const never: never = goal;
      return never;
    }
  }
}

/** Why a plan was asked for, in words. */
function triggerText(trigger: KonamiTrigger): string {
  switch (trigger) {
    case 'entered':
      return t('cards.konami.trigger.entered');
    case 'level':
      return t('cards.konami.trigger.level');
    case 'trained':
      return t('cards.konami.trigger.trained');
    case 'death':
      return t('cards.konami.trigger.death');
    case 'goal-done':
      return t('cards.konami.trigger.goalDone');
    case 'goal-refused':
      return t('cards.konami.trigger.goalRefused');
    case 'cash-step':
      return t('cards.konami.trigger.cashStep');
    case 'upgrade-affordable':
      return t('cards.konami.trigger.upgradeAffordable');
    case 'stuck':
      return t('cards.konami.trigger.stuck');
    case 'asked':
      return t('cards.konami.trigger.asked');
    default: {
      const never: never = trigger;
      return never;
    }
  }
}

function outcomeText(outcome: KonamiOutcome): string {
  switch (outcome) {
    case 'applied':
      return t('cards.konami.outcome.applied');
    case 'done':
      return t('cards.konami.outcome.done');
    case 'refused':
      return t('cards.konami.outcome.refused');
    case 'replaced':
      return t('cards.konami.outcome.replaced');
    case 'failed':
      return t('cards.konami.outcome.failed');
    default: {
      const never: never = outcome;
      return never;
    }
  }
}

function incidentText(kind: KonamiIncidentKind): string {
  switch (kind) {
    case 'death':
      return t('cards.konami.incident.death');
    case 'stuck':
      return t('cards.konami.incident.stuck');
    default: {
      const never: never = kind;
      return never;
    }
  }
}

/** A question's name as the card says it; a blessing's names its spell. */
function questionText(question: KonamiQuestionName): string {
  switch (question) {
    case 'goal':
      return t('cards.konami.question.goal');
    case 'attack':
      return t('cards.konami.layer.attack');
    case 'opener':
      return t('cards.konami.layer.opener');
    case 'sneak':
      return t('cards.konami.layer.sneak');
    case 'heal':
      return t('cards.konami.layer.heal');
    case 'restBelow':
      return t('cards.konami.layer.restBelow');
    case 'trainFirst':
      return t('cards.konami.layer.trainFirst');
    default:
      return t('cards.konami.question.bless', { spell: question.slice('bless_'.length) });
  }
}

/** The plan's settings, one row each, in the order the questions are asked. */
function layerRows(layer: KonamiLayer): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (layer.attack !== undefined) rows.push([t('cards.konami.layer.attack'), layer.attack]);
  if (layer.opener !== undefined) {
    rows.push([t('cards.konami.layer.opener'), layer.opener || t('cards.konami.layer.none')]);
  }
  if (layer.sneak !== undefined) {
    rows.push([
      t('cards.konami.layer.sneak'),
      layer.sneak ? t('cards.konami.layer.yes') : t('cards.konami.layer.no')
    ]);
  }
  if (layer.heal !== undefined) rows.push([t('cards.konami.layer.heal'), layer.heal]);
  if (layer.blessings !== undefined) {
    rows.push([
      t('cards.konami.layer.blessings'),
      layer.blessings.join(', ') || t('cards.konami.layer.none')
    ]);
  }
  if (layer.restBelow !== undefined) {
    rows.push([t('cards.konami.layer.restBelow'), `${Math.round(layer.restBelow * 100)}%`]);
  }
  if (layer.trainFirst !== undefined) {
    rows.push([t('cards.konami.layer.trainFirst'), layer.trainFirst]);
  }
  return rows;
}

/**
 * The "what to do next" planner (todo 59): the plan in force and why it was
 * asked for, the provider's picks with how sure it was, the settings the plan
 * lays over the character's own, the recent decisions and the logs written.
 * Three buttons under it: pause, ask again, keep these settings.
 */
function KonamiCard({ konami, session, ...chrome }: KonamiCardProps) {
  const api = window.mudengine;
  const [keepError, setKeepError] = useState<string | null>(null);
  const badge = !konami.on ? (
    <span className="chip off">{t('cards.konami.badge.off')}</span>
  ) : konami.provider === null ? (
    <span className="chip warn">{t('cards.konami.badge.noProvider')}</span>
  ) : konami.paused ? (
    <span className="chip warn">{t('cards.konami.badge.paused')}</span>
  ) : konami.asking ? (
    <span className="chip on">{t('cards.konami.badge.asking')}</span>
  ) : (
    <span className="chip on">{t('cards.konami.badge.running')}</span>
  );
  const plan = konami.plan;
  return (
    <BentoCard
      {...chrome}
      badge={badge}
      className="konami-card"
      paned
      title={t('cards.konami.title')}
    >
      <div className="scroller">
        {!konami.on ? (
          <div className="empty">{t('cards.konami.emptyOff')}</div>
        ) : (
          <>
            {konami.refusal !== null && <div className="empty">{konami.refusal}</div>}
            {keepError !== null && <div className="empty">{keepError}</div>}
            <div className="trace-heading">{t('cards.konami.headings.plan')}</div>
            <div className="trace">
              {plan === null ? (
                <div className="empty">{t('cards.konami.emptyPlan')}</div>
              ) : (
                <div className="row">
                  <span className="trace-command">{goalText(plan.goal)}</span>
                </div>
              )}
              {konami.pending !== null && (
                <div className="row">
                  <span className="trace-reason">
                    {t('cards.konami.pending', { trigger: triggerText(konami.pending) })}
                  </span>
                </div>
              )}
              {plan?.picks.map((pick) => (
                <div className="row" key={pick.question}>
                  <span className="trace-priority">{`${Math.round(pick.p * 100)}%`}</span>
                  <span className="trace-command">{questionText(pick.question)}</span>
                </div>
              ))}
            </div>
            {plan !== null && (
              <>
                <div className="trace-heading">{t('cards.konami.headings.settings')}</div>
                <div className="trace">
                  <div className="row">
                    <span className="trace-reason">{t('cards.konami.goalSwitches')}</span>
                  </div>
                  {layerRows(plan.layer).map(([name, value]) => (
                    <div className="row" key={name}>
                      <span className="trace-command">{name}</span>
                      <span className="trace-reason">{value}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            <div className="trace-heading">{t('cards.konami.headings.decisions')}</div>
            <div className="trace">
              {konami.decisions.length === 0 ? (
                <div className="empty">{t('cards.konami.emptyDecisions')}</div>
              ) : (
                konami.decisions.map((decision) => (
                  <div
                    className={`row${decision.outcome === 'failed' || decision.outcome === 'refused' ? ' blocked' : ''}`}
                    key={decision.id}
                  >
                    <span className="trace-at">{clock(decision.at)}</span>
                    <span className="trace-priority">{triggerText(decision.trigger)}</span>
                    <span className="trace-command">
                      {decision.plan === null
                        ? (decision.refusal ?? '')
                        : goalText(decision.plan.goal)}
                    </span>
                    <span className="trace-reason">
                      {decision.outcomeWhy === null
                        ? outcomeText(decision.outcome)
                        : t('cards.konami.outcomeWhy', {
                            outcome: outcomeText(decision.outcome),
                            why: decision.outcomeWhy
                          })}
                    </span>
                  </div>
                ))
              )}
            </div>
            {konami.incidents.length > 0 && (
              <>
                <div className="trace-heading">{t('cards.konami.headings.logs')}</div>
                <div className="trace">
                  {konami.incidents.map((incident) => (
                    <div className="row blocked" key={`${incident.kind}-${incident.at}`}>
                      <span className="trace-at">{clock(incident.at)}</span>
                      <span className="trace-priority">{incidentText(incident.kind)}</span>
                      <span className="trace-reason">{incident.path ?? ''}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
      {konami.on && (
        <div className="loop-controls konami-actions">
          <button
            className="quiet"
            onClick={() => void api?.konamiPause(session)}
            onMouseDown={keepFocus}
            type="button"
          >
            {konami.paused ? t('cards.konami.resume') : t('cards.konami.pause')}
          </button>
          <button
            className="quiet"
            disabled={konami.paused || konami.asking}
            onClick={() => void api?.konamiAsk(session)}
            onMouseDown={keepFocus}
            type="button"
          >
            {t('cards.konami.askAgain')}
          </button>
          <button
            className="quiet"
            disabled={plan === null}
            onClick={() => void api?.konamiKeep(session).then(setKeepError)}
            onMouseDown={keepFocus}
            title={t('cards.konami.keepHint')}
            type="button"
          >
            {t('cards.konami.keep')}
          </button>
        </div>
      )}
    </BentoCard>
  );
}

export default memo(KonamiCard);
