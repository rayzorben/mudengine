/**
 * Every worn slot as a square, grouped down the body as the game view's
 * paper doll groups them (`DOLL_SLOTS`, `DOLL_REGIONS`): the item's picture
 * where something is worn there, the slot's word where nothing is, and what
 * is worn under a word no slot has after them. A filled square opens the item.
 * Until the inventory has been listed it says so instead: every square would
 * be unknown, not empty (`wornSlotsOf`).
 */
import { memo, useMemo } from 'react';

import type { CarriedItem, Inventory, RealmFamily } from '@shared/character';
import { useItemArt } from '../hooks/useItemArt';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { DOLL_REGIONS, DOLL_SLOTS } from '../lib/paperDoll';
import { wornSlotsOf } from '../lib/wornSlots';
import ItemThumb from './ItemThumb';

/** The squares in body order: head first, the feet last. */
const ORDERED = DOLL_REGIONS.flatMap((region) => DOLL_SLOTS.filter((s) => s.region === region));

function WornGrid({
  inventory,
  realm,
  inspect
}: {
  inventory: Inventory;
  realm: RealmFamily | null;
  inspect?(name: string, anchor: HTMLElement): void;
}) {
  const art = useItemArt();
  const worn = useMemo(() => wornSlotsOf(inventory), [inventory]);
  if (worn === null) return <p className="aside">{t('cards.inventory.emptyUnseen')}</p>;
  const square = (key: string, word: string, region: string | null, item: CarriedItem | null) =>
    item === null ? (
      <span className="worn-slot" data-region={region ?? undefined} key={key} title={word}>
        <span className="worn-word">{word}</span>
      </span>
    ) : (
      <button
        className="worn-slot"
        data-filled="true"
        data-region={region ?? undefined}
        key={key}
        onClick={inspect ? (event) => inspect(item.name, event.currentTarget) : undefined}
        onMouseDown={keepFocus}
        title={t('cards.self.wornTooltip', { item: item.name, slot: word })}
        type="button"
      >
        <ItemThumb art={art} realm={realm} thing={item} />
      </button>
    );
  return (
    <div aria-label={t('cards.self.groups.worn')} className="worn-grid" role="group">
      {ORDERED.map((slot) => {
        return square(slot.id, slot.word, slot.region, worn.bySlot.get(slot.id) ?? null);
      })}
      {worn.elsewhere.map((item, at) =>
        square(`elsewhere-${at}`, item.slot ?? t('cards.inventory.inUseStatus'), null, item)
      )}
    </div>
  );
}

export default memo(WornGrid);
