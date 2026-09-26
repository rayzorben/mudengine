/**
 * What a realm calls each coin it renamed (todo 830): one field per coin,
 * blank for the stock name, which is shown as the placeholder. The words come
 * from the player; nothing here guesses them.
 */
import { TextField } from './FormField';
import { t } from '../lib/i18n';
import { DENOMINATIONS, type Denomination } from '@shared/character';
import { STOCK_COIN, type CoinNames } from '@shared/coins';

export interface CoinNameFieldsProps {
  coins: CoinNames;
  onChange(coins: CoinNames): void;
}

/** Each field's label; exhaustive, so a sixth coin is a compile error until it has one. */
function labelOf(coin: Denomination): string {
  switch (coin) {
    case 'runic':
      return t('settings.coins.runic');
    case 'platinum':
      return t('settings.coins.platinum');
    case 'gold':
      return t('settings.coins.gold');
    case 'silver':
      return t('settings.coins.silver');
    case 'copper':
      return t('settings.coins.copper');
    default: {
      const unreachable: never = coin;
      return unreachable;
    }
  }
}

export default function CoinNameFields({
  coins,
  onChange
}: CoinNameFieldsProps): React.JSX.Element {
  const set = (coin: Denomination, value: string): void => {
    const rest: CoinNames = { ...coins };
    delete rest[coin];
    onChange(value.trim().length > 0 ? { ...rest, [coin]: value } : rest);
  };
  return (
    <div className="settings-inline">
      {DENOMINATIONS.map((coin) => (
        <TextField
          key={coin}
          hint={t('settings.coins.hint')}
          label={labelOf(coin)}
          name={`realm-coin-${coin}`}
          onChange={(value) => set(coin, value)}
          placeholder={STOCK_COIN[coin]}
          spellCheck={false}
          value={coins[coin] ?? ''}
        />
      ))}
    </div>
  );
}
