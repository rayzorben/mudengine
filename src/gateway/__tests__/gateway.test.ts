import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

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

let gateway: Gateway;
let base: string;
let limits: GatewayLimits;
const sockets: WebSocket[] = [];

async function start(with_: Partial<GatewayLimits> = {}): Promise<void> {
  limits = { ...LIMITS, ...with_ };
  gateway = createGateway({
    buildSecret: SECRET,
    verify: verifyEd25519,
    limits,
    now: Date.now,
    random: (bytes) => randomBytes(bytes).toString('hex'),
    log: () => {}
  });
  const port = await gateway.listen(0, '127.0.0.1');
  base = `127.0.0.1:${port}`;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await gateway.close();
});

/** As Caddy says where a request came from. */
const from = (address: string): Record<string, string> => ({ 'X-Forwarded-For': address });

async function challengeFor(headers: Record<string, string> = {}): Promise<{
  challenge: string;
  bits: number;
}> {
  return (await (await fetch(`http://${base}${PEER_PATHS.challenge}`, { headers })).json()) as {
    challenge: string;
    bits: number;
  };
}

async function answer(
  asked: { challenge: string; bits: number },
  secret = SECRET,
  headers: Record<string, string> = {}
): Promise<Response> {
  const nonce = solveProofOfWork(asked.challenge, asked.bits);
  return fetch(`http://${base}${PEER_PATHS.register}`, {
    method: 'POST',
    headers: {
      ...headers,
      [PEER_BUILD_HEADER]: createHmac('sha256', secret).update(asked.challenge).digest('hex')
    },
    body: JSON.stringify({ challenge: asked.challenge, nonce })
  });
}

