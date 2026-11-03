/**
 * Each character's unsent work in this window: the Talk box's line and its
 * Up/Down history, the loop builder's half-built loop, and where the game
 * view's talk panel was last read to. Memory only; a character's record goes
 * when its tab leaves the window (todo 20261102-2220-02).
 */
import { useCallback, useEffect, useState } from 'react';

import type { TalkTyping } from '../components/ConversationCard';
import type { BuilderWork } from '../components/LoopBuilderCard';
import type { FeedStart } from '../lib/gameTalk';
import { keptSlot, SessionMemory, type Kept } from '../lib/sessionMemory';
import type { SessionId, SessionSummary } from '@shared/ipc';

export interface KeptWork {
  talk: Kept<TalkTyping>;
  builder: Kept<BuilderWork>;
  feed: Kept<FeedStart>;
}

export function useKeptWork(
  sessions: readonly Pick<SessionSummary, 'id'>[]
): (session: SessionId) => KeptWork {
  const [memory] = useState(
    () =>
      new SessionMemory<KeptWork>(() => ({
        talk: keptSlot(),
        builder: keptSlot(),
        feed: keptSlot()
      }))
  );
  useEffect(() => {
    memory.keepOnly(new Set(sessions.map((entry) => entry.id)));
  }, [memory, sessions]);
  return useCallback((session: SessionId) => memory.for(session), [memory]);
}
