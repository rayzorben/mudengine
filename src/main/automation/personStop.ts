/**
 * The reason a walk or a lap ends when a person stops it: the player's Stop,
 * another player's `@stop` naming its sender (todo 15), or this character
 * starting to follow a leader, who moves it from then on. An errand or a
 * quest run reads it to end rather than plan its leg again, since a stopped
 * character stays where it is. See `mudengine-automation` › `parts/remotes.md`.
 */
import { isSaidBy, t } from '../app/i18n';

/** The reason a stop gives: the player's own (null), or the named sender of `@stop`. */
export function personStop(by: string | null): string {
  return by === null
    ? t('session.walk.stoppedByPlayer')
    : t('session.walk.stoppedByRemote', { who: by });
}

/**
 * The reason everything stops when this character starts following `leader`
 * (the user, 2026-11-22: Cretin joined Festus while its loop rested, and the
 * loop walked it out of the party 23 seconds later).
 */
export function followStop(leader: string): string {
  return t('session.walk.stoppedFollowing', { leader });
}

/**
 * Whether a walk ended because a person stopped it, whoever that was. Starting
 * to follow a leader counts, since the leader moves the character from then on.
 */
export function stoppedByPerson(reason: string | null): reason is string {
  if (reason === null) return false;
  return (
    reason === t('session.walk.stoppedByPlayer') ||
    isSaidBy('session.walk.stoppedByRemote', reason) ||
    isSaidBy('session.walk.stoppedFollowing', reason)
  );
}
