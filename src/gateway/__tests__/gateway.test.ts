import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifyEd25519 } from '../../node/ed25519';
import { solveProofOfWork } from '../../node/proofOfWork';
import type { PeerKey } from '../../shared/peers';
import {
  asPeerDown,
  asPeerToken,
  claimText,
  helloText,
  PEER_BUILD_HEADER,
  PEER_PATHS,
  type PeerDown,
  type PeerToken,
  type PeerUp
} from '../../shared/peerWire';
import { ClaimBook } from '../ClaimBook';
import { GATEWAY_LIMITS, type GatewayLimits } from '../limits';
import { createGateway, type Gateway } from '../server';

/**
 * The gateway in process, on a real port, driven by Node's own `fetch` and
 * `WebSocket` playing two installs: one shares Brakkle with Soul, the other
 * plays Soul.
 */
const SECRET = 'build-secret-for-the-test';
const REALM = 'orohost:2427/GreaterMUD';
const brakkle: PeerKey = { realm: REALM, name: 'Brakkle' };
const soul: PeerKey = { realm: REALM, name: 'Soul' };
const LIMITS: GatewayLimits = { ...GATEWAY_LIMITS, powBits: 4, pingEveryMs: 60_000 };

let dir: string;
let gateway: Gateway;
let base: string;
let limits: GatewayLimits;
const sockets: WebSocket[] = [];
/** Every claim book opened, settled before its folder is removed. */
const books: ClaimBook[] = [];

async function start(with_: Partial<GatewayLimits> = {}): Promise<void> {
  limits = { ...LIMITS, ...with_ };
  const claims = await ClaimBook.open(path.join(dir, 'claims.json'), {
    idleMs: limits.claimIdleMs,
    mostPins: limits.mostPins,
    now: Date.now,
    log: () => {}
  });
  books.push(claims);
  gateway = createGateway({
    buildSecret: SECRET,
    claims,
    verify: verifyEd25519,
    limits,
    now: Date.now,
    random: (bytes) => randomBytes(bytes).toString('hex'),
    log: () => {}
  });
  const port = await gateway.listen(0, '127.0.0.1');
  base = `127.0.0.1:${port}`;
}

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gateway-'));
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await gateway.close();
  for (const book of books.splice(0)) await book.settle();
  await fs.promises.rm(dir, { recursive: true, force: true });
});

async function register(secret = SECRET): Promise<Response> {
  const asked = (await (await fetch(`http://${base}${PEER_PATHS.challenge}`)).json()) as {
    challenge: string;
    bits: number;
  };
  const nonce = solveProofOfWork(asked.challenge, asked.bits);
  return fetch(`http://${base}${PEER_PATHS.register}`, {
    method: 'POST',
    headers: {
      [PEER_BUILD_HEADER]: createHmac('sha256', secret).update(asked.challenge).digest('hex')
    },
    body: JSON.stringify({ challenge: asked.challenge, nonce })
  });
}

/** One install's socket, with every frame it hears kept and waited on by kind. */
class Install {
  readonly heard: PeerDown[] = [];
  closed: number | null = null;
  private readonly waiting: Array<() => void> = [];

