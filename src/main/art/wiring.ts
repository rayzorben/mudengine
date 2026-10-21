/**
 * The art server's half of the client, composed once (todo 20261019-0931-01,
 * 20261020-2015-01): one `ArtClient` over the kept token, a store on disk per
 * kind of drawing, the shipped room index, and a keeper per character for
 * portraits and for room pictures. `client.ts` hands in what it owns and
 * routes the pushes; nothing here reads the configuration directly.
 */
import type { ArtConfig } from '../../shared/artConfig';
import type { TuningConfig } from '../../shared/internal';
import type { SessionId } from '../../shared/ipc';
import type { PortraitChange } from '../../shared/portrait';
import type { RoomArtView } from '../../shared/roomArt';
import type { Home } from '../app/home';
import { t } from '../app/i18n';
import { ArtClient } from './ArtClient';
import { ART_TOKEN_FILE, artTokensAt } from './artToken';
import { lastPortraitAt, PictureCache } from './pictureCache';
import { Portraits } from './Portraits';
import { solveOnWorker } from './proofOfWork';
import { RoomArt } from './RoomArt';
import { ShippedRoomArt } from './ShippedRoomArt';

export interface ArtDeps {
  home: Pick<Home, 'state' | 'record'>;
  /** `art`, read through: the settings are hot-reloaded. */
  settings(): ArtConfig;
  /** `tuning()`, read through; its `art` group. */
  tuning(): Pick<TuningConfig, 'art'>;
  buildSecret: string | null;
  /** Where the proof of work's worker was built. */
  worker: string;
  /** The shipped room pictures' index, under the resources. */
  roomIndex: string;
  publishPortrait(id: SessionId, change: PortraitChange): void;
  publishRoom(id: SessionId, view: RoomArtView): void;
  /** A character's console: a refusal or a failure. */
  say(id: SessionId, message: string): void;
  /** The client's own log, for what is nobody's character. */
  announce(message: string): void;
}

export interface Art {
  portraits: Portraits;
  rooms: RoomArt;
  shipped: ShippedRoomArt;
}

export function wireArt(deps: ArtDeps): Art {
  const { tuning } = deps;
  const client = new ArtClient({
    server: () => deps.settings().server,
    buildSecret: deps.buildSecret,
    tokens: artTokensAt(deps.home.state(ART_TOKEN_FILE)),
    solve: (challenge, bits) => solveOnWorker(deps.worker, challenge, bits, tuning().art.workMs),
    limits: () => {
      const { requestMs, drawMs, mostBits, pollMs, pollMostMs, pollLeastMs } = tuning().art;
      return { requestMs, drawMs, mostBits, pollMs, pollMostMs, pollLeastMs };
    }
  });
  const shipped = new ShippedRoomArt(deps.roomIndex, (message) =>
    deps.announce(t('art.roomIndexUnread', { message }))
  );
  return {
    shipped,
    portraits: new Portraits({
      source: client,
      cache: new PictureCache(
        deps.home.state('art', 'portraits'),
        () => tuning().art.portraitsKept
      ),
      lastFor: (id) => lastPortraitAt(deps.home.record('portrait', id)),
      enabled: () => deps.settings().enabled,
      publish: deps.publishPortrait,
      say: (id, message) => deps.say(id, t('art.portraitNot', { message }))
    }),
    rooms: new RoomArt({
      shipped,
      source: client,
      cache: new PictureCache(deps.home.state('art', 'rooms'), () => tuning().art.roomsKept),
      enabled: () => deps.settings().rooms,
      publish: deps.publishRoom,
      say: (id, message) => deps.say(id, t('art.roomNot', { message }))
    })
  };
}
