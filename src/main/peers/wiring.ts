/**
 * The sharing gateway's half of the client, composed once (todo
 * 20261031-1156-01): the link over the kept token, the book of sheets heard,
 * the gateway's pin reports, each character's keys, the sharing that
 * claims them, and remote control's halves: the windows of those
 * controlling this install's characters, and the characters controlled from here. `client.ts` hands in what it
 * owns and routes the pushes; nothing here reads the configuration directly.
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
import type { SafetyDecision } from '../../shared/automation';
import type { SessionSummary } from '../../shared/ipc';
import type { WindowRegistry } from '../windows/WindowRegistry';
import { ControlDesk } from './ControlDesk';
import { RelayDesk } from './RelayDesk';
import type { HandlerTable, RelayIntercept } from './relayTransport';
import { RemoteSessions } from './RemoteSessions';

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
  /** Every handler, for a call a controller relays (`relayTransport`). */
  handlers: HandlerTable;
  windows: WindowRegistry;
  /** Why the line `by` typed into `id`'s terminal is not sent, or null (`screenLine`). */
  screen(id: SessionId, line: string, by: string): string | null;
  /** A remote control refusal, for `id`'s safety trace. */
  refused(id: SessionId, decision: SafetyDecision): void;
  /** `id`'s name on the rail. */
  nameOf(id: SessionId): string;
  /** The characters controlled from here changed: the rosters go out again. */
  rostersChanged(): void;
}

export interface Peers {
  observe(id: SessionId, state: CharacterState): void;
  /** The rows, the settings or the sessions changed. */
  refresh(): void;
  forget(id: SessionId): void;
  sheetsFor(id: SessionId): SharedSheet[];
  view(id: SessionId): ShareView;
  /** `id` opens `name`, a character shared with it, as a session here; the refusal, or null. */
  controlOpen(id: SessionId, name: string): string | null;
  /** Whatever `id` controls, closed. */
  controlClose(id: SessionId): void;
  /** The characters controlled from here, as the rail lists them. */
  remoteSummaries(): SessionSummary[];
  /** Calls about a character controlled from here, sent to its client. */
  readonly relay: RelayIntercept;
  /** Whether `windowId` is a controller's window on `session`, which types as the character's own. */
  isRelayWindow(windowId: number, session: SessionId): boolean;
  /** `id`'s player presses Stop on whoever controls it. */
  controlStop(id: SessionId): void;
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
      desk.lost();
      remotes.lost();
      changed();
    },
    unpinned: (peer, name, key) => {
      reports.report(peer, name, key);
      changed();
    },
    controlled: (frame) => desk.heard(frame),
    controlling: (frame) => remotes.heard(frame),
    say: (message) => deps.announce(t('peers.trouble', { message }))
  });
  const relay = new RelayDesk({
    handlers: deps.handlers,
    windows: deps.windows,
    link,
    screen: deps.screen,
    notice: deps.say,
    refused: deps.refused,
    say: (message) => deps.announce(t('peers.trouble', { message })),
    now: Date.now
  });
  const desk: ControlDesk = new ControlDesk({
    characterOf: (peer) => sharing.characterOf(peer),
    characterAt: (id) => sharing.characterAt(id),
    link,
    relay,
    notice: deps.say,
    changed: () => changed()
  });
  const remotes: RemoteSessions = new RemoteSessions({
    peerOf: (id) => sharing.peerOf(id),
    sheetsFor: (id) => sharing.sheetsFor(id),
    nameOf: deps.nameOf,
    link,
    windows: deps.windows,
    notice: deps.say,
    changed: () => {
      changed();
      deps.rostersChanged();
    },
    say: (message) => deps.announce(t('peers.trouble', { message })),
    answerMs: () => tuning().peers.controlAnswerMs
  });
  const sharing: Sharing = new Sharing({
    enabled: () => deps.settings().enabled,
    sessions: deps.sessions,
    pairFor: (id, realm) => keysFor(id).pairFor(realm),
    link,
    book,
    reports,
    publish: deps.publish,
    fault: (id, message) => deps.say(id, t('peers.keyNot', { message })),
    announce: (message) => deps.announce(t('peers.trouble', { message })),
    control: {
      controlling: (id) => remotes.view(id),
      controlledBy: (id) => desk.controlledBy(id),
      reclaimed: (ids) => {
        desk.regrant(ids);
        remotes.reclaimed();
      }
    }
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
      remotes.forget(id);
      sharing.forget(id);
    },
    sheetsFor: (id) => sharing.sheetsFor(id),
    view: (id) => sharing.view(id),
    controlOpen: (id, name) => remotes.open(id, name),
    controlClose: (id) => remotes.closeVia(id),
    remoteSummaries: () => remotes.summaries(),
    relay: remotes,
    isRelayWindow: (windowId, session) => relay.isRelayWindow(windowId, session),
    controlStop: (id) => desk.stop(id),
    dispose: () => {
      clearInterval(aging);
      link.dispose();
    }
  };
}
