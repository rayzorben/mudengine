/**
 * The pack panel's bottom row (todo 20261018-2032-01): cash, keys and tokens,
 * each a card of its own, apart from the items as the server lists them.
 */
import { memo } from 'react';

import {
  DENOMINATIONS,
  type CarriedItem,
  type Inventory,
  type RealmFamily
} from '@shared/character';
import { COIN_NAME } from '../../lib/coins';
import { t } from '../../lib/i18n';
import { figure } from '../../lib/stats';
import { coinPicture, pictureOf, type ItemArtIndex } from '../../lib/itemArt';
import ItemPicture from './ItemPicture';

function PackTray({
  inventory,
  tokens,
  art,
  realm
}: {
  inventory: Inventory;
  tokens: readonly CarriedItem[];
  art: ItemArtIndex | null;
  realm: RealmFamily | null;
}) {
  return (
    <div className="gv-pack-tray">
      <section className="gv-tray-card">
        <header>
          <b>{t('game.pack.cash')}</b>
          <span>{t('game.pack.wealth', { copper: figure(inventory.wealth) })}</span>
        </header>
        <div className="gv-coins">
          {DENOMINATIONS.map((coin) => (
            <div
              className="gv-coin"
              data-zero={inventory.coins[coin] === 0 ? 'true' : undefined}
              key={coin}
            >
              <ItemPicture
                name={COIN_NAME[coin][0]}
                src={art === null ? null : coinPicture(art, coin)}
              />
              <b>{figure(inventory.coins[coin])}</b>
              <span>{COIN_NAME[coin][0]}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="gv-tray-card">
        <header>
          <b>{t('game.pack.keys')}</b>
          <span>{inventory.keys.length}</span>
        </header>
        <div className="gv-chips-row">
          {inventory.keys.map((name, i) => (
            <span className="gv-thing" key={`${name}/${i}`}>
              <ItemPicture
                name={name}
                src={art === null ? null : pictureOf(art, realm, { name })}
              />
              {name}
            </span>
          ))}
        </div>
      </section>
      <section className="gv-tray-card">
        <header>
          <b>{t('game.pack.tokens')}</b>
          <span>{tokens.length}</span>
        </header>
        <div className="gv-chips-row">
          {tokens.map((item, i) => (
            <span className="gv-thing" key={`${item.name}/${i}`}>
              <ItemPicture
                name={item.name}
                src={art === null ? null : pictureOf(art, realm, item)}
              />
              {item.name}
              {(item.count ?? 1) > 1 && <b>×{item.count}</b>}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}

export default memo(PackTray);
