/**
 * One item's picture, or its name where the art run drew none or the file is
 * not there: a square never shows a broken image (todo 20261018-2032-01).
 */
import { memo } from 'react';

import { useFirstPicture } from '../../hooks/useFirstPicture';

function ItemPicture({ src: picture, name }: { src: string | null; name: string }) {
  const { src, failed } = useFirstPicture([picture]);
  if (src === null) return <span className="gv-picture-name">{name}</span>;
  return (
    <img
      alt={name}
      className="gv-picture"
      decoding="async"
      draggable={false}
      loading="lazy"
      onError={failed}
      src={src}
    />
  );
}

export default memo(ItemPicture);
