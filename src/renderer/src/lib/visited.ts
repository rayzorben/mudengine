/**
 * How a room search says when a walk to a room last started: `1h 2m ago`.
 *
 * Two units, unlike a player sighting's one (`ago` in `players.tsx`): a room
 * stays where it is, so the minutes after the hours are true and tell two
 * recent walks apart. Floored at every step, so a phrase never claims a walk
 * more recent than the one that happened.
 */
import { t } from './i18n';
import type { FoundRoom } from '@shared/destinations';
import { roomId } from '@shared/world';

export function visitedAgo(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return t('rooms.visited.justNow');
  if (minutes < 60) return t('rooms.visited.minutes', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('rooms.visited.hours', { hours, minutes: minutes % 60 });
  return t('rooms.visited.days', { days: Math.floor(hours / 24), hours: hours % 24 });
}

/** A found room's reference, and when it was walked to if it ever was. */
export function foundRoomHint(room: FoundRoom, now: number): string {
  const reference = roomId(room.map, room.room);
  return room.visitedAt === null
    ? reference
    : t('rooms.visited.hint', {
        roomReference: reference,
        agoText: visitedAgo(room.visitedAt, now)
      });
}
