import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import { ArtClient } from '../ArtClient';
import type { ArtToken, ArtTokens } from '../artToken';
import { leadingZeroBits, solveProofOfWork } from '../proofOfWork';
import type { PortraitFacts } from '../../../shared/portrait';
import type { RoomArtRequest } from '../../../shared/roomArt';

const BUILD = 'build-secret-for-tests';
const SERVER = 'https://art.example';
const BITS = 4;
const PICTURE = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);

const FACTS: PortraitFacts = {
  race: 'Gnome',
  class: 'Priest',
  hair: 'no',
  eyes: 'black',
  gender: 'male',
  health: 'stout',
  strength: 'well built',
  agility: 'cautiously',
  charm: 'hostile and rather unappealing',
  intellect: 'intelligent',
  willpower: 'has a worldly air',
  stats: { health: 60, strength: 62, agility: 55, charm: 34, intellect: 51, willpower: 74 },
  gear: [{ slot: 'Weapon Hand', item: 'quarterstaff' }]
};

const ROOM: RoomArtRequest = {
  realm: 'greatermud',
  map: 1,
  room: 1710,
  name: 'Darkwood Forest',
  description: 'Tall trees crowd in on every side.'
};

/**
 * The art gateway as `server.py` answers: a challenge, a registration that
 * checks the build's signature and the work, and a portrait or a room that
 * checks the request's signature and answers 202 until the drawing is done.
 */
class FakeGateway {
  readonly tokens = new Map<string, string>();
  readonly seen: string[] = [];
  /** 202s before the picture. */
  pending = 1;
  /** Answer the next portrait with this status and reason instead. */
  refuse: { status: number; error: string } | null = null;
  /** Answer the next registration with this status and reason instead. */
  refuseRegister: { status: number; error: string } | null = null;
  private issued = 0;

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = String(url).slice(SERVER.length);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array();
    this.seen.push(`${method} ${path}`);
    const json = (status: number, value: unknown): Response =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' }
      });
    if (path === '/v1/challenge') return json(200, { challenge: 'ab'.repeat(16), bits: BITS });
    if (path === '/v1/register') {
      if (this.refuseRegister !== null)
        return json(this.refuseRegister.status, { error: this.refuseRegister.error });
      const { challenge, nonce } = JSON.parse(new TextDecoder().decode(body));
      const build = createHmac('sha256', BUILD).update(challenge).digest('hex');
      if (headers.get('X-Art-Build') !== build)
        return json(401, { error: 'not a mudengine build' });
      const work = createHash('sha256').update(`${challenge}:${nonce}`).digest();
      if (leadingZeroBits(work) < BITS)
        return json(400, { error: 'proof of work does not check out' });
      this.issued += 1;
      const token = String(this.issued).padStart(24, '0');
      this.tokens.set(token, `secret-${this.issued}-0123456789`);
      return json(200, { token, secret: this.tokens.get(token) });
    }
    const secret = this.tokens.get(headers.get('X-Art-Token') ?? '');
    if (secret === undefined) return json(401, { error: 'unknown token; register again' });
    const digest = createHash('sha256').update(body).digest('hex');
    const message = `${method}\n${path}\n${headers.get('X-Art-Time')}\n${headers.get('X-Art-Nonce')}\n${digest}`;
    if (
      createHmac('sha256', secret).update(message).digest('hex') !== headers.get('X-Art-Signature')
    ) {
      return json(401, { error: 'bad signature' });
    }
    if (this.refuse !== null) return json(this.refuse.status, { error: this.refuse.error });
    if (this.pending > 0) {
      this.pending -= 1;
      return json(202, { job: 'f'.repeat(24), state: 'queued', retry_after: 5 });
    }
    return new Response(PICTURE, { status: 200, headers: { 'Content-Type': 'image/webp' } });
  };
}

function memoryTokens(): ArtTokens & { held: ArtToken | null } {
  return {
    held: null,
    async read() {
      return this.held;
    },
    async write(token) {
      this.held = token;
    },
    async forget() {
      this.held = null;
    }
  };
}

