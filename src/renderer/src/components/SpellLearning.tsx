/**
 * Where a spell is learned (todo 71): each scroll that teaches it, with its
 * base value and the shops that sell it, and each trainer or room whose
 * script teaches it. Rows of the spell's `dl`; nothing is drawn where the
 * realm names neither, which is most of its spell table.
 */
import { Fragment } from 'react';
import { t } from '../lib/i18n';
import type { ShopPlace, WorldSpell } from '@shared/world';
import { GivenBy, SoldBy } from './ReferenceSources';

export default function SpellLearning({
  spell,
  shopPlaces,
  onRoom,
  onName
}: {
  spell: Pick<WorldSpell, 'scrolls' | 'from'>;
  shopPlaces: Record<string, ShopPlace>;
  onRoom: ((map: number, room: number) => void) | null;
  onName: ((name: string, anchor: HTMLElement) => void) | null;
}) {
  return (
    <>
      {(spell.scrolls ?? []).map((scroll) => (
        <Fragment key={scroll.id}>
          <dt>{t('cards.reference.spell.scrollLabel')}</dt>
          <dd>
            {onName === null ? (
              scroll.name
            ) : (
              <button
                className="lookup"
                onClick={(event) => onName(scroll.name, event.currentTarget)}
                type="button"
              >
                {scroll.name}
              </button>
            )}
            {scroll.price !== undefined && (
              <span className="quiet">
                {' '}
                {t('cards.reference.item.priceNote', { price: scroll.price })}
              </span>
            )}
          </dd>
          {scroll.shops !== undefined && scroll.shops.length > 0 && (
            <>
              <dt>{t('cards.reference.item.soldByLabel')}</dt>
              <SoldBy onRoom={onRoom} places={shopPlaces} shops={scroll.shops} />
            </>
          )}
        </Fragment>
      ))}
      {spell.from !== undefined && spell.from.length > 0 && (
        <>
          <dt>{t('cards.reference.spell.taughtByLabel')}</dt>
          <GivenBy from={spell.from} onName={onName} onRoom={onRoom} />
        </>
      )}
    </>
  );
}
