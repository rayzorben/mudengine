/**
 * The sharing gateway's half of the client, composed once (todo
 * 20261031-1156-01): the link over the kept token, the book of sheets heard,
 * the gateway's pin reports, each character's keys, the sharing that
 * claims them, and remote control's two halves. `client.ts` hands in what it
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
import type { ControlAction, ControlAnswer, ControlText } from '../../shared/peerControl';
import { ControlDesk } from './ControlDesk';
import { Controlling } from './Controlling';

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
  /** One remote control action on this install's character `id`, from `by`. */
  runControl(id: SessionId, action: ControlAction, by: string): Promise<ControlAnswer>;
  /** A remote control refusal, for `id`'s safety trace. */
  refused(id: SessionId, decision: SafetyDecision): void;
  /** Terminal text of the character `id` controls, for `id`'s window. */
  controlText(id: SessionId, piece: ControlText): void;
}

export interface Peers {
  observe(id: SessionId, state: CharacterState): void;
  /** The rows, the settings or the sessions changed. */
  refresh(): void;
  forget(id: SessionId): void;
  sheetsFor(id: SessionId): SharedSheet[];
  view(id: SessionId): ShareView;
  /** What `id`'s terminal painted, for whoever controls it. */
  painted(id: SessionId, text: string): void;
  /** `id` opens the terminal of `name`, a character shared with it; the refusal, or null. */
  controlOpen(id: SessionId, name: string): string | null;
  controlClose(id: SessionId): void;
  controlAct(id: SessionId, action: ControlAction): Promise<ControlAnswer>;
  /** The text `id` has been sent of the character it controls. */
  controlBacklog(id: SessionId): ControlText;
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
      controlling.lost();
      changed();
    },
    unpinned: (peer, name, key) => {
      reports.report(peer, name, key);
      changed();
    },
    controlled: (frame) => desk.heard(frame),
    controlling: (frame) => controlling.heard(frame),
    say: (message) => deps.announce(t('peers.trouble', { message }))
  });
  const desk: ControlDesk = new ControlDesk({
    characterOf: (peer) => sharing.characterOf(peer),
    characterAt: (id) => sharing.characterAt(id),
    run: deps.runControl,
    link,
    notice: deps.say,
    refused: deps.refused,
    changed: () => changed(),
    backlogChars: () => tuning().peers.controlBacklogChars,
    now: Date.now
  });
  const controlling: Controlling = new Controlling({
    peerOf: (id) => sharing.peerOf(id),
    sheetsFor: (id) => sharing.sheetsFor(id),
    link,
    text: deps.controlText,
    notice: deps.say,
    changed: () => changed(),
    backlogChars: () => tuning().peers.controlBacklogChars,
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
      controlling: (id) => controlling.view(id),
      controlledBy: (id) => desk.controlledBy(id),
      reclaimed: (ids) => {
        desk.regrant(ids);
        controlling.reclaimed();
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
      controlling.forget(id);
      sharing.forget(id);
    },
    sheetsFor: (id) => sharing.sheetsFor(id),
    view: (id) => sharing.view(id),
    painted: (id, text) => desk.painted(id, text),
    controlOpen: (id, name) => controlling.open(id, name),
    controlClose: (id) => controlling.close(id),
    controlAct: (id, action) => controlling.act(id, action),
    controlBacklog: (id) => controlling.backlog(id),
    controlStop: (id) => desk.stop(id),
    dispose: () => {
      clearInterval(aging);
      link.dispose();
    }
  };
}
