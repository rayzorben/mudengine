/**
 * The Konami card's words: a goal, a trigger, an outcome and a lesson as the
 * card says them, and the few number forms it draws. Pure; the faces are in
 * `components/Konami*.tsx`.
 */
import type { IconName } from '../components/Icon';
import { t } from './i18n';
import { percent } from './outlook';
import { compact } from './rates';
import type { KonamiGoal, KonamiLayer, KonamiTrigger } from '@shared/konami';
import type { HistoryEvent } from '@shared/konamiHistory';
import type { TrainedAttribute } from '@shared/training';
import type { KonamiLesson } from '@shared/konamiLessons';
import type { KonamiDoing, KonamiIncidentKind, KonamiOutcome } from '@shared/konamiRecords';

/** A goal in one line, for a list. */
export function goalText(goal: KonamiGoal): string {
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

/** A goal as a heading: the spot or the item, without the verb the kind already says. */
export function goalName(goal: KonamiGoal): string {
  switch (goal.kind) {
    case 'hunt':
    case 'buy':
      return goal.name;
    case 'train':
      return t('cards.konami.goalName.train');
    case 'wait':
      return t('cards.konami.goalName.wait');
    default: {
      const never: never = goal;
      return never;
    }
  }
}

/** What a heading's name leaves out: where an item is bought and for how much. */
export function goalDetail(goal: KonamiGoal): string | null {
  if (goal.kind !== 'buy') return null;
  return goal.copper === 0
    ? t('cards.konami.buyFree', { shop: goal.shop })
    : t('cards.konami.buyAt', { shop: goal.shop, copper: goal.copper.toLocaleString() });
}

export function kindText(goal: KonamiGoal): string {
  switch (goal.kind) {
    case 'hunt':
      return t('cards.konami.kind.hunt');
    case 'buy':
      return t('cards.konami.kind.buy');
    case 'train':
      return t('cards.konami.kind.train');
    case 'wait':
      return t('cards.konami.kind.wait');
    default: {
      const never: never = goal;
      return never;
    }
  }
}

export function goalIcon(goal: KonamiGoal): IconName {
  switch (goal.kind) {
    case 'hunt':
      return 'crosshair';
    case 'buy':
      return 'coins';
    case 'train':
      return 'sparkle';
    case 'wait':
      return 'moon';
    default: {
      const never: never = goal;
      return never;
    }
  }
}

/** Why a plan was asked for, in words. */
export function triggerText(trigger: KonamiTrigger): string {
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
    case 'gear':
      return t('cards.konami.trigger.gear');
    case 'stuck':
      return t('cards.konami.trigger.stuck');
    case 'asked':
      return t('cards.konami.trigger.asked');
    case 'vetoed':
      return t('cards.konami.trigger.vetoed');
    case 'chosen':
      return t('cards.konami.trigger.chosen');
    case 'ready':
      return t('cards.konami.trigger.ready');
    case 'review':
      return t('cards.konami.trigger.review');
    case 'saved':
      return t('cards.konami.trigger.saved');
    case 'train-affordable':
      return t('cards.konami.trigger.trainAffordable');
    default: {
      const never: never = trigger;
      return never;
    }
  }
}

/** How an ending reads: the tone its chip and its node wear. */
export type OutcomeTone = 'on' | 'ok' | 'bad' | 'warn' | 'quiet';

export function outcomeText(outcome: KonamiOutcome): string {
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
    case 'vetoed':
      return t('cards.konami.outcome.vetoed');
    case 'died':
      return t('cards.konami.outcome.died');
    default: {
      const never: never = outcome;
      return never;
    }
  }
}

export function outcomeTone(outcome: KonamiOutcome): OutcomeTone {
  switch (outcome) {
    case 'applied':
      return 'on';
    case 'done':
      return 'ok';
    case 'died':
    case 'failed':
      return 'bad';
    case 'refused':
    case 'vetoed':
      return 'warn';
    case 'replaced':
      return 'quiet';
    default: {
      const never: never = outcome;
      return never;
    }
  }
}

