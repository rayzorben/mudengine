/**
 * Which picture stands for a character: the portrait the art server drew,
 * else the bundled picture for its race and class, else its initial. The game
 * view's portrait head and the tab circles both draw from this order.
 */
import type { PortraitView } from '@shared/portrait';
import { portraitOf, type ItemArtIndex } from '../lib/itemArt';
import { useFirstPicture } from './useFirstPicture';

export function useCharacterPicture(
  art: ItemArtIndex | null,
  portrait: PortraitView,
  race: string | null,
  className: string | null,
  name: string
): {
  /** Null when no picture loads, and `initial` stands in. */
  src: string | null;
  /** The `<img>`'s `onError`. */
  failed(): void;
  /** `src` is the art server's drawing of this character, a whole figure. */
  drawn: boolean;
  initial: string;
} {
  const kind = art === null ? null : portraitOf(art, race, className);
  const { src, failed } = useFirstPicture([portrait.picture, kind]);
  return {
    src,
    failed,
    drawn: src !== null && src === portrait.picture,
    initial: name.slice(0, 1).toUpperCase()
  };
}
