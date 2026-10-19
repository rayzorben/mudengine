/**
 * The first of several pictures that has not failed to load, or null when
 * none is left, so a square never shows a broken image (todo 20261018-2032-01).
 * `failed` is the `<img>`'s `onError`.
 */
import { useCallback, useState } from 'react';

export function useFirstPicture(sources: readonly (string | null)[]): {
  src: string | null;
  failed(): void;
} {
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
  const src = sources.find((source) => source !== null && !missing.has(source)) ?? null;
  const failed = useCallback(() => {
    if (src !== null) setMissing((before) => new Set(before).add(src));
  }, [src]);
  return { src, failed };
}
