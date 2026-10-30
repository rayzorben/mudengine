/**
 * The picture of the room the character is in (todo 20261020-2015-01), as
 * main holds it: read when the game view opens and followed while it stays
 * open, then decoded once outside the draw loop, with the turn that lays it
 * north up (todo 20261021-1417-01). Main alone decides when to ask the art
 * server. A picture that fails to load draws nothing, as the arena looked before.
 */
import { useEffect, useState } from 'react';

import type { IpcApi, SessionId } from '@shared/ipc';
import { NO_ROOM_ART, roomPictureUrl, turnOf, type RoomArtView } from '@shared/roomArt';
import type { ArenaPicture } from '../components/game/drawArena';

export function useRoomArt(
  api: Pick<IpcApi, 'roomArt' | 'onRoomArt'>,
  session: SessionId
): ArenaPicture | null {
  const [view, setView] = useState<RoomArtView>(NO_ROOM_ART);
  const [image, setImage] = useState<ArenaPicture | null>(null);
  useEffect(() => {
    let live = true;
    // A push that lands before the read answers is newer than it.
    let pushed = false;
    const off = api.onRoomArt((message) => {
      if (message.session !== session) return;
      pushed = true;
      setView(message.payload);
    });
    api.roomArt(session).then(
      (current) => {
        if (live && !pushed) setView(current);
      },
      (error: unknown) => console.warn(`room art: main did not answer: ${String(error)}`)
    );
    return () => {
      live = false;
      off();
    };
  }, [api, session]);
  useEffect(() => {
    const { picture } = view;
    if (picture === null) {
      setImage(null);
      return;
    }
    let live = true;
    const loading = new Image();
    loading.decoding = 'async';
    loading.src = roomPictureUrl(picture);
    loading.decode().then(
      () => {
        if (live) setImage({ image: loading, turn: turnOf(picture) });
      },
      () => {
        if (live) setImage(null);
      }
    );
    return () => {
      live = false;
    };
  }, [view]);
  return image;
}