  private constructor(readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const frame = asPeerDown(JSON.parse(String(event.data)));
      if (frame === null)
        throw new Error(`the gateway sent a frame that does not read: ${String(event.data)}`);
      this.heard.push(frame);
      for (const wake of this.waiting.splice(0)) wake();
    });
    socket.addEventListener('close', (event) => {
      this.closed = event.code;
      for (const wake of this.waiting.splice(0)) wake();
    });
  }

  static async open(): Promise<Install> {
    const socket = new WebSocket(`ws://${base}${PEER_PATHS.stream}`);
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new Install(socket);
  }

  send(frame: PeerUp | Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** The first frame heard since `from` that matches, waiting for it. */
  async until(match: (frame: PeerDown) => boolean, from = 0): Promise<PeerDown> {
    for (;;) {
      const found = this.heard.slice(from).find(match);
      if (found !== undefined) return found;
      if (this.closed !== null) throw new Error(`closed (${this.closed}) before the frame`);
      await new Promise<void>((wake) => this.waiting.push(wake));
    }
  }

  async next<K extends PeerDown['k']>(k: K, from = 0): Promise<Extract<PeerDown, { k: K }>> {
    return (await this.until((frame) => frame.k === k, from)) as Extract<PeerDown, { k: K }>;
  }

  async whenClosed(): Promise<number> {
    while (this.closed === null) await new Promise<void>((wake) => this.waiting.push(wake));
    return this.closed;
  }

  hello(token: PeerToken, nonce = randomBytes(16).toString('hex')): void {
    const time = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', token.secret).update(helloText(time, nonce)).digest('hex');
    this.send({ k: 'hello', token: token.token, time, nonce, sig });
  }

  /** Claim `peer` with `keys`, answering the challenge, and say how the claim ended. */
  async claim(peer: PeerKey, keys: Keys): Promise<PeerDown> {
    const from = this.heard.length;
    this.send({ k: 'claim', peer, key: keys.public });
    const { nonce } = await this.next('challenge', from);
    const sig = sign(null, Buffer.from(claimText(peer, nonce)), keys.private).toString('base64url');
    this.send({ k: 'answer', peer, sig });
    return this.until((frame) => frame.k === 'claimed' || frame.k === 'unclaimed', from);
  }
}

interface Keys {
  public: string;
  private: KeyObject;
}

function keys(): Keys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return { public: String(jwk.x), private: privateKey };
}

async function installWith(): Promise<Install> {
  const token = asPeerToken(await (await register()).json());
  if (token === null) throw new Error('registration gave no token');
  const install = await Install.open();
  install.hello(token);
  await install.next('welcome');
  return install;
}

describe('registering', () => {
  beforeEach(() => start());

  it('gives a token for the work and the build signature', async () => {
    const answer = await register();
    expect(answer.status).toBe(200);
    expect(asPeerToken(await answer.json())).not.toBeNull();
  });

  it('refuses a build that does not hold the secret', async () => {
    const answer = await register('somebody else');
    expect(answer.status).toBe(403);
    expect(await answer.json()).toEqual({ error: 'not a mudengine build' });
  });

  it('refuses a challenge answered twice', async () => {
    const asked = (await (await fetch(`http://${base}${PEER_PATHS.challenge}`)).json()) as {
      challenge: string;
      bits: number;
    };
    const body = JSON.stringify({
      challenge: asked.challenge,
      nonce: solveProofOfWork(asked.challenge, asked.bits)
    });
    const headers = {
      [PEER_BUILD_HEADER]: createHmac('sha256', SECRET).update(asked.challenge).digest('hex')
    };
    const url = `http://${base}${PEER_PATHS.register}`;
    expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(200);
    const again = await fetch(url, { method: 'POST', headers, body });
    expect(await again.json()).toEqual({ error: 'unknown challenge' });
  });
});

