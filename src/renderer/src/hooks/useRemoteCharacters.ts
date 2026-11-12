/**
 * The tab rail's Sharing with you (todo 20261031-1156-01): what every one of
 * this install's characters on the rail is shared, followed while it is on
 * the rail, folded into one row per sharer (`remoteCharacters`).
 */
import { useEffect, useMemo, useState } from 'react';

import { remoteCharacters, type RemoteCharacter } from '../lib/remoteCharacters';
import { followShares, type SharesApi } from '../lib/shares';
import type { SessionId, SessionSummary } from '@shared/ipc';
import type { ShareView } from '@shared/peers';
import { sameJson } from '@shared/values';

export function useRemoteCharacters(
  api: SharesApi,
  sessions: readonly SessionSummary[]
): RemoteCharacter[] {
  // By value, so a roster pushed again with the same characters does not read every view again.
  const idsKey = useMemo(() => sessions.map((each) => each.id).join('\n'), [sessions]);
  const [views, setViews] = useState<ReadonlyMap<SessionId, ShareView>>(() => new Map());
  useEffect(() => {
    const wanted = idsKey === '' ? [] : idsKey.split('\n');
    setViews((held) => new Map([...held].filter(([id]) => wanted.includes(id))));
    // A sharer's beat pushes the view again unchanged; the rail redraws only when it moved.
    return followShares(api, wanted, (session, view) =>
      setViews((held) => {
        const was = held.get(session);
        return was !== undefined && sameJson(was, view) ? held : new Map(held).set(session, view);
      })
    );
  }, [api, idsKey]);
  return useMemo(() => remoteCharacters(sessions, views), [sessions, views]);
}
