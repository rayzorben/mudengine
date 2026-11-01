/**
 * A thing's picture in a small square beside its name on a card: the art
 * run's cutout where one was drawn for it, else the glyph for its kind, so a
 * row never shows a broken image. Decorative: the name beside it says what it
 * is. `mudengine-ui` › parts/viz.md.
 */
import { memo } from 'react';

import type { RealmFamily } from '@shared/character';
import type { ItemKind } from '@shared/items';
import { useFirstPicture } from '../hooks/useFirstPicture';
import { pictureOf, type ItemArtIndex } from '../lib/itemArt';
import Icon, { type IconName } from './Icon';

/** Every kind has a glyph, so a new kind fails to compile until it is drawn. */
const KIND_GLYPH: Readonly<Record<ItemKind, IconName>> = {
  weapon: 'sword',
  armour: 'shield',
  food: 'heart',
  drink: 'heart',
  scroll: 'fileText',
  light: 'flame',
  trap: 'bolt',
  key: 'key',
  container: 'bag',
  sign: 'flag',
  misc: 'bag'
};

function ItemThumb({
  art,
  realm,
  thing,
  className
}: {
  art: ItemArtIndex | null;
  realm: RealmFamily | null;
  thing: { name: string; id?: number; kind?: ItemKind };
  className?: string;
}) {
  const { src, failed } = useFirstPicture([art === null ? null : pictureOf(art, realm, thing)]);
  return (
    <span aria-hidden="true" className={`item-thumb${className ? ` ${className}` : ''}`}>
      {/* A thing the realm cannot place gets an empty square: a glyph would be a guess. */}
      {src === null ? (
        thing.kind !== undefined && <Icon name={KIND_GLYPH[thing.kind]} />
      ) : (
        <img alt="" decoding="async" draggable={false} loading="lazy" onError={failed} src={src} />
      )}
    </span>
  );
}

export default memo(ItemThumb);
