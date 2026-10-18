/**
 * What saying a monster's word leads to, as the Reference popover says it
 * (todo 01): the quest step it moves, then what its script gives, takes,
 * teaches and charges. Empty where the realm data says it only talks.
 */
import { t } from './i18n';
import { copperWords } from './gearPicks';
import type { MobAsk } from '@shared/world';

export function askLead(ask: MobAsk): string {
  const parts: string[] = [];
  if (ask.quest !== undefined) {
    parts.push(
      ask.quest.to === undefined
        ? t('cards.reference.mob.ask.quest', { quest: ask.quest.name })
        : t('cards.reference.mob.ask.questRank', { quest: ask.quest.name, rank: ask.quest.to })
    );
  }
  if (ask.gives !== undefined)
    parts.push(t('cards.reference.mob.ask.gives', { items: ask.gives.join(', ') }));
  if (ask.takes !== undefined)
    parts.push(t('cards.reference.mob.ask.takes', { items: ask.takes.join(', ') }));
  if (ask.teaches !== undefined) {
    parts.push(t('cards.reference.mob.ask.teaches', { spells: ask.teaches.join(', ') }));
  }
  if (ask.copper !== undefined)
    parts.push(t('cards.reference.mob.ask.costs', { copper: copperWords(ask.copper) }));
  return parts.join('; ');
}
