/**
 * Where the purse's worth sits, coin by coin: one bar cut by each
 * denomination's value at the realm's measured rungs (`COPPER_PER`), with the
 * share of each in the key. A drawing of the counts the purse row states; the
 * total stays the server's `Wealth:`, never this sum.
 */
import { memo, useMemo } from 'react';

import { DENOMINATIONS, type Coins, type Denomination } from '@shared/character';
import { COPPER_PER } from '@shared/coins';
import { COIN_NAME } from '../lib/coins';
import { t } from '../lib/i18n';
import { percent } from '../lib/outlook';
import SplitBar, { type SplitPart } from './viz/SplitBar';
import type { VizTone } from './viz/tones';

/** Each coin in the hue nearest its metal, from the shared tones. */
const COIN_TONE: Readonly<Record<Denomination, VizTone>> = {
  runic: 'd',
  platinum: 'a',
  gold: 'c',
  silver: 'quiet',
  copper: 'b'
};

const share = (_value: number, part: number): string => `${percent(part)}%`;

function PurseMix({ coins, legend }: { coins: Coins; legend: boolean }) {
  const parts = useMemo<SplitPart[]>(
    () =>
      DENOMINATIONS.filter((coin) => (coins[coin] ?? 0) > 0).map((coin) => ({
        key: coin,
        label: COIN_NAME[coin][0],
        value: (coins[coin] ?? 0) * COPPER_PER[coin],
        tone: COIN_TONE[coin]
      })),
    [coins]
  );
  if (parts.length === 0) return null;
  return (
    <SplitBar format={share} label={t('cards.inventory.purseMix')} legend={legend} parts={parts} />
  );
}

export default memo(PurseMix);
