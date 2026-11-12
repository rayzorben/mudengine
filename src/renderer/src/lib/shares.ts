/**
 * Following what main holds of sharing for some of this window's characters
 * (todo 20261031-1156-01): each one read once, then every push for it. A push
 * that lands before its read answers is newer than the read, so the read is
 * dropped. The Players card follows one character, the tab rail all of them.
 */
import type { IpcApi, SessionId } from '@shared/ipc';
import type { ShareView } from '@shared/peers';

/** The bridge calls sharing is read through. */
export type SharesApi = Pick<IpcApi, 'shares' | 'onShares'>;

/** Calls `put` with each of `sessions`' views as it is read and pushed; the return stops it. */
export function followShares(
  api: SharesApi,
  sessions: readonly SessionId[],
  put: (session: SessionId, view: ShareView) => void
): () => void {
  const wanted = new Set(sessions);
  const pushed = new Set<SessionId>();
  let live = true;
  const off = api.onShares((message) => {
    if (!live || !wanted.has(message.session)) return;
    pushed.add(message.session);
    put(message.session, message.payload);
  });
  for (const session of wanted) {
    api.shares(session).then(
      (current) => {
        if (live && !pushed.has(session)) put(session, current);
      },
      (error: unknown) => console.warn(`shares: main did not answer: ${String(error)}`)
    );
  }
  return () => {
    live = false;
    off();
  };
}
