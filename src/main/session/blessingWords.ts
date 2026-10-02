/**
 * What `BlessingChoice` says (todo 10): the blessings chosen for a fight, each
 * with what it adds, its upkeep and how long it lasts and from where, the
 * ones passed over and why, and a refusal with what is cast instead.
 */
import { t } from '../app/i18n';
import type {
  BlessingChoice,
  BlessingMeasure,
  BlessingPick,
  BlessingRefusal
} from '../../shared/blessingchoice';

/** The choice made for the fight at `room`, in one notice. */
export function choiceWords(
  choice: Extract<BlessingChoice, { kind: 'chosen' }>,
  room: string
): string {
  const message =
    choice.picks.length === 0
      ? t('automation.blessing.choseNone', { room })
      : t('automation.blessing.chose', {
          room,
          picks: choice.picks.map((pick) => pickWords(pick, choice.by)).join('; ')
        });
  const passed = choice.passed
    .map(({ name, why }) => t('automation.blessing.passedOne', { spell: name, why: whyWords(why) }))
    .join('; ');
  return passed.length === 0
    ? message
    : `${message} ${t('automation.blessing.passed', { passed })}`;
}

/** A refusal for the fight at `room` (null: no fight), and what is kept instead. */
export function refusalWords(
  why: BlessingRefusal,
  room: string | null,
  keptLast: boolean
): { message: string; why: string } {
  const kept = keptLast ? t('automation.blessing.keptLast') : t('automation.blessing.keptList');
  const words = whyWords(why);
  return {
    message:
      room === null
        ? t('automation.blessing.refusedNoFight', { why: words, kept })
        : t('automation.blessing.refused', { room, why: words, kept }),
    why: words
  };
}

function pickWords(pick: BlessingPick, by: BlessingMeasure): string {
  const { candidate } = pick;
  const seconds = Math.round(candidate.duration?.seconds ?? 0);
  const lasts =
    candidate.duration?.from === 'measured'
      ? t('automation.blessing.lastsMeasured', { seconds })
      : t('automation.blessing.lastsRealm', { seconds });
  const upkeep = Math.round(pick.upkeepPerHour);
  const spell = candidate.name;
  switch (by) {
    case 'exp':
      return t('automation.blessing.pickExp', {
        spell,
        gain: Math.round(pick.gain).toLocaleString(),
        upkeep,
        lasts
      });
    case 'survival':
      return t('automation.blessing.pickSurvival', {
        spell,
        gain: Math.round(pick.gain * 100),
        upkeep,
        lasts
      });
    case 'health':
      return t('automation.blessing.pickHealth', {
        spell,
        gain: Math.round(pick.gain * 100),
        upkeep,
        lasts
      });
    default: {
      const never: never = by;
      return never;
    }
  }
}

function whyWords(why: BlessingRefusal): string {
  switch (why) {
    case 'no-fight':
      return t('automation.blessing.whyNoFight');
    case 'unrun':
      return t('automation.blessing.whyUnrun');
    case 'pending':
      return t('automation.blessing.whyPending');
    case 'unknown-mana':
      return t('automation.blessing.whyUnknownMana');
    case 'no-candidates':
      return t('automation.blessing.whyNoCandidates');
    case 'unknown-cost':
      return t('automation.blessing.whyUnknownCost');
    case 'unknown-duration':
      return t('automation.blessing.whyUnknownDuration');
    case 'exclusive':
      return t('automation.blessing.whyExclusive');
    case 'no-gain':
      return t('automation.blessing.whyNoGain');
    case 'over-budget':
      return t('automation.blessing.whyOverBudget');
    default: {
      const never: never = why;
      return never;
    }
  }
}
