/**
 * The item picture index, loaded the first time a panel that draws pictures
 * opens. A chunk of its own (about 250 kB), so the window's first paint does
 * not carry it; one load for the window, shared by every panel.
 */
import { useEffect, useState } from 'react';

import { asItemArtIndex, type ItemArtIndex } from '../lib/itemArt';

let loading: Promise<ItemArtIndex | null> | null = null;

function loadIndex(): Promise<ItemArtIndex | null> {
  loading ??= import('../assets/item-art-index.json').then(
    (module) => {
      const index = asItemArtIndex(module.default);
      if (index === null) console.warn('item art: the index is not format 1; pictures are off');
      return index;
    },
    (error: unknown) => {
      console.warn(`item art: the index did not load: ${String(error)}`);
      return null;
    }
  );
  return loading;
}

/** The index, or null until it has loaded (and for good if it cannot). */
export function useItemArt(): ItemArtIndex | null {
  const [index, setIndex] = useState<ItemArtIndex | null>(null);
  useEffect(() => {
    let live = true;
    void loadIndex().then((loaded) => {
      if (live) setIndex(loaded);
    });
    return () => {
      live = false;
    };
  }, []);
  return index;
}
