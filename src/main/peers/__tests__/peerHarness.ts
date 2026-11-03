/**
 * Installs' links against the gateway in process, on a real port: one plays
 * Brakkle and shares him with Soul, the other plays Soul. Every step goes
 * over the WebSocket client this build dials with. `useGateway` starts and
 * stops the gateway around each test of the file that calls it.
 */
import { afterEach, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

import { createGateway, type Gateway } from '../../../gateway/server';
import { GATEWAY_LIMITS } from '../../../gateway/limits';
import { signEd25519, verifyEd25519 } from '../../../node/ed25519';
import { solveProofOfWork } from '../../../node/proofOfWork';
import { connectWebSocket } from '../../../node/sockets';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { PeerKey } from '../../../shared/peers';
import type { PeerToken } from '../../../shared/peerWire';
import { PeerBook } from '../PeerBook';
import { PeerLink, type PeerLinkDeps } from '../PeerLink';
import { registerWithGateway } from '../peerRegistration';

const SECRET = 'build-secret-for-the-test';
export const REALM = 'orohost:2427/GreaterMUD';
export const brakkle: PeerKey = { realm: REALM, name: 'Brakkle' };
export const soul: PeerKey = { realm: REALM, name: 'Soul' };

let gateway: Gateway;
let server: string;
const links: PeerLink[] = [];

export function useGateway(): void {
  beforeEach(async () => {
    gateway = createGateway({
      buildSecret: SECRET,
      verify: verifyEd25519,
      limits: { ...GATEWAY_LIMITS, powBits: 4, pingEveryMs: 60_000 },
      now: Date.now,
      random: (bytes) => randomBytes(bytes).toString('hex'),
      log: () => {}
    });
    server = `http://127.0.0.1:${await gateway.listen(0, '127.0.0.1')}`;
  });

  afterEach(async () => {
    for (const link of links.splice(0)) link.dispose();
    await gateway.close();
  });
}

/** Where an install's control frames go, set once what reads them is built. */
export type ControlHooks = Partial<Pick<PeerLinkDeps, 'controlled' | 'controlling'>>;

/** One install: its link, the book it fills, and what it was told. */
export function install(hooks: ControlHooks = {}): {
  link: PeerLink;
  book: PeerBook;
  unpinned: Array<{ name: string; key: string }>;
  said: string[];
  changed: () => Promise<void>;
  wake: () => void;
} {
  let token: PeerToken | null = null;
  const book = new PeerBook(
    () => 60_000,
    () => 256,
    Date.now,
    (message) => said.push(message)
  );
  const unpinned: Array<{ name: string; key: string }> = [];
  const said: string[] = [];
  const waiting: Array<() => void> = [];
  const wake = (): void => {
    for (const each of waiting.splice(0)) each();
  };
  const link = new PeerLink({
    server: () => server,
    limits: () => ({
      retryLeastMs: 50,
      retryMostMs: 200,
      pingEveryMs: 60_000,
      freshEveryMs: 60_000
    }),
    tokens: {
      read: () => Promise.resolve(token),
      write: (next) => {
        token = next;
        return Promise.resolve();
      },
      forget: () => {
        token = null;
        return Promise.resolve();
      }
    },
    register: (at) =>
      registerWithGateway(at, {
        buildSecret: SECRET,
        solve: (challenge, bits) => Promise.resolve(solveProofOfWork(challenge, bits)),
        requestMs: 5000,
        mostBits: 8,
        fetch
      }),
    dial: (url) =>
      connectWebSocket(url, {
        timeoutMs: 5000,
        maxMessageBytes: 65_536,
        maxBufferedBytes: 1_048_576,
        deflateMinBytes: 512
      }),
    sign: signEd25519,
    random: (bytes) => randomBytes(bytes).toString('hex'),
    now: Date.now,
    heard: (frame) => {
      book.heard(frame);
      wake();
    },
    linked: wake,
    lost: () => {
      book.clear();
      wake();
    },
    unpinned: (_peer, name, key) => {
      unpinned.push({ name, key });
      wake();
    },
    controlled: (frame) => {
      hooks.controlled?.(frame);
      wake();
    },
    controlling: (frame) => {
      hooks.controlling?.(frame);
      wake();
    },
    say: (message) => {
      said.push(message);
      wake();
    }
  });
  links.push(link);
  return {
    link,
    book,
    unpinned,
    said,
    changed: () => new Promise<void>((resolve) => waiting.push(resolve)),
    wake
  };
}

export async function until(check: () => boolean, changed: () => Promise<void>): Promise<void> {
  while (!check()) await changed();
}

export const state = (hp: number): CharacterState => ({
  ...EMPTY_CHARACTER,
  phase: 'in-game',
  name: 'Brakkle',
  className: 'Priest',
  vitals: { ...EMPTY_CHARACTER.vitals, hp, hpMax: 80 }
});
