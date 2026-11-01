/**
 * The room's picture in the Room card's compass, laid north up as the game
 * view lays it (`useRoomArt`, mirrored first, then turned). Mounted only on a
 * card big enough to show it, so a small card holds no subscription. No
 * picture draws the plain dot.
 */
import type { CSSProperties } from 'react';

import { useRoomArt, type RoomArtApi } from '../hooks/useRoomArt';
import type { SessionId } from '@shared/ipc';

export default function RoomPicture({ art, session }: { art: RoomArtApi; session: SessionId }) {
  const picture = useRoomArt(art, session);
  // The hook decodes an `Image`; the arena's type is wider because a canvas draws any source.
  if (picture === null || !(picture.image instanceof HTMLImageElement)) {
    return <i aria-hidden="true" className="compass-dot" />;
  }
  const { quarters, mirrored } = picture.turn;
  return (
    <img
      alt=""
      className="room-picture"
      src={picture.image.src}
      style={{ '--turn': `${quarters * 90}deg`, '--mirror': mirrored ? -1 : 1 } as CSSProperties}
    />
  );
}
