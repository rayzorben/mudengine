/**
 * The reason a walk or a lap ends when a person stops it: the player's Stop,
 * or another player's `@stop` naming its sender (todo 15). An errand or a
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

/** Whether a walk ended because a person stopped it, whoever that was. */
export function stoppedByPerson(reason: string | null): reason is string {
  if (reason === null) return false;
  return (
    reason === t('session.walk.stoppedByPlayer') || isSaidBy('session.walk.stoppedByRemote', reason)
  );
}