describe('the socket', () => {
  beforeEach(() => start());

  it('refuses a hello under a token it never gave, and closes', async () => {
    const install = await Install.open();
    install.hello({ token: 'a'.repeat(24), secret: 'b'.repeat(64) });
    expect(await install.next('refused')).toEqual({ k: 'refused', why: 'unknown-token' });
    expect(await install.whenClosed()).toBe(1008);
  });

  it('refuses a hello sent twice', async () => {
    const token = asPeerToken(await (await register()).json())!;
    const first = await Install.open();
    first.hello(token, 'c'.repeat(32));
    await first.next('welcome');
    const replay = await Install.open();
    replay.hello(token, 'c'.repeat(32));
    expect(await replay.next('refused')).toEqual({ k: 'refused', why: 'signature' });
  });

  it('refuses anything before the hello', async () => {
    const install = await Install.open();
    install.send({ k: 'leave', peer: brakkle });
    expect(await install.next('refused')).toEqual({ k: 'refused', why: 'malformed' });
  });

  it('streams a sheet from the sharer to the install it shares with, whole then patches', async () => {
    const sharer = await installWith();
    const receiver = await installWith();
    const brakkleKeys = keys();
    expect(await sharer.claim(brakkle, brakkleKeys)).toEqual({ k: 'claimed', peer: brakkle });
    sharer.send({ k: 'shares', peer: brakkle, to: [{ name: 'Soul', share: 'state', key: null }] });
    expect(await sharer.next('audience')).toEqual({ k: 'audience', peer: brakkle, to: [] });

    const soulKeys = keys();
    expect(await receiver.claim(soul, soulKeys)).toEqual({ k: 'claimed', peer: soul });
    const told = sharer.heard.length;
    const heard = await sharer.next('audience', told);
    expect(heard.to).toEqual([{ name: 'Soul', key: soulKeys.public }]);
    expect(await receiver.next('shared')).toEqual({
      k: 'shared',
      from: brakkle,
      key: brakkleKeys.public,
      to: ['Soul']
    });

    sharer.send({ k: 'sheet', peer: brakkle, sheet: { v: 1, level: 12 } });
    expect(await receiver.next('sheet')).toEqual({
      k: 'sheet',
      from: brakkle,
      sheet: { v: 1, level: 12 }
    });
    sharer.send({ k: 'patch', peer: brakkle, set: { level: 13 }, deep: {}, drop: [] });
    expect(await receiver.next('patch')).toMatchObject({ from: brakkle, set: { level: 13 } });

    sharer.socket.close();
    expect(await receiver.next('gone')).toEqual({ k: 'gone', from: brakkle, why: 'left' });
  });

  it('refuses a claim whose answer was signed by another key', async () => {
    const install = await installWith();
    const mine = keys();
    install.send({ k: 'claim', peer: brakkle, key: mine.public });
    const { nonce } = await install.next('challenge');
    const sig = sign(null, Buffer.from(claimText(brakkle, nonce)), keys().private);
    install.send({ k: 'answer', peer: brakkle, sig: sig.toString('base64url') });
    expect(await install.next('unclaimed')).toEqual({
      k: 'unclaimed',
      peer: brakkle,
      why: 'answer'
    });
    // The same claim answered with its own key is taken.
    expect(await install.claim(brakkle, mine)).toEqual({ k: 'claimed', peer: brakkle });
  });

  it('refuses a name another key holds, from another install', async () => {
    const owner = await installWith();
    const first = keys();
    await owner.claim(brakkle, first);
    const other = await installWith();
    expect(await other.claim(brakkle, keys())).toEqual({
      k: 'unclaimed',
      peer: brakkle,
      why: 'held'
    });
    // The key that holds it may claim it again, from anywhere.
    expect(await other.claim(brakkle, first)).toEqual({ k: 'claimed', peer: brakkle });
  });

  it('refuses a claim past the most one install may hold', async () => {
    await gateway.close();
    await start({ mostClaims: 1 });
    const install = await installWith();
    await install.claim(brakkle, keys());
    // Refused before any challenge is sent for it.
    install.send({ k: 'claim', peer: soul, key: keys().public });
    expect(await install.next('unclaimed')).toEqual({
      k: 'unclaimed',
      peer: soul,
      why: 'too-many'
    });
    expect(install.heard.filter((frame) => frame.k === 'challenge')).toHaveLength(1);
  });

  it('closes an install that sends past its byte budget', async () => {
    await gateway.close();
    await start({ burstBytes: 2000, bytesPerSecond: 1 });
    const install = await installWith();
    const filler = { k: 'leave', peer: { realm: 'x'.repeat(180), name: 'Brakkle' } };
    // Under the budget, the frame is answered (not claimed): the control.
    install.send(filler);
    expect(await install.next('refused')).toEqual({ k: 'refused', why: 'not-claimed' });
    for (let i = 0; i < 20; i += 1) install.send(filler);
    expect(await install.whenClosed()).toBe(1008);
    expect(install.heard).toContainEqual({ k: 'refused', why: 'over-limit' });
  });

  it('closes the earlier socket of an install that says hello again', async () => {
    const token = asPeerToken(await (await register()).json())!;
    const first = await Install.open();
    first.hello(token);
    await first.next('welcome');
    const second = await Install.open();
    second.hello(token);
    await second.next('welcome');
    expect(await first.next('refused')).toEqual({ k: 'refused', why: 'replaced' });
    expect(await first.whenClosed()).toBe(1008);
  });
});
