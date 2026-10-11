/**
 * What landed in a character's alert log since the last look, for the two
 * readers of the landed log (`useDesktopAlerts`, `useAlertSounds`): notices
 * are folded in inside a state updater React may run twice, so a side effect
 * reads what landed instead. Moves the mark to the newest either way.
 */
import type { SessionId } from '@shared/ipc';
import type { Notice } from '@shared/notifications';

/**
 * The fresh notices, oldest first, or null when there are none or this is the
 * first sight of the character: a tab attached after an hour has an hour of
 * alerts behind it, and they are over.
 */
export function freshNotices(
  seen: Map<SessionId, string>,
  id: SessionId,
  notices: readonly Notice[]
): readonly Notice[] | null {
  const newest = notices.at(-1);
  if (newest === undefined) {
    seen.delete(id);
    return null;
  }
  const mark = seen.get(id);
  seen.set(id, newest.id);
  if (mark === undefined || mark === newest.id) return null;
  const at = notices.findIndex((notice) => notice.id === mark);
  return at === -1 ? notices : notices.slice(at + 1);
}
