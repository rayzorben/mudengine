import type { ItemRarity } from '@shared/rarity';
import { t } from './i18n';
import { clockText } from './clockText';

/** Hours to one copy: the lair clock's letters, and days past two of them. */
export function rarityClock(hours: number): string {
  return hours < 48 ? clockText(hours * 3600) : `${Number((hours / 24).toFixed(1))}d`;
}

/** The rarity band in words, as the item card and the Finds tab both say it. */
export function bandWord({ rarity }: Pick<ItemRarity, 'rarity'>): string {
  switch (rarity) {
    case 'common':
      return t('cards.reference.item.rarity.band.common');
    case 'uncommon':
      return t('cards.reference.item.rarity.band.uncommon');
    case 'rare':
      return t('cards.reference.item.rarity.band.rare');
    case 'veryRare':
      return t('cards.reference.item.rarity.band.veryRare');
    case 'extremelyRare':
      return t('cards.reference.item.rarity.band.extremelyRare');
    case 'unknown':
      return t('cards.reference.item.rarity.band.unknown');
    default: {
      const never: never = rarity;
      return never;
    }
  }
}
