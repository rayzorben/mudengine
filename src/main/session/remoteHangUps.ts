/**
 * Another player's `@hangup`, `@panic!` and `@relog`, granted and let through
 * by `remotes.allowKillAndHangup` (todo 118): the session's own hang-up, under
 * its charge refusals (`Safety.hangUpAsked`), and for `@relog` the realm
 * dialled back once the socket has closed (`SessionSink.redial`).
 */
import type { RemoteEvents } from '../automation/Remotes';
import type { Safety } from './Safety';
import type { SessionSink } from './SessionSink';

export function remoteHangUps(
  safety: () => Pick<Safety, 'hangUpAsked'>,
  sink: Pick<SessionSink, 'redial'>
): Required<Pick<RemoteEvents, 'hangUp' | 'relog'>> {
  return {
    hangUp: (why) => safety().hangUpAsked(why),
    relog: (why) => {
      if (!safety().hangUpAsked(why)) return false;
      sink.redial();
      return true;
    }
  };
}
