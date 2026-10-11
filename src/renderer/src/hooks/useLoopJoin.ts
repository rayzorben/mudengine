/**
 * A loop picked in the Loops modal, shown before it starts: the route panel
 * opens on the stop the lap joins, with the leg it would walk, and its press
 * starts the loop. Standing in a stop already, the loop starts at once, as
 * it always did.
 *
 * See `mudengine-ui` › `parts/map.md`, *The route panel shows the way to a
 * loop*.
 */
import { useCallback, useRef } from 'react';

import { t } from '../lib/i18n';
import type { LoopChoice, LoopDestination, LoopJoining } from '../lib/loops';
import type { IpcApi, SessionId } from '@shared/ipc';

export interface LoopJoinInputs {
  api: Pick<IpcApi, 'loopJoin'>;
  /** The character on screen, whose loop it is. */
  session: SessionId;
  /** Files the loop where the modal said and starts it (`useMovement`). */
  runChosenLoop(choice: LoopChoice, destination: LoopDestination): void;
  openToJoin(joining: LoopJoining): void;
  /** A sentence into one character's console. */
  say(session: SessionId, message: string): void;
}

/** What the Loops modal's choice does. */
export function useLoopJoin({ api, session, runChosenLoop, openToJoin, say }: LoopJoinInputs) {
  // The character on screen when an answer lands: one picked on another tab is dropped.
  const shown = useRef(session);
  shown.current = session;
  return useCallback(
    (choice: LoopChoice, destination: LoopDestination) => {
      const start = () => runChosenLoop(choice, destination);
      const loop = choice.kind === 'by-name' ? choice.name : choice.loop;
      const loopName = choice.kind === 'by-name' ? choice.name : choice.loop.name;
      void api
        .loopJoin(session, loop)
        .catch((error: unknown) => ({ refused: String(error) }))
        .then((join) => {
          if (shown.current !== session) return;
          if ('refused' in join) {
            say(session, join.refused);
            return;
          }
          if ('joins' in join) {
            openToJoin({ loopName, at: join.joins, route: join.route, start });
            return;
          }
          /*
           * Standing on the loop, or no way to draw that the lap still tries:
           * it locates the character itself and says why a stop cannot be
           * reached, as it did before there was a preview.
           */
          if ('unshown' in join && join.unshown !== null) {
            say(session, t('loops.joinUnshown', { reason: join.unshown }));
          }
          start();
        });
    },
    [api, session, runChosenLoop, openToJoin, say]
  );
}
