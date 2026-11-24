/**
 * *Acquire item* for one character: asks main to go and get the item, and
 * says the refusal in that character's console, since the press has no panel
 * of its own to show it in. The palette's row and the item card's button share
 * it. See `mudengine-automation` › errands, *A route that needs an item goes
 * and gets it*.
 */
import { useCallback } from 'react';

import type { AcquireItem } from '../lib/acquire';
import type { IpcApi, SessionId } from '@shared/ipc';

export function useAcquireItem(
  api: Pick<IpcApi, 'acquireItem'>,
  session: SessionId,
  say: (session: SessionId, message: string) => void
): AcquireItem {
  return useCallback(
    (item) => {
      void api.acquireItem(session, item).then((refused) => {
        if (refused !== null) say(session, refused);
      });
    },
    [api, session, say]
  );
}
