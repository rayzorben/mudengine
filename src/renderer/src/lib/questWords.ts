/**
 * The quest book's words: a bar, a reward, the act a step is reached by, and
 * where a progress figure comes from. Read by the card, its tiles and the copy
 * text, so the three say one thing (`mudengine-ui` › `parts/quests.md`).
 */
import type { QuestBar, QuestReward, QuestSide, QuestStep } from '@shared/quests';
import { t } from './i18n';

/**
 * The experience column's rendering. Built once — a formatter is not cheap.
 *
 * The locale is the browser's, like every other figure in the chrome; nothing
 * here picks one, because the client does not choose the player's.
 */
export const COMPACT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
  notation: 'compact'
});

/**
 * One thing that shuts this character out, in the realm's own gate words.
 *
 * The same register `gateWords` writes — a lower-case fragment, the realm's
 * own names — because that is what these *are*: the gates of the routes the
 * character cannot take, read from the other side. A class or a race is
 * *never*, a level is *not yet*, and the two are worded apart.
 */
export function barWords(bar: QuestBar): string {
  switch (bar.kind) {
    case 'class':
      return t('cards.quests.bar.klass', { names: bar.names.join(', ') });
    case 'race':
      return t('cards.quests.bar.race', { names: bar.names.join(', ') });
    case 'counter':
      return t('cards.quests.bar.counter', { names: bar.names.join(', ') });
    case 'level':
      return t('cards.quests.bar.level', { level: bar.level });
  }
}

/**
 * Why a quest is drawn sunk and quiet, as the row's own hover text.
 *
 * Two sentences, because *not yet* and *not ever* are different statements
 * about a character and one word for both would be wrong half the time: a
 * level is a rung they climb, and a class, a race or a counter already spent
 * is not. Two literal `t()` calls, as a plural pair is.
 */
export function barsTitle(bars: readonly QuestBar[]): string | undefined {
  if (bars.length === 0) return undefined;
  const reasons = bars.map(barWords).join(' · ');
  return bars.every((bar) => bar.kind === 'level')
    ? t('cards.quests.bar.titleYet', { reasons })
    : t('cards.quests.bar.title', { reasons });
}

/** One reward, in words. */
export function rewardWords(reward: QuestReward): string {
  switch (reward.kind) {
    case 'exp':
      return t('cards.quests.reward.exp', { amount: reward.amount.toLocaleString() });
    case 'item':
      return reward.name ?? `#${reward.id}`;
    case 'coins':
      return t('cards.quests.reward.coins', {
        amount: reward.amount.toLocaleString(),
        coin: reward.coin
      });
    case 'ability':
      /*
       * `giveability` **sets** a rank and `addability` **adds** to what is
       * there, and the difference is the whole meaning of the number. Every
       * reward read `{name} to rank {value}`, so `addability 2 1` — *+1 AC* —
       * printed **AC to rank 1**, which is a worse suit of armour than the one
       * the realm hands over. 367 of the shipped realm's 618 ability rewards
       * are adds; `mode` had been carried by the parser and read by nothing.
       */
      if (reward.mode === 'add') {
        return t('cards.quests.reward.abilityAdd', {
          name: reward.name ?? String(reward.id),
          // The sign is part of the figure: `addability` may take one away.
          amount: reward.value >= 0 ? `+${reward.value}` : String(reward.value)
        });
      }
      return t('cards.quests.reward.ability', {
        name: reward.name ?? String(reward.id),
        rank: reward.value
      });
    case 'spell':
      return t('cards.quests.reward.spell', { name: reward.name ?? `#${reward.id}` });
    case 'lives':
      return reward.amount === 1
        ? t('cards.quests.reward.lives.one', { count: reward.amount })
        : t('cards.quests.reward.lives.many', { count: reward.amount });
    case 'alignment':
      return t('cards.quests.reward.alignment', { amount: reward.amount });
  }
}

/** The command a step is reached by, or null where the realm traced nobody. */
export function askWords(step: QuestStep): string | null {
  /*
   * A step whose block a monster's **death** runs is not reached by a command
   * at all: it is reached by killing the thing. First, because such a step has
   * no `say` and would otherwise fall out of the bottom as *nothing to do*,
   * which is what the book said about the Phoenix chain's two boss steps.
   */
  if (step.kill !== undefined) return t('cards.quests.step.kill', { who: step.kill });
  if (step.say.length === 0) return null;
  /*
   * A room's own script has no asker — the altar answers `touch gem` to
   * whoever is standing on it — and the phrase is typed *there* rather than at
   * somebody (todo 12). Two sentences for two different acts, and the place
   * beside it is the row's own `where` control.
   */
  if (step.who === undefined || step.who.trim().length === 0) {
    return step.room === undefined
      ? null
      : t('cards.quests.step.doHere', { word: step.say[0] ?? '' });
  }
  return t('cards.quests.step.ask', { who: step.who, word: step.say[0] ?? '' });
}

/** Which of the three readings a progress figure is: the realm, watching, or the player. */
export function progressTitle(progress: { observed: boolean; watched: boolean }): string {
  if (progress.observed) return t('cards.quests.progress.fromRealm');
  return progress.watched
    ? t('cards.quests.progress.fromWatching')
    : t('cards.quests.progress.fromYou');
}

/** The side a quest is for, as the book's chips and tiles name it. */
export function sideWords(side: QuestSide): string {
  switch (side) {
    case 'good':
      return t('cards.quests.side.good');
    case 'neutral':
      return t('cards.quests.side.neutral');
    case 'evil':
      return t('cards.quests.side.evil');
    case 'any':
      return t('cards.quests.side.any');
  }
}
