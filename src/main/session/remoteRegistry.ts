/**
 * What another player's `@` traffic says about them, written onto their
 * registry entry (the Player card reads it) and pushed at once, since nothing
 * else moved: the command they sent, the client `@version` named, and the
 * room `@where-room` placed them in, said in the console too.
 */
import { t } from '../app/i18n';
import type { RemoteEvents } from '../automation/Remotes';
import type { CharacterTracker } from '../parse/CharacterTracker';
import { roomId } from '../../shared/world';
import type { Publisher } from './Publisher';

export function remoteRegistry(
  tracker: Pick<CharacterTracker, 'noteRemoteCall' | 'noteRemoteClient' | 'noteRemoteRoom'>,
  publisher: () => Pick<Publisher, 'players'>,
  notice: (message: string) => void
): Required<Pick<RemoteEvents, 'commanded' | 'clientNamed' | 'placed'>> {
  return {
    commanded: (from, raw, at) => {
      if (tracker.noteRemoteCall(from, raw, at)) publisher().players();
    },
    clientNamed: (from, client, extended) => {
      const facts = { ...(client === undefined ? {} : { client }), extendedRemotes: extended };
      if (tracker.noteRemoteClient(from, Date.now(), facts)) publisher().players();
    },
    placed: (from, map, room, name) => {
      const address = roomId(map, room);
      notice(
        t('session.remotes.peerPlaced', {
          who: from,
          address,
          room: name ?? t('session.remotes.peerPlacedUnnamed')
        })
      );
      if (tracker.noteRemoteRoom(from, address, name, Date.now())) publisher().players();
    }
  };
}