export function outcomeIcon(outcome: KonamiOutcome): IconName {
  switch (outcome) {
    case 'applied':
      return 'play';
    case 'done':
      return 'check';
    case 'died':
      return 'flame';
    case 'failed':
    case 'refused':
    case 'vetoed':
      return 'close';
    case 'replaced':
      return 'next';
    default: {
      const never: never = outcome;
      return never;
    }
  }
}

export function incidentText(kind: KonamiIncidentKind): string {
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

/** What the goal is doing now, in full: which trainer and where, which shop, which room. */
export function doingText(doing: KonamiDoing): string {
  switch (doing.kind) {
    case 'train':
      return doing.training
        ? t('cards.konami.doing.training', { trainer: doing.trainer, room: doing.room })
        : doing.copper === 0
          ? t('cards.konami.doing.toTrainerFree', { trainer: doing.trainer, room: doing.room })
          : t('cards.konami.doing.toTrainer', {
              trainer: doing.trainer,
              room: doing.room,
              copper: doing.copper.toLocaleString()
            });
    case 'buy':
      switch (doing.stage) {
        case 'walking':
          return t('cards.konami.doing.toShop', { item: doing.item, shop: doing.shop });
        case 'bank':
          return t('cards.konami.doing.toBank', { item: doing.item });
        case 'shop':
          return t('cards.konami.doing.buying', { item: doing.item, shop: doing.shop });
        default: {
          const never: never = doing.stage;
          return never;
        }
      }
    case 'hunt':
      return doing.walking
        ? t('cards.konami.doing.toSpot', { place: doing.place })
        : t('cards.konami.doing.hunting', { place: doing.place });
    case 'waiting':
      switch (doing.on) {
        case 'fight':
          return t('cards.konami.doing.waitFight');
        case 'walking':
          return t('cards.konami.doing.waitWalking');
        case 'busy':
          return t('cards.konami.doing.waitBusy');
        case 'hurt':
          return t('cards.konami.doing.waitHurt');
        case 'lap':
          return t('cards.konami.doing.waitLap');
        default: {
          const never: never = doing.on;
          return never;
        }
      }
    default: {
      const never: never = doing;
      return never;
    }
  }
}

/**
 * The options worth drawing (todo 67): every one the reply gave at least a
 * whole percent, and the one chosen whatever it was given. The rest are
 * counted, so the card can still show them on request.
 */
export function oddsShown<T extends { p: number; chosen: boolean }>(
  options: readonly T[]
): { shown: T[]; hidden: number } {
  const shown = options.filter((option) => option.chosen || percent(option.p) > 0);
  return { shown, hidden: options.length - shown.length };
}

/** A share as a whole percentage, as the Combat card prints one. */
export function shareText(share: number): string {
  return t('cards.stats.percent', { value: percent(share) });
}

/** A stretch of time in minutes, as a decision's row says how long it ran. */
export function tookText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? t('cards.konami.tookUnder') : t('cards.konami.took', { minutes });
}

/** A lesson's ending as the Lessons face words it, a death with where and to what. */
export function lessonDetail(lesson: KonamiLesson): string {
  switch (lesson.outcome) {
    case 'died': {
      const how =
        lesson.atTheSpot === true
          ? t('cards.konami.lesson.diedThere')
          : lesson.atTheSpot === false
            ? t('cards.konami.lesson.diedOnTheWay')
            : t('cards.konami.lesson.died');
      return [
        how,
        lesson.killers.length === 0
          ? null
          : t('cards.konami.lesson.to', { killers: lesson.killers.join(', ') }),
        lesson.room === null ? null : t('cards.konami.lesson.in', { room: lesson.room })
      ]
        .filter((part) => part !== null)
        .join(' ');
    }
    case 'refused':
      return t('cards.konami.lesson.refused', {
        why: lesson.why ?? t('cards.konami.lesson.noReason')
      });
    case 'vetoed':
      return t('cards.konami.lesson.vetoed');
    case 'done':
    case 'replaced':
      return [
        t('cards.konami.lesson.ran', { minutes: lesson.minutes }),
        lesson.expGained === null
          ? null
          : t('cards.konami.lesson.exp', { exp: compact(lesson.expGained) })
      ]
        .filter((part) => part !== null)
        .join(' · ');
    default: {
      const never: never = lesson.outcome;
      return never;
    }
  }
}

