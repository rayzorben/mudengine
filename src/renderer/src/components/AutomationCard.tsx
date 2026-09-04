import { memo } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import { t } from '../lib/i18n';
import type { AutomationSnapshot } from '@shared/automation';

export interface AutomationCardProps extends CardChrome {
  automation: AutomationSnapshot;
}

/** `hh:mm:ss`, because a trace is read against when something happened. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

/**
 * The decision trace: what automation queued, sent, and decided against.
 *
 * "Why did the bot run?" has to be answerable — docs/legacy-assessment.md §6
 * lists that as a reason the outbound side is one arbiter rather than a fan-out
 * of handlers, and an arbiter nobody can see is only half of it.
 *
 * Three things, because they answer three different questions:
 *
 * - **Queued** — what is *about* to happen, and still cancellable.
 * - **Sent** — what actually reached the game, with the reason it was proposed.
 *   A rule firing is not a command sent: an intent can be coalesced away, expire
 *   or be cancelled in between, so the two are recorded separately.
 * - **Rules** — what fired, and just as usefully what did *not*: a rule blocked
 *   by a guard shows which guard, which is the answer to the more common
 *   question of why the bot did nothing.
 */
function AutomationCard({ automation, ...chrome }: AutomationCardProps) {
  const { queue, sent, firings, safety, engagements, enabled } = automation;

  const badge = !enabled ? (
    <span className="chip off">{t('cards.automation.badge.off')}</span>
  ) : queue.suppressed ? (
    // Not an error: the player is typing and automation is standing down,
    // which is the rule, not an exception to it.
    <span className="chip warn">{t('cards.automation.badge.standingDown')}</span>
  ) : (
    <span className="chip off">
      {t('cards.automation.badge.queueStatus', { depth: queue.depth, inFlight: queue.inFlight })}
    </span>
  );

  return (
    <BentoCard
      {...chrome}
      badge={badge}
      className="automation-card"
      scroll
      title={t('cards.automation.title')}
    >
      {!enabled && <div className="empty">{t('cards.automation.emptyDisabled')}</div>}

      {queue.pending.length > 0 && (
        <>
          <div className="trace-heading">{t('cards.automation.headings.queued')}</div>
          <div className="trace">
            {queue.pending.map((intent, index) => (
              <div className="row" key={`${intent.command}-${index}`}>
                <span className="trace-priority">{intent.priority}</span>
                <span className="trace-command">{intent.command}</span>
                <span className="trace-reason">{intent.reason ?? ''}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="trace-heading">{t('cards.automation.headings.sent')}</div>
      <div className="trace">
        {sent.length === 0 ? (
          <div className="empty">{t('cards.automation.emptySent')}</div>
        ) : (
          sent.slice(0, 12).map((entry, index) => (
            <div className="row" key={`${entry.at}-${index}`}>
              <span className="trace-at">{clock(entry.at)}</span>
              <span className="trace-command">{entry.command}</span>
              <span className="trace-reason">{entry.reason ?? entry.priority}</span>
            </div>
          ))
        )}
      </div>

      {/*
        Safety first, and above the rules, because it is the half somebody comes
        to this card to read: "why did the bot run?" — and, just as often,
        "why did it *not* hang up?". A refusal is recorded as well as an action,
        because somebody who turned a safety feature on and saw nothing happen
        needs to see that it decided not to, and what decided it.
      */}
      {safety.length > 0 && (
        <>
          <div className="trace-heading">{t('cards.automation.headings.safety')}</div>
          <div className="trace">
            {safety.slice(0, 8).map((decision, index) => (
              <div
                className={`row${decision.acted ? '' : ' blocked'}`}
                key={`${decision.at}-${index}`}
              >
                <span className="trace-at">{clock(decision.at)}</span>
                <span className="trace-command">{decision.action}</span>
                <span className="trace-reason">
                  {decision.acted
                    ? decision.because
                    : t('cards.automation.safetyRefusedPrefix', {
                        reason: decision.refused ?? decision.because
                      })}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/*
        And fighting, under the escapes and above the rules, in the order the
        client itself consults them.

        The half worth having is the *refusals*: "why did it walk past those two
        thugs" is asked several times an evening, and before this the answer —
        `whileWalking` off with no loop running — took replaying a recorded
        session through a bespoke script to find. One line per answer rather
        than per prompt; `AutoCombat` does that filtering, because it is the
        only thing that knows when the answer changed.
      */}
      {engagements.length > 0 && (
        <>
          <div className="trace-heading">{t('cards.automation.headings.engagements')}</div>
          <div className="trace">
            {engagements.slice(0, 8).map((decision, index) => (
              <div
                className={`row${decision.acted ? '' : ' blocked'}`}
                key={`${decision.at}-${index}`}
              >
                <span className="trace-at">{clock(decision.at)}</span>
                <span className="trace-command">{decision.target}</span>
                <span className="trace-reason">
                  {decision.acted
                    ? decision.because === undefined
                      ? t('cards.automation.engagedPrefix')
                      : t('cards.automation.engagedBecause', { reason: decision.because })
                    : t('cards.automation.safetyRefusedPrefix', {
                        reason: decision.refused ?? ''
                      })}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {firings.length > 0 && (
        <>
          <div className="trace-heading">{t('cards.automation.headings.rules')}</div>
          <div className="trace">
            {firings.slice(0, 12).map((firing, index) => (
              <div
                className={`row${firing.blockedBy === undefined ? '' : ' blocked'}`}
                key={`${firing.at}-${index}`}
              >
                <span className="trace-at">{clock(firing.at)}</span>
                <span className="trace-command">{firing.rule}</span>
                <span className="trace-reason">
                  {/* A blocked rule names the guard that rejected it, which is
                      the answer to "why did nothing happen?". */}
                  {firing.blockedBy === undefined
                    ? firing.commands.join(', ')
                    : t('cards.automation.ruleBlockedPrefix', { guard: firing.blockedBy })}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </BentoCard>
  );
}

export default memo(AutomationCard);
