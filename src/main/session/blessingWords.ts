/**
 * What `BlessingChoice` says (todo 10): the blessings chosen for a fight, each
 * with what it adds, its upkeep and how long it lasts and from where, the
 * ones passed over and why, and a refusal with what is cast instead, as the
 * rows `choiceSentences` makes the notice and the Spells page from. An item's
 * blessing is named with the item it is used from.
 */
import { t } from '../app/i18n';
import type {
  BlessingChoice,
  BlessingChoiceView,
  BlessingMeasure,
  BlessingPick,
  BlessingRefusal
} from '../../shared/blessingchoice';

/** The choice made for the fight at `room`, a row per blessing kept up and per one passed over. */
export function choiceView(
  choice: Extract<BlessingChoice, { kind: 'chosen' }>,
  room: string
): BlessingChoiceView {
  return {
    room,
    picks: choice.picks.map((pick) => pickWords(pick, choice.by)),
    passed: choice.passed.map(({ name, why }) =>
      t('automation.blessing.passedOne', { spell: name, why: whyWords(why) })
    ),
    refused: null
  };
}

/** A refusal for the fight at `room` (null: no fight), and what is kept instead. */
export function refusalView(
  why: BlessingRefusal,
  room: string | null,
  keptLast: boolean
): BlessingChoiceView {
  const kept = keptLast ? t('automation.blessing.keptLast') : t('automation.blessing.keptList');
  return {
    room,
    picks: [],
    passed: [],
    refused: t('automation.blessing.refusal', { why: whyWords(why), kept })
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
  const spell =
    candidate.via.kind === 'item'
      ? t('automation.blessing.fromItem', { spell: candidate.spell.name, item: candidate.via.item })
      : candidate.name;
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
    case 'same-spell':
      return t('automation.blessing.whySameSpell');
    case 'not-worn':
      return t('automation.blessing.whyNotWorn');
    case 'swap-too-often':
      return t('automation.blessing.whySwapTooOften');
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
