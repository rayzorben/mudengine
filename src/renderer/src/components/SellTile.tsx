import { memo } from 'react';

import Icon from './Icon';
import ItemThumb from './ItemThumb';
import { keepFocus } from '../lib/focus';
import { copperWords } from '../lib/gearPicks';
import { t } from '../lib/i18n';
import type { ItemArtIndex } from '../lib/itemArt';
import { compact } from '../lib/rates';
import { keptWords, sells, type SellRow } from '../lib/sellWords';
import type { RealmFamily } from '@shared/character';
import { countedLabel } from '@shared/items';

/**
 * One thing on the Sell face. The tile is its own control, as the Gear card's
 * suggestion is: plain until picked, green once it is, with the mark in a
 * disc. A pile picked carries a stepper for how many of it go. A thing that
 * cannot be sold is drawn dim with the reason where the shop would be, and
 * has no control.
 */
export interface SellTileProps {
  row: SellRow;
  /** How many of the row are picked; none is not picked. */
  picked: number;
  onPick(row: SellRow, count: number): void;
  art: ItemArtIndex | null;
  realm: RealmFamily | null;
}

function SellTile({ row, picked, onPick, art, realm }: SellTileProps) {
  const pile = { name: row.thing.name, count: row.count };
  const what = (
    <span className="gear-item-name sell-what" title={row.thing.name}>
      {countedLabel(pile)}
    </span>
  );
  // Under the name, ahead of the shop: only a search shows this one.
  const hidden = row.hidden ? (
    <span className="chip quiet sell-hidden">{t('cards.sell.hiddenChip')}</span>
  ) : null;
  if (!sells(row)) {
    return (
      <li className="sell-tile" data-state="kept">
        <div className="sell-pick">
          <ItemThumb art={art} realm={realm} thing={row.thing} />
          <span className="gear-toggle-body">
            {what}
            <span className="gear-meta">
              {hidden}
              {row.choice === null || row.choice.kept === null
                ? t('cards.sell.asking')
                : keptWords(row.choice.kept, row.choice.quest)}
            </span>
          </span>
        </div>
      </li>
    );
  }
  const { choice } = row;
  const each = choice.copper ?? 0;
  const on = picked > 0;
  return (
    <li className="sell-tile" data-state={on ? 'picked' : 'open'}>
      <button
        aria-pressed={on}
        className="sell-pick"
        data-action="sell-pick"
        onClick={() => onPick(row, on ? 0 : row.count)}
        onMouseDown={keepFocus}
        title={t('cards.sell.pickTitle', { item: row.thing.name })}
        type="button"
      >
        <ItemThumb art={art} realm={realm} thing={row.thing} />
        <span className="gear-toggle-body">
          {what}
          <span className="gear-meta">
            {hidden}
            {choice.shop === null
              ? null
              : choice.moves === null
                ? t('cards.sell.shopOnly', { shop: choice.shop })
                : t('cards.sell.shopAway', { shop: choice.shop, moves: choice.moves })}
          </span>
        </span>
        <span className="sell-pays" title={copperWords(each * row.count)}>
          {compact(each * (on ? picked : row.count))}
        </span>
        <span aria-hidden="true" className="gear-toggle-mark">
          <Icon name={on ? 'check' : 'plus'} />
        </span>
      </button>
      {on && row.count > 1 ? (
        <span className="sell-count">
          <button
            aria-label={t('cards.sell.fewer')}
            disabled={picked <= 1}
            onClick={() => onPick(row, picked - 1)}
            onMouseDown={keepFocus}
            type="button"
          >
            <Icon name="minus" />
          </button>
          <span>{t('cards.sell.countOf', { picked, count: row.count })}</span>
          <button
            aria-label={t('cards.sell.more')}
            disabled={picked >= row.count}
            onClick={() => onPick(row, picked + 1)}
            onMouseDown={keepFocus}
            type="button"
          >
            <Icon name="plus" />
          </button>
        </span>
      ) : null}
    </li>
  );
}

export default memo(SellTile);