describe('the art server client', () => {
  let gateway: FakeGateway;
  let tokens: ReturnType<typeof memoryTokens>;
  let waited: number[];

  const client = (buildSecret: string | null = BUILD) =>
    new ArtClient({
      server: () => SERVER,
      buildSecret,
      tokens,
      solve: async (challenge, bits) => solveProofOfWork(challenge, bits),
      limits: () => ({
        requestMs: 1000,
        drawMs: 60_000,
        mostBits: 28,
        pollMs: 5000,
        pollMostMs: 60_000,
        pollLeastMs: 1000
      }),
      fetch: gateway.fetch as typeof fetch,
      wait: async (ms) => {
        waited.push(ms);
      }
    });

  beforeEach(() => {
    gateway = new FakeGateway();
    tokens = memoryTokens();
    waited = [];
  });

  it('registers once, signs the ask, waits out a 202 and keeps the picture', async () => {
    const result = await client().portraitOf(FACTS, () => false);
    expect(result).toEqual({ kind: 'picture', bytes: PICTURE, type: 'image/webp' });
    expect(gateway.seen).toEqual([
      'GET /v1/challenge',
      'POST /v1/register',
      'POST /v1/portrait',
      `GET /v1/portrait/${'f'.repeat(24)}`
    ]);
    expect(waited).toEqual([5000]);
    // The token is kept: the next portrait registers nothing.
    gateway.seen.length = 0;
    await client().portraitOf(FACTS, () => false);
    expect(gateway.seen).toEqual(['POST /v1/portrait']);
  });

  it('registers again, once, when the server no longer knows the token', async () => {
    tokens.held = { token: '9'.repeat(24), secret: 'forgotten-secret-0123' };
    const result = await client().portraitOf(FACTS, () => false);
    expect(result.kind).toBe('picture');
    expect(gateway.seen.filter((seen) => seen === 'POST /v1/register')).toHaveLength(1);
  });

  it('says the server’s reason for a refusal', async () => {
    gateway.refuse = { status: 400, error: 'race: not a value the game offers' };
    expect(await client().portraitOf(FACTS, () => false)).toEqual({
      kind: 'refused',
      reason: 'race: not a value the game offers'
    });
  });

  it('asks again later past a limit or a full queue, rather than giving up', async () => {
    gateway.refuse = { status: 429, error: 'new portrait limit reached; try again later' };
    expect(await client().portraitOf(FACTS, () => false)).toEqual({
      kind: 'unreachable',
      reason: 'new portrait limit reached; try again later'
    });
    gateway.refuse = { status: 503, error: 'the portrait queue is full; try again shortly' };
    expect((await client().portraitOf(FACTS, () => false)).kind).toBe('unreachable');
  });

  it('asks again later when registering meets the address limit', async () => {
    gateway.refuseRegister = {
      status: 429,
      error: 'too many registrations from this address today'
    };
    expect(await client().portraitOf(FACTS, () => false)).toEqual({
      kind: 'unreachable',
      reason: 'registering: too many registrations from this address today'
    });
    expect(tokens.held).toBeNull();
  });

  it('sends nothing without a build secret', async () => {
    expect(await client(null).portraitOf(FACTS, () => false)).toEqual({ kind: 'unavailable' });
    expect(gateway.seen).toEqual([]);
  });

  it('is refused registering with the wrong build secret', async () => {
    const result = await client('a guess').portraitOf(FACTS, () => false);
    expect(result).toEqual({ kind: 'refused', reason: 'registering: not a mudengine build' });
    expect(tokens.held).toBeNull();
  });

  it('asks for a room at its own path, polled there, and takes the server’s refusal of it', async () => {
    gateway.pending = 1;
    const result = await client().roomArtOf(ROOM, () => false);
    expect(result).toEqual({ kind: 'picture', bytes: PICTURE, type: 'image/webp' });
    expect(gateway.seen.slice(-2)).toEqual(['POST /v1/room', `GET /v1/room/${'f'.repeat(24)}`]);
    gateway.refuse = { status: 409, error: 'the build has this picture' };
    expect(await client().roomArtOf(ROOM, () => false)).toEqual({
      kind: 'refused',
      reason: 'the build has this picture'
    });
  });

  it('calls a server that does not answer unreachable', async () => {
    gateway.fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const result = await client().portraitOf(FACTS, () => false);
    expect(result.kind).toBe('unreachable');
  });
});

describe('the proof of work', () => {
  it('finds a nonce with the zero bits asked for', () => {
    const nonce = solveProofOfWork('cafe'.repeat(8), 8);
    const digest = createHash('sha256')
      .update(`${'cafe'.repeat(8)}:${nonce}`)
      .digest();
    expect(leadingZeroBits(digest)).toBeGreaterThanOrEqual(8);
  });

  it('counts the zero bits the way the server does', () => {
    expect(leadingZeroBits(new Uint8Array([0, 0x0f, 0xff]))).toBe(12);
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
  });
});
