/** Drop the oldest entries of an insertion-ordered map until it holds `most`. */
export function trimOldest<K, V>(map: Map<K, V>, most: number): void {
  for (const key of map.keys()) {
    if (map.size <= most) return;
    map.delete(key);
  }
}
