/**
 * The sharing gateway's half of the client, composed once (todo
 * 20261031-1156-01): the link over the kept token, the book of sheets heard,
 * the gateway's pin reports, each character's keys and the sharing that
 * claims them. `client.ts` hands in what it owns and routes the pushes;
 * nothing here reads the configuration directly.
 */
import { randomBytes } from 'node:crypto';

import { newEd25519Pair, signEd25519 } from '../../node/ed25519';
import { connectWebSocket } from '../../node/sockets';
import type { TuningConfig } from '../../shared/internal';
import type { SessionId } from '../../shared/ipc';
import type { ShareView, SharedSheet } from '../../shared/peers';
import { asPeerToken, PEER_MAX_MESSAGE_BYTES } from '../../shared/peerWire';
import type { PeersConfig } from '../../shared/peersConfig';
import type { Home } from '../app/home';
import { t } from '../app/i18n';
import { tokensAt } from '../app/tokenFile';
import { solveOnWorker } from '../art/proofOfWork';
import { PeerBook } from './PeerBook';
import { peerKeysAt, type PeerKeyStore } from './peerKeys';
import { PeerLink } from './PeerLink';
import { registerWithGateway } from './peerRegistration';
import { PinReports } from './PinReports';
import { Sharing, type SharingSession } from './Sharing';
import type { CharacterState } from '../../shared/character';

/** Where the gateway's token is kept, beside the art server's. */
export const PEER_TOKEN_FILE = '.peer-token';

export interface PeersDeps {
  home: Pick<Home, 'state'>;
  /** `peers`, read through: the settings are hot-reloaded. */
  settings(): PeersConfig;
  /** `tuning()`, read through; its `peers` group. */
  tuning(): Pick<TuningConfig, 'peers'>;
  buildSecret: string | null;
  /** Where the proof of work's worker was built. */
  worker: string;
  sessions(): readonly SharingSession[];
  publish(id: SessionId, view: ShareView): void;
  /** A character's console: its key could not be kept. */
  say(id: SessionId, message: string): void;
  /** The client's own log, for what is nobody's character. */
  announce(message: string): void;
}

export interface Peers {
  observe(id: SessionId, state: CharacterState): void;
  /** The rows, the settings or the sessions changed. */
  refresh(): void;
  forget(id: SessionId): void;
  sheetsFor(id: SessionId): SharedSheet[];
  view(id: SessionId): ShareView;
  dispose(): void;
}

export function wirePeers(deps: PeersDeps): Peers {
  const { tuning } = deps;
  const keys = new Map<SessionId, PeerKeyStore>();
  const keysFor = (id: SessionId): PeerKeyStore => {
    const kept =
      keys.get(id) ?? peerKeysAt(deps.home.state('peer-keys', `${id}.json`), newEd25519Pair);
    keys.set(id, kept);
    return kept;
  };
  const book = new PeerBook(
    () => tuning().peers.staleMs,
    () => tuning().peers.mostSharers,
    Date.now,
    (message) => deps.announce(t('peers.trouble', { message }))
  );
  const reports = new PinReports();
  // The view changes with every frame heard; set once the sharing exists.
  let changed = (): void => undefined;
  const link = new PeerLink({
    server: () => deps.settings().server,
    limits: () => {
      const { retryLeastMs, retryMostMs, pingEveryMs, freshEveryMs } = tuning().peers;
      return { retryLeastMs, retryMostMs, pingEveryMs, freshEveryMs };
    },
    tokens: tokensAt(deps.home.state(PEER_TOKEN_FILE), asPeerToken),
    register: (server) => {
      const secret = deps.buildSecret;
      if (secret === null) return Promise.reject(new Error(t('peers.noBuildSecret')));
      const { requestMs, mostBits, workMs } = tuning().peers;
      return registerWithGateway(server, {
        buildSecret: secret,
        solve: (challenge, bits) => solveOnWorker(deps.worker, challenge, bits, workMs),
        requestMs,
        mostBits,
        fetch
      });
    },
    dial: (url) => {
      const { requestMs, maxBufferedBytes, deflateMinBytes } = tuning().peers;
      return connectWebSocket(url, {
        timeoutMs: requestMs,
        maxMessageBytes: PEER_MAX_MESSAGE_BYTES,
        maxBufferedBytes,
        deflateMinBytes
      });
    },
    sign: signEd25519,
    random: (bytes) => randomBytes(bytes).toString('hex'),
    now: Date.now,
    heard: (frame) => {
      book.heard(frame);
      changed();
    },
    linked: () => changed(),
    lost: () => {
      book.clear();
      reports.clear();
      changed();
    },
    unpinned: (peer, name, key) => {
      reports.report(peer, name, key);
      changed();
    },
    say: (message) => deps.announce(t('peers.trouble', { message }))
  });
  const sharing = new Sharing({
    enabled: () => deps.settings().enabled,
    sessions: deps.sessions,
    pairFor: (id, realm) => keysFor(id).pairFor(realm),
    link,
    book,
    reports,
    publish: deps.publish,
    fault: (id, message) => deps.say(id, t('peers.keyNot', { message })),
    announce: (message) => deps.announce(t('peers.trouble', { message }))
  });
  changed = () => sharing.publish();
  // A sheet ages out with no frame to say so: the views are read again on the sharer's beat.
  const aging = setInterval(changed, tuning().peers.freshEveryMs);
  aging.unref();
  return {
    observe: (id, state) => sharing.observe(id, state),
    refresh: () => sharing.refresh(),
    forget: (id) => {
      keys.delete(id);
      sharing.forget(id);
    },
    sheetsFor: (id) => sharing.sheetsFor(id),
    view: (id) => sharing.view(id),
    dispose: () => {
      clearInterval(aging);
      link.dispose();
    }
  };
}
