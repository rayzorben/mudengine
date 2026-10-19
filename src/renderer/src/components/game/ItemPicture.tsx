/**
 * One item's picture, or its name where the art run drew none or the file is
 * not there: a square never shows a broken image (todo 20261018-2032-01).
 */
import { memo, useState } from 'react';

function ItemPicture({ src, name }: { src: string | null; name: string }) {
  const [missing, setMissing] = useState<string | null>(null);
  if (src === null || missing === src) return <span className="gv-picture-name">{name}</span>;
  return (
    <img
      alt={name}
      className="gv-picture"
      decoding="async"
      draggable={false}
      loading="lazy"
      onError={() => setMissing(src)}
      src={src}
    />
  );
}

export default memo(ItemPicture);
