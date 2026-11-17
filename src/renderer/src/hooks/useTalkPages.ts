/**
 * A scroll up the Talk card past what the window holds: the page before it is
 * asked of main's conversation log and joined onto that character's view.
 */
import { useCallback, useRef } from 'react';

import { withEarlier, type TalkBacklog } from '../lib/talkBacklog';
import type { IpcApi, SessionId } from '@shared/ipc';

/** The one write this makes: `patchView`, narrowed to the conversation. */
type PatchTalk = (id: SessionId, patch: <T extends TalkBacklog>(view: T) => T) => void;

/** Asks for the page before line `before` of one character's log; one ask at a time each. */
export type EarlierTalk = (session: SessionId, before: number) => void;

export function useTalkPages(api: Pick<IpcApi, 'talkPage'>, patch: PatchTalk): EarlierTalk {
  /** The characters with a page on its way: a scroll fires many times before one lands. */
  const asked = useRef(new Set<SessionId>());
  return useCallback(
    (session, before) => {
      if (asked.current.has(session)) return;
      asked.current.add(session);
      void api
        .talkPage(session, before)
        .then(
          (page) => patch(session, (view) => withEarlier(view, before, page)),
          // Main answers a log it cannot read with nothing and says so in the
          // console; this is the bridge itself failing.
          (error: unknown) => console.error(`talk: no earlier page for ${session}`, error)
        )
        .finally(() => asked.current.delete(session));
    },
    [api, patch]
  );
}
