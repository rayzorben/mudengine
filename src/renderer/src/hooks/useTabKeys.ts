/**
 * The tab rail's keys: `Ctrl/Cmd Tab` and its shifted pair step through the
 * characters, and `Alt 1` to `Alt 9` show the first nine of this install's own
 * in the rail's order (`ownTabs`). A digit is matched by its physical key:
 * Option 2 on macOS still shows the second character, and a keypad digit
 * reaches the console, as does a digit past the last character.
 */
import { useHotkeys } from './useHotkeys';
import { ownTabs } from '../lib/roster';
import { CLIENT_KEYS, TAB_KEYS, codeOfKey } from '@shared/keys';
import type { SessionId, SessionSummary } from '@shared/ipc';

/** @param sessions The roster, in rail order. */
export function useTabKeys(
  sessions: readonly Pick<SessionSummary, 'id' | 'remote'>[],
  showSession: (id: SessionId) => void,
  stepSession: (delta: number) => void
): void {
  useHotkeys([
    { ...CLIENT_KEYS.nextTab, run: () => stepSession(1) },
    { ...CLIENT_KEYS.previousTab, run: () => stepSession(-1) },
    ...ownTabs(sessions)
      .slice(0, TAB_KEYS.length)
      .map((entry, at) => ({
        ...TAB_KEYS[at]!,
        code: codeOfKey(TAB_KEYS[at]!.key),
        run: () => showSession(entry.id)
      }))
  ]);
}
