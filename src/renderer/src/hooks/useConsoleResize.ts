/**
 * A console's new size, reported to its session. The status rail describes the
 * slate in front of you, so it follows the shown character; every session
 * still reports its own geometry. They share a box, so the numbers agree, but
 * each says so for itself, which stays correct once panes can differ.
 *
 * Moved out of `App`, where it was one callback.
 */
import { useCallback, type MutableRefObject } from 'react';

import type { IpcApi, SessionId } from '@shared/ipc';
import type { TerminalSize } from '@shared/types';

export function useConsoleResize(
  api: Pick<IpcApi, 'resize'>,
  shown: MutableRefObject<SessionId>,
  setSize: (size: TerminalSize) => void
): (id: SessionId, next: TerminalSize) => void {
  return useCallback(
    (id: SessionId, next: TerminalSize) => {
      if (id === shown.current) setSize(next);
      api.resize(id, next);
    },
    [api, shown, setSize]
  );
}
