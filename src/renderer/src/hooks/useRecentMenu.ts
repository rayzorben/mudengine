/**
 * The recent rooms and loops for one character's right-click menu, asked of
 * main when the menu opens and never pushed (todo 28). A failed ask is said in
 * that character's console and the menu opens with Copy and Paste alone.
 */
import { useCallback } from 'react';

import type { MenuItem } from '../components/PopupMenu';
import { t } from '../lib/i18n';
import { recentMenuItems } from '../lib/recentMenu';
import type { IpcApi, SessionId } from '@shared/ipc';
import { errorMessage } from '@shared/values';
import type { WorldRoom } from '@shared/world';

export interface RecentMenuInputs {
  api: Pick<IpcApi, 'searchRooms' | 'recentLoops' | 'routeTo' | 'walkRoute' | 'startLoop'>;
  /** The route panel, on a room a click could not walk to unread. */
  openRouteOn(room: WorldRoom, search: null): void;
  /** A refusal said in its own character's console (`useMovement`). */
  sayRefusal(sid: SessionId): (refused: string | null) => void;
}

export function useRecentMenu({
  api,
  openRouteOn,
  sayRefusal
}: RecentMenuInputs): (sid: SessionId) => Promise<MenuItem[]> {
  return useCallback(
    async (sid: SessionId) => {
      try {
        // A blank query answers with the latest walks only (`records.destinationsShown`).
        const [rooms, loops] = await Promise.all([api.searchRooms(sid, ''), api.recentLoops(sid)]);
        const deps = {
          api,
          session: sid,
          openRouteOn,
          startLoop: (name: string) => void api.startLoop(sid, name).then(sayRefusal(sid))
        };
        return recentMenuItems(rooms, loops, deps, Date.now());
      } catch (error) {
        sayRefusal(sid)(t('terminal.contextMenu.recentFailed', { message: errorMessage(error) }));
        return [];
      }
    },
    [api, openRouteOn, sayRefusal]
  );
}
