import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import { createGateway, type Gateway } from '../../../gateway/server';
import { GATEWAY_LIMITS } from '../../../gateway/limits';
import { newEd25519Pair, signEd25519, verifyEd25519 } from '../../../node/ed25519';
import { solveProofOfWork } from '../../../node/proofOfWork';
import { connectWebSocket } from '../../../node/sockets';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { PeerKey, PeerSheet } from '../../../shared/peers';
import type { PeerToken, ShareEntry } from '../../../shared/peerWire';
import { PeerBook } from '../PeerBook';
import { PeerLink, type Claimant } from '../PeerLink';
import { registerWithGateway } from '../peerRegistration';
import { peerSheetOf } from '../peerSheet';

/**
 * Two installs' links against the gateway in process, on a real port: one
 * plays Brakkle and shares him with Soul, the other plays Soul. Every step
 * goes over the WebSocket client this build dials with.
 */
const SECRET = 'build-secret-for-the-test';
const REALM = 'orohost:2427/GreaterMUD';
const brakkle: PeerKey = { realm: REALM, name: 'Brakkle' };
const soul: PeerKey = { realm: REALM, name: 'Soul' };

let gateway: Gateway;
let server: string;
const links: PeerLink[] = [];

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

/** One install: its link, the book it fills, and what it was told. */
function install(): {
  link: PeerLink;
  book: PeerBook;
  unpinned: Array<{ name: string; key: string }>;
  said: string[];
  changed: () => Promise<void>;
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
    changed: () => new Promise<void>((resolve) => waiting.push(resolve))
  };
}

async function until(check: () => boolean, changed: () => Promise<void>): Promise<void> {
  while (!check()) await changed();
}

const state = (hp: number): CharacterState => ({
  ...EMPTY_CHARACTER,
  phase: 'in-game',
  name: 'Brakkle',
  className: 'Priest',
  vitals: { ...EMPTY_CHARACTER.vitals, hp, hpMax: 80 }
});

describe('a share between two installs', () => {
  it('reports the receiver to the sharer unpinned, then streams to it once pinned', async () => {
    const sharer = install();
    const receiver = install();
    const brakklePair = newEd25519Pair();
    const soulPair = newEd25519Pair();
    const share = (keys: string[]): Claimant => ({
      peer: brakkle,
      pair: brakklePair,
      shares: [{ name: 'Soul', share: 'state', keys } satisfies ShareEntry]
    });
    sharer.link.want([share([])]);
    sharer.link.observe(brakkle, peerSheetOf(state(70)));
    receiver.link.want([{ peer: soul, pair: soulPair, shares: [] }]);

    // Unpinned: the sharer is told of Soul's claim, and Soul is sent nothing.
    await until(() => sharer.unpinned.length > 0, sharer.changed);
    expect(sharer.unpinned).toEqual([{ name: 'Soul', key: soulPair.publicKey }]);
    const accepts = (): { receive: boolean; keys: string[] } => ({
      receive: true,
      keys: [brakklePair.publicKey]
    });
    expect(receiver.book.sheetsFor(soul, accepts)).toEqual([]);

    // The control: the same share, Soul's key pinned, reaches Soul whole and then as changes.
    sharer.link.want([share([soulPair.publicKey])]);
    await until(() => receiver.book.sheetsFor(soul, accepts).length > 0, receiver.changed);
    expect(receiver.book.sheetsFor(soul, accepts)[0]!.sheet.vitals?.hp).toBe(70);
    sharer.link.observe(brakkle, peerSheetOf(state(31)));
    await until(
      () => receiver.book.sheetsFor(soul, accepts)[0]?.sheet.vitals?.hp === 31,
      receiver.changed
    );
    const sheet: PeerSheet = receiver.book.sheetsFor(soul, accepts)[0]!.sheet;
    expect(sheet).toEqual(peerSheetOf(state(31)));
    expect(sharer.said).toEqual([]);
  });

  it('shows a receiver only what its player accepted, under a key the player pinned', async () => {
    const sharer = install();
    const receiver = install();
    const brakklePair = newEd25519Pair();
    const soulPair = newEd25519Pair();
    sharer.link.want([
      {
        peer: brakkle,
        pair: brakklePair,
        shares: [{ name: 'Soul', share: 'state', keys: [soulPair.publicKey] }]
      }
    ]);
    sharer.link.observe(brakkle, peerSheetOf(state(70)));
    receiver.link.want([{ peer: soul, pair: soulPair, shares: [] }]);
    const pinned = (): { receive: boolean; keys: string[] } => ({
      receive: true,
      keys: [brakklePair.publicKey]
    });
    await until(() => receiver.book.sheetsFor(soul, pinned).length > 0, receiver.changed);

    // Not accepted: nothing shown, and no offer either.
    const refused = (): { receive: boolean; keys: string[] } => ({ receive: false, keys: [] });
    expect(receiver.book.sheetsFor(soul, refused)).toEqual([]);
    expect(receiver.book.offersFor(soul, refused)).toEqual([]);
    // Accepted by name, the key not pinned: an offer to pin, and no sheet.
    const unpinned = (): { receive: boolean; keys: string[] } => ({ receive: true, keys: [] });
    expect(receiver.book.sheetsFor(soul, unpinned)).toEqual([]);
    expect(receiver.book.offersFor(soul, unpinned)).toEqual([
      { name: 'Brakkle', key: brakklePair.publicKey }
    ]);
  });

  it('takes every sheet away when the sharer leaves', async () => {
    const sharer = install();
    const receiver = install();
    const brakklePair = newEd25519Pair();
    const soulPair = newEd25519Pair();
    sharer.link.want([
      {
        peer: brakkle,
        pair: brakklePair,
        shares: [{ name: 'Soul', share: 'state', keys: [soulPair.publicKey] }]
      }
    ]);
    sharer.link.observe(brakkle, peerSheetOf(state(70)));
    receiver.link.want([{ peer: soul, pair: soulPair, shares: [] }]);
    const accepts = (): { receive: boolean; keys: string[] } => ({
      receive: true,
      keys: [brakklePair.publicKey]
    });
    await until(() => receiver.book.sheetsFor(soul, accepts).length > 0, receiver.changed);
    expect(sharer.link.link).toBe('connected');

    // Nothing shared: the sharer's socket closes, and the receiver hears it gone.
    sharer.link.want([]);
    expect(sharer.link.link).toBe('off');
    await until(() => receiver.book.sheetsFor(soul, accepts).length === 0, receiver.changed);
  });
});
