/**
 * The columns every listing of the pack shares: the thing with its picture,
 * the realm's row number and the weight. The Inventory card's pack and its
 * Sell face draw the same three, so they are built once; each face adds its
 * own (worn where, or what it pays).
 */
import type { Column } from './CardTable';
import EntityName, { type Inspect } from './EntityName';
import EntityNumber, { entityNumberText } from './EntityNumber';
import ItemThumb from './ItemThumb';
import type { ItemArtIndex } from '../lib/itemArt';
import { t } from '../lib/i18n';
import type { RealmFamily } from '@shared/character';
import { entityNumber, type ItemEntity } from '@shared/entities';
import { countedLabel } from '@shared/items';

/** What the item column draws with: the pictures, the realm they are of, and the lookup a name opens. */
export interface PackDraw {
  art: ItemArtIndex | null;
  realm: RealmFamily | null;
  inspect: Inspect | undefined;
}

/** The thing itself, a pile counted as the server lists it. Large, each row carries its picture. */
export function itemColumn<Row>(of: (row: Row) => ItemEntity, draw: PackDraw): Column<Row> {
  return {
    id: 'item',
    label: t('cards.room.shop.columnItem'),
    wide: true,
    value: (row) => of(row).name,
    cell: (row) => {
      const item = of(row);
      return (
        <>
          <ItemThumb art={draw.art} className="from-large" realm={draw.realm} thing={item} />
          <EntityName className="what" inspect={draw.inspect} name={item.name}>
            {countedLabel(item)}
          </EntityName>
        </>
      );
    }
  };
}

/**
 * The realm's own `Items` row, the number MegaMUD printed. A column, so it is
 * findable (typing `1234` narrows a pack to the thing) and sorts as a
 * magnitude. `value` is the plain text and `cell` the drawn figure, which
 * puts the *rows* answer (`iron key` is three) into the find text too.
 */
export function numberColumn<Row>(of: (row: Row) => ItemEntity): Column<Row> {
  return {
    id: 'number',
    label: t('entity.numberColumn'),
    // Small, the pack is the weight bar and what is in it (`lib/cardSize.ts`).
    from: 'medium',
    name: t('entity.numberColumnLabel'),
    numeric: true,
    value: (row) => entityNumber(of(row)) ?? entityNumberText(of(row)),
    cell: (row) => <EntityNumber of={of(row)} />
  };
}

/** What one weighs: absent, never zero, for a name the realm cannot place. */
export function weightColumn<Row>(of: (row: Row) => ItemEntity): Column<Row> {
  return {
    id: 'weight',
    label: t('cards.inventory.columns.weight'),
    from: 'medium',
    numeric: true,
    value: (row) => of(row).encumbrance ?? null,
    cell: (row) => of(row).encumbrance ?? null
  };
}
