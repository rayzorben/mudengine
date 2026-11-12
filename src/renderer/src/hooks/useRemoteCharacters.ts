/**
 * The tab rail's Sharing with you (todo 20261031-1156-01): what every
 * character on the rail is shared, followed while it is on the rail, folded
 * into one row per sharer (`remoteCharacters`); which of them control a
 * shared character (`controllers`), from the same views, so the rail and the
 * panes agree on which console shows; and which panes have their remote
 * console set aside (`remoteAside`).
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { remoteAside } from '../lib/remoteAside';
import { controllers, remoteCharacters, type RemoteCharacter } from '../lib/remoteCharacters';
import { followShares, type SharesApi } from '../lib/shares';
import type { SessionId, SessionSummary } from '@shared/ipc';
import type { ShareView } from '@shared/peers';
import { sameJson } from '@shared/values';

export interface RemoteCharacters {
  remotes: RemoteCharacter[];
  /** The rail's characters controlling a shared one. */
  controlling: ReadonlySet<SessionId>;
  aside: ReadonlySet<SessionId>;
}

export function useRemoteCharacters(
  api: SharesApi,
  sessions: readonly SessionSummary[]
): RemoteCharacters {
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
  const aside = useRemoteAside();
  const remotes = useMemo(() => remoteCharacters(sessions, views), [sessions, views]);
  const controlling = useMemo(() => controllers(views), [views]);
  return { remotes, controlling, aside };
}

/** The panes showing their own console while they control a shared one. */
export function useRemoteAside(): ReadonlySet<SessionId> {
  return useSyncExternalStore(remoteAside.subscribe, remoteAside.read);
}