async function register(secret = SECRET, headers: Record<string, string> = {}): Promise<Response> {
  return answer(await challengeFor(headers), secret, headers);
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

describe('asking too fast from one address', () => {
  const flooder = from('203.0.113.9');

  /** Ask for challenges from `headers` until one is refused, and say how many were given. */
  async function floodUntilRefused(headers: Record<string, string>): Promise<number> {
    for (let given = 0; given < 100; given += 1) {
      const answer = await fetch(`http://${base}${PEER_PATHS.challenge}`, { headers });
      if (answer.status === 429) {
        expect(Number(answer.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(await answer.json()).toEqual({ error: 'too many requests' });
        return given;
      }
      expect(answer.status).toBe(200);
    }
    throw new Error('never refused');
  }

  it('is refused past the burst, and a client elsewhere still registers', async () => {
    await start({ askBurst: 4, mostChallenges: 6 });
    // A real client asks for its challenge before the flood begins.
    const asked = await challengeFor(from('198.51.100.7'));
    expect(await floodUntilRefused(flooder)).toBe(4);
    // Its challenge was not pushed out, and it registers.
    const answered = await answer(asked, SECRET, from('198.51.100.7'));
    expect(answered.status).toBe(200);
    expect(asPeerToken(await answered.json())).not.toBeNull();
    // And the flooder may not register either.
    const refused = await fetch(`http://${base}${PEER_PATHS.register}`, {
      method: 'POST',
      headers: flooder,
      body: '{}'
    });
    expect(refused.status).toBe(429);
  });

  it('counts registrations with the challenges', async () => {
    await start({ askBurst: 3 });
    expect((await register(SECRET, flooder)).status).toBe(200);
    // The challenge and the registration spent two; one left.
    expect(await floodUntilRefused(flooder)).toBe(1);
  });

  it('counts an IPv6 caller by its /64', async () => {
    await start({ askBurst: 2 });
    await challengeFor(from('2001:db8:1:2::1'));
    await challengeFor(from('2001:db8:1:2:ffff::9'));
    expect(await floodUntilRefused(from('2001:db8:1:2:abcd::5'))).toBe(0);
    // Another /64 is another caller.
    expect(await floodUntilRefused(from('2001:db8:1:3::1'))).toBe(2);
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

  it('says a frame of a kind another build added is not read, and keeps the socket', async () => {
    const install = await installWith();
    install.send({ k: 'dance', peer: brakkle });
    expect(await install.next('refused')).toEqual({ k: 'refused', why: 'unknown-frame' });
    // The socket stays: a claim on it is still answered.
    expect(await install.claim(brakkle, keys())).toEqual({ k: 'claimed', peer: brakkle });
    expect(install.closed).toBeNull();
  });

  it('streams a sheet from the sharer to the install it shares with, whole then patches', async () => {
    const sharer = await installWith();
    const receiver = await installWith();
    const brakkleKeys = keys();
    const soulKeys = keys();
    expect(await sharer.claim(brakkle, brakkleKeys)).toEqual({ k: 'claimed', peer: brakkle });
    sharer.send({
      k: 'shares',
      peer: brakkle,
      to: [{ name: 'Soul', share: 'state', keys: [soulKeys.public] }]
    });
    expect(await sharer.next('audience')).toEqual({ k: 'audience', peer: brakkle, to: [] });

    expect(await receiver.claim(soul, soulKeys)).toEqual({ k: 'claimed', peer: soul });
    const told = sharer.heard.length;
    const heard = await sharer.next('audience', told);
    expect(heard.to).toEqual([{ name: 'Soul', key: soulKeys.public }]);
    expect(await receiver.next('shared')).toEqual({
      k: 'shared',
      from: brakkle,
      key: brakkleKeys.public,
      to: ['Soul'],
      control: []
    });

    sharer.send({ k: 'sheet', peer: brakkle, sheet: { v: 1, level: 12 } });
    expect(await receiver.next('sheet')).toEqual({
      k: 'sheet',
      from: brakkle,
      key: brakkleKeys.public,
      sheet: { v: 1, level: 12 }
    });
    sharer.send({ k: 'patch', peer: brakkle, set: { level: 13 }, deep: {}, drop: [] });
    expect(await receiver.next('patch')).toMatchObject({ from: brakkle, set: { level: 13 } });

    sharer.socket.close();
    expect(await receiver.next('gone')).toEqual({
      k: 'gone',
      from: brakkle,
      key: brakkleKeys.public,
      why: 'left'
    });
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

  it('lets two installs claim one name under two keys', async () => {
    const desktop = await installWith();
    const hosted = await installWith();
    expect(await desktop.claim(brakkle, keys())).toEqual({ k: 'claimed', peer: brakkle });
    expect(await hosted.claim(brakkle, keys())).toEqual({ k: 'claimed', peer: brakkle });
    // And both stay claimed: each may still list its shares.
    hosted.send({ k: 'shares', peer: brakkle, to: [] });
    desktop.send({ k: 'shares', peer: brakkle, to: [] });
    expect(await hosted.next('audience')).toEqual({ k: 'audience', peer: brakkle, to: [] });
    expect(await desktop.next('audience')).toEqual({ k: 'audience', peer: brakkle, to: [] });
  });

  it('sends a share pinned to one key nothing under another, and tells the sharer', async () => {
    const sharer = await installWith();
    const stranger = await installWith();
    const owner = await installWith();
    const soulKeys = keys();
    const otherKeys = keys();
    await sharer.claim(brakkle, keys());
    await stranger.claim(soul, otherKeys);
    sharer.send({
      k: 'shares',
      peer: brakkle,
      to: [{ name: 'Soul', share: 'state', keys: [soulKeys.public] }]
    });
    expect(await sharer.next('unpinned')).toEqual({
      k: 'unpinned',
      peer: brakkle,
      name: 'Soul',
      key: otherKeys.public
    });
    // The key the share was pinned to is sent it: the control, after which the stranger still has nothing.
    await owner.claim(soul, soulKeys);
    expect(await owner.next('shared')).toMatchObject({ from: brakkle, to: ['Soul'] });
    expect(stranger.heard.some((frame) => frame.k === 'shared')).toBe(false);
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

  it('closes a socket that says no hello in time', async () => {
    await gateway.close();
    await start({ helloMs: 50 });
    const install = await Install.open();
    expect(await install.whenClosed()).toBe(1008);
    // A socket that says hello in time stays: the control.
    const greeted = await installWith();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(greeted.closed).toBeNull();
  });

  it('refuses a socket past the most one address may hold', async () => {
    await gateway.close();
    await start({ mostSocketsPerAddress: 2 });
    await Install.open();
    await Install.open();
    await expect(Install.open()).rejects.toBeDefined();
    // One closed makes room again.
    sockets[0]!.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(Install.open()).resolves.toBeInstanceOf(Install);
  });

  it('keeps the byte budget of an install across its sockets', async () => {
    await gateway.close();
    await start({ burstBytes: 3000, bytesPerSecond: 1 });
    const token = asPeerToken(await (await register()).json())!;
    const filler = { k: 'leave', peer: { realm: 'x'.repeat(180), name: 'Brakkle' } };
    const first = await Install.open();
    first.hello(token);
    await first.next('welcome');
    for (let i = 0; i < 10; i += 1) first.send(filler);
    const refused = (install: Install): number =>
      install.heard.filter((frame) => frame.k === 'refused').length;
    // All ten answered, so the budget they spent is counted before the second socket opens.
    await first.until(() => refused(first) >= 10);
    expect(first.closed).toBeNull();
    const second = await Install.open();
    second.hello(token);
    await second.next('welcome');
    for (let i = 0; i < 10; i += 1) second.send(filler);
    // A fresh socket would have had 3000 bytes again; this one has what the first left.
    expect(await second.whenClosed()).toBe(1008);
    expect(second.heard).toContainEqual({ k: 'refused', why: 'over-limit' });
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
