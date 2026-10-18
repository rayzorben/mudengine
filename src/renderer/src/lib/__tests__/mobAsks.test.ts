import { describe, expect, it } from 'vitest';

import { copperWords } from '../gearPicks';
import { t } from '../i18n';
import { askLead } from '../mobAsks';

describe('what a word asked of a monster leads to', () => {
  it('says the quest step first, then what the script hands over', () => {
    expect(
      askLead({
        word: 'learn 3',
        quest: { name: 'GoodQuest', to: 1 },
        gives: ['gold ring'],
        takes: ['letter'],
        teaches: ['flame enchantment'],
        copper: 360000
      })
    ).toBe(
      [
        t('cards.reference.mob.ask.questRank', { quest: 'GoodQuest', rank: 1 }),
        t('cards.reference.mob.ask.gives', { items: 'gold ring' }),
        t('cards.reference.mob.ask.takes', { items: 'letter' }),
        t('cards.reference.mob.ask.teaches', { spells: 'flame enchantment' }),
        t('cards.reference.mob.ask.costs', { copper: copperWords(360000) })
      ].join('; ')
    );
  });

  it('is empty for a word the realm data says only talks', () => {
    expect(askLead({ word: 'monastery' })).toBe('');
  });
});