/** The plan's settings, one pair each, in the order the questions are asked. */
export function layerRows(layer: KonamiLayer): Array<[string, string]> {
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
    rows.push([t('cards.konami.layer.restBelow'), shareText(layer.restBelow)]);
  }
  if (layer.trainFirst !== undefined) {
    rows.push([t('cards.konami.layer.trainFirst'), layer.trainFirst]);
  }
  if (layer.coins !== undefined) {
    rows.push([
      t('cards.konami.layer.coinsPicked'),
      layer.coins.pick.join(', ') || t('cards.konami.layer.none')
    ]);
    if (layer.coins.shed.length > 0) {
      rows.push([t('cards.konami.layer.coinsDropped'), layer.coins.shed.join(', ')]);
    }
  }
  if (layer.cashPerHour !== undefined) {
    rows.push([
      t('cards.konami.layer.cashPerHour'),
      layer.cashPerHour > 0 ? layer.cashPerHour.toLocaleString() : t('cards.konami.layer.none')
    ]);
  }
  return rows;
}

/** A trained stat's name, as the Self card labels it. */
function statLabel(stat: TrainedAttribute): string {
  switch (stat) {
    case 'strength':
      return t('cards.self.labels.strength');
    case 'intellect':
      return t('cards.self.labels.intellect');
    case 'willpower':
      return t('cards.self.labels.willpower');
    case 'agility':
      return t('cards.self.labels.agility');
    case 'health':
      return t('cards.self.labels.health');
    case 'charm':
      return t('cards.self.labels.charm');
    default: {
      const never: never = stat;
      return never;
    }
  }
}

/** One thing the character did, as the History face says it. */
export function historyText(event: HistoryEvent): string {
  switch (event.kind) {
    case 'huntStarted':
      return t('cards.konami.history.huntStarted', { place: event.place });
    case 'hunted':
      return event.exp === null
        ? t('cards.konami.history.hunted', { place: event.place, minutes: event.minutes })
        : t('cards.konami.history.huntedExp', {
            place: event.place,
            minutes: event.minutes,
            exp: compact(event.exp)
          });
    case 'levelled':
      return t('cards.konami.history.levelled', { from: event.from, to: event.to });
    case 'stats':
      return t('cards.konami.history.stats', {
        changes: event.changes
          .map((each) =>
            t('cards.konami.history.statChange', {
              stat: statLabel(each.stat),
              from: each.from,
              to: each.to
            })
          )
          .join(t('cards.konami.history.joiner'))
      });
    case 'bought':
      return event.copper === 0
        ? t('cards.konami.history.boughtFree', { item: event.item, shop: event.shop })
        : t('cards.konami.history.bought', {
            item: event.item,
            shop: event.shop,
            copper: event.copper.toLocaleString()
          });
    case 'wore':
      return t('cards.konami.history.wore', { item: event.item });
    case 'removed':
      return t('cards.konami.history.removed', { item: event.item });
    case 'died':
      if (event.room === null) return t('cards.konami.history.diedSomewhere');
      return event.killers.length === 0
        ? t('cards.konami.history.died', { room: event.room })
        : t('cards.konami.history.diedTo', {
            room: event.room,
            killers: event.killers.join(t('cards.konami.history.joiner'))
          });
    default: {
      const never: never = event;
      return never;
    }
  }
}

/** The glyph and tone a history entry wears. */
export function historyLook(event: HistoryEvent): { icon: IconName; tone: OutcomeTone } {
  switch (event.kind) {
    case 'huntStarted':
      return { icon: 'crosshair', tone: 'on' };
    case 'hunted':
      return { icon: 'crosshair', tone: 'quiet' };
    case 'levelled':
      return { icon: 'sparkle', tone: 'ok' };
    case 'stats':
      return { icon: 'plus', tone: 'ok' };
    case 'bought':
      return { icon: 'coins', tone: 'on' };
    case 'wore':
      return { icon: 'shirtWorn', tone: 'on' };
    case 'removed':
      return { icon: 'shirtOff', tone: 'quiet' };
    case 'died':
      return { icon: 'flame', tone: 'bad' };
    default: {
      const never: never = event;
      return never;
    }
  }
}
