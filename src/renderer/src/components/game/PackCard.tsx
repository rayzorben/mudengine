/**
 * One section of the pack (todo 20261018-2032-01): its colour, count and
 * weight, then a row per item with its picture, a count and its weight.
 */
import { memo } from 'react';

import type { CarriedItem, RealmFamily } from '@shared/character';
import { t } from '../../lib/i18n';
import { figure } from '../../lib/stats';
import { pictureOf, type ItemArtIndex } from '../../lib/itemArt';
import { weightOf, type PackGroup, type Weight } from '../../lib/packGroups';
import ItemPicture from './ItemPicture';

/** A lower bound reads as one: `365+` while a row cannot be weighed. */
const weightText = ({ known, unknown }: Weight): string =>
  unknown === 0 ? known.toLocaleString() : `${known.toLocaleString()}+`;

function PackCard({
  group,
  label,
  items,
  art,
  realm
}: {
  group: PackGroup;
  label: string;
  items: readonly CarriedItem[];
  art: ItemArtIndex | null;
  realm: RealmFamily | null;
}) {
  return (
    <section className="gv-pack-card" data-group={group}>
      <header>
        <i />
        <b>{label}</b>
        <span>
          {t('game.pack.groupMeta', {
            count: items.length,
            weight: weightText(weightOf(items))
          })}
        </span>
      </header>
      <div className="gv-pack-rows">
        {items.map((item, i) => (
          <div className="gv-pack-row" key={`${item.name}/${i}`} title={item.name}>
            <span className="gv-pack-tile">
              <ItemPicture
                name={item.name}
                src={art === null ? null : pictureOf(art, realm, item)}
              />
            </span>
            <span className="gv-pack-name">{item.name}</span>
            {(item.count ?? 1) > 1 ? (
              <span className="gv-pack-count">×{item.count}</span>
            ) : (
              <span />
            )}
            <span className="gv-pack-weight">{figure(item.encumbrance ?? null)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export default memo(PackCard);
