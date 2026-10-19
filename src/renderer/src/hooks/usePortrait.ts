/**
 * The character's portrait from the art server (todo 20261019-0931-01), as
 * main holds it: read when the panel opens and followed while it stays open.
 * Opening the panel asks main what it has; main alone decides when to ask the
 * server.
 */
import { useEffect, useState } from 'react';

import type { IpcApi, SessionId } from '@shared/ipc';
import { NO_PORTRAIT, withChange, type PortraitView } from '@shared/portrait';

export function usePortrait(
  api: Pick<IpcApi, 'portrait' | 'onPortrait'>,
  session: SessionId
): PortraitView {
  const [view, setView] = useState<PortraitView>(NO_PORTRAIT);
  useEffect(() => {
    let live = true;
    // A push that lands before the read answers is newer than it, but may carry no picture.
    let pushed = false;
    const off = api.onPortrait((message) => {
      if (message.session !== session) return;
      pushed = true;
      setView((before) => withChange(before, message.payload));
    });
    api.portrait(session).then(
      (current) => {
        if (!live) return;
        setView((before) =>
          pushed ? { picture: before.picture ?? current.picture, status: before.status } : current
        );
      },
      (error: unknown) => console.warn(`portrait: main did not answer: ${String(error)}`)
    );
    return () => {
      live = false;
      off();
    };
  }, [api, session]);
  return view;
}
