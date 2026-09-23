import { useCallback, useEffect, useState, type CSSProperties } from 'react';

import Icon from './Icon';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { tuning } from '../lib/tuning';
import type { QuestRunPhase, QuestRunProgress } from '@shared/quests';
import type { WalkProgress } from '@shared/walk';

/**
 * The run of a quest plan, over the top of this character's console.
 *
 * A multi-step form's own shape: the chain as a row of numbered stops joined
 * by a line, the one being carried lit, what is behind it ticked and quiet,
 * what is still owed in ordinary ink — the progression's three words laid
 * sideways. Above it, the quest, the rank it reaches, the phase in a word and
 * what that phase is about, and the one control a run has: Stop. An ended run
 * stays up saying how it ended, then takes itself down; the × is for sooner.
 * See `mudengine-ui` › quests, *the run is a banner*.
 */
export interface QuestRunBannerProps {
  run: QuestRunProgress;
  /**
   * How far through the walk the run is, for the count beside the step it
   * is heading for (todo 03). Null where nothing is walking, which draws
   * no count — a fraction about no journey is a number with no meaning.
   */
  walk: WalkProgress | null;
  onStop(): void;
  /** A press took the control away: the caret goes back to the console. */
  onSettled(): void;
}

function phaseWord(phase: QuestRunPhase | null): string {
  switch (phase) {
    case 'held':
      return t('terminal.questRun.phase.held');
    case 'listing':
      return t('terminal.questRun.phase.listing');
    case 'fetching':
      return t('terminal.questRun.phase.fetching');
    case 'walking':
      return t('terminal.questRun.phase.walking');
    case 'acting':
      return t('terminal.questRun.phase.acting');
    case 'confirming':
      return t('terminal.questRun.phase.confirming');
    case null:
      return t('terminal.questRun.phase.deciding');
  }
}

/**
 * Which ending this is, by what it says rather than by object: the same
 * ending arrives as a new object with every attach snapshot (a pop-out, a
 * reload), and a banner taken down should stay down for it.
 */
const endingOf = (run: QuestRunProgress): string =>
  `${run.status}|${run.block}|${run.reason ?? ''}`;

export default function QuestRunBanner({ run, walk, onStop, onSettled }: QuestRunBannerProps) {
  /** The ending taken down, by the × or by the clock; a running push clears it. */
  const [down, setDown] = useState<string | null>(null);
  const ended = run.status === 'done' || run.status === 'stopped';
  useEffect(() => {
    if (run.status === 'running') setDown(null);
  }, [run.status]);
  // The ending is a notice, not the record — the stream and the card keep
  // that — and while it stands it covers the console's top rows and takes
  // their clicks, so it leaves on its own. Re-armed per push, which for an
  // ending is once.
  useEffect(() => {
    if (!ended) return;
    const ending = endingOf(run);
    const handle = window.setTimeout(() => setDown(ending), tuning().questRunLingerMs);
    return () => window.clearTimeout(handle);
  }, [run, ended]);
  const dismiss = useCallback(() => {
    setDown(endingOf(run));
    onSettled();
  }, [run, onSettled]);
  const stop = useCallback(() => {
    onStop();
    onSettled();
  }, [onStop, onSettled]);
  if (run.status === 'idle' || (ended && endingOf(run) === down)) return null;

  const running = run.status === 'running';
  const now = run.steps.findIndex((step) => step.state === 'now');
  const nth = now === -1 ? run.steps.length : now + 1;
  /*
   * The walk to the step being headed for, as the fraction it is (todo 03).
   *
   * The run's own `step N of 8` is the *chain*; this is the journey inside
   * the leg, which is the number somebody watching a hundred-step walk
   * actually wants. Drawn only while something is walking: a fraction about
   * a finished or unstarted walk describes nothing.
   */
  const walking = walk !== null && walk.status === 'walking' && walk.total > 0 ? walk : null;
  const walked =
    walking === null
      ? null
      : t('terminal.questRun.walkSteps', { done: walking.done, total: walking.total });
  const through = walking === null ? null : Math.min(1, walking.done / walking.total);
  const ending =
    run.status === 'done' ? t('terminal.questRun.done') : t('terminal.questRun.stopped');
  return (
    <section
      aria-label={t('terminal.questRun.aria')}
      className="quest-banner"
      data-status={run.status}
    >
      <div className="quest-banner-head">
        <Icon name="flag" size={14} />
        <span className="quest-banner-title" title={run.name ?? undefined}>
          {run.name ?? ''}
        </span>
        {run.to !== null && (
          <span className="quest-banner-rank">{t('terminal.questRun.toRank', { to: run.to })}</span>
        )}
        <span className="quest-banner-count">
          {t('terminal.questRun.stepOf', { nth, count: run.steps.length })}
        </span>
        <span className="quest-banner-state">
          {running ? (
            <>
              <span className="chip info">{phaseWord(run.phase)}</span>
              {run.detail !== null && <span className="quest-banner-detail">{run.detail}</span>}
            </>
          ) : (
            <>
              <span className={run.status === 'done' ? 'chip on' : 'chip bad'}>{ending}</span>
              {run.reason !== null && <span className="quest-banner-detail">{run.reason}</span>}
            </>
          )}
          {run.tries > 0 && (
            <span className="chip quiet">
              {t('cards.quests.plan.runTries', { tries: run.tries })}
            </span>
          )}
        </span>
        {running ? (
          <button
            className="quest-plan-btn quest-banner-stop"
            onClick={stop}
            onMouseDown={keepFocus}
            title={t('terminal.questRun.stopTitle')}
            type="button"
          >
            <Icon name="stop" size={12} />
            {t('terminal.questRun.stop')}
          </button>
        ) : (
          <button
            aria-label={t('terminal.questRun.dismiss')}
            className="quiet quest-banner-dismiss"
            onClick={dismiss}
            onMouseDown={keepFocus}
            title={t('terminal.questRun.dismissTitle')}
            type="button"
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      <ol className="quest-banner-steps">
        {run.steps.map((step, index) => (
          <li
            data-progress={step.state}
            key={step.block}
            /*
             * The walk under way, on the step it is walking to and on no
             * other (todo 03): the line into a node is how far through that
             * leg the character is, so the picture and the count beside it
             * are the same fraction. `--through` is unset elsewhere, which
             * the rule draws as no fill at all.
             */
            style={
              step.state === 'now' && through !== null
                ? ({ '--through': `${Math.round(through * 100)}%` } as CSSProperties)
                : undefined
            }
            title={step.words}
          >
            {step.state === 'now' && walked !== null && (
              <span className="quest-banner-walk">{walked}</span>
            )}
            <span className="quest-banner-node">
              {step.state === 'done' ? <Icon name="check" size={12} /> : index + 1}
            </span>
            <span className="quest-banner-name">{step.words}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
