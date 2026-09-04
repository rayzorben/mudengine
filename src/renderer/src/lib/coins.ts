/**
 * The realm's coins, written out for a reader.
 *
 * Lived inside `InventoryCard` until the Room card needed the same words for
 * the coins lying on a floor. Two copies of a vocabulary is how one card comes
 * to say `plat` and another `pl`, which is the failure the tiers were written
 * as one table to prevent — so the table and the sentence are here, and the
 * *measuring* stays in the card, because only the purse row has a width to
 * measure against.
 */
import { t } from './i18n';
import { DENOMINATIONS, type Coins, type Denomination } from '@shared/character';

/**
 * Three tiers per denomination, longest first.
 *
 * Gold has no middle form on purpose: `gold` is already short and `gol` is not
 * a word anybody reads as one, so it drops straight to `g`.
 */
export const COIN_NAME: Record<Denomination, readonly [string, string, string]> = {
  runic: [
    t('cards.inventory.coin.runic.long'),
    t('cards.inventory.coin.runic.mid'),
    t('cards.inventory.coin.runic.short')
  ],
  platinum: [
    t('cards.inventory.coin.platinum.long'),
    t('cards.inventory.coin.platinum.mid'),
    t('cards.inventory.coin.platinum.short')
  ],
  gold: [
    t('cards.inventory.coin.gold.mid'),
    t('cards.inventory.coin.gold.mid'),
    t('cards.inventory.coin.gold.short')
  ],
  silver: [
    t('cards.inventory.coin.silver.long'),
    t('cards.inventory.coin.silver.mid'),
    t('cards.inventory.coin.silver.short')
  ],
  copper: [
    t('cards.inventory.coin.copper.long'),
    t('cards.inventory.coin.copper.mid'),
    t('cards.inventory.coin.copper.short')
  ]
};

/**
 * The coins, at one tier for the whole row.
 *
 * One tier, not one per denomination: `48 plat, 18 g` reads as two
 * vocabularies, and the row is one sentence.
 *
 * Zero is never drawn. A listing enumerates, so a denomination it did not name
 * is none — and `0 runic` is a row of noise on a card that is already narrow.
 * A null pile is nothing at all, which is what an unsearched floor is.
 */
export function coinText(coins: Coins | null, tier = 0): string {
  if (coins === null) return '';
  return DENOMINATIONS.filter((name) => (coins[name] ?? 0) > 0)
    .map((name) => `${coins[name]} ${COIN_NAME[name][tier] ?? COIN_NAME[name][0]}`)
    .join(', ');
}
