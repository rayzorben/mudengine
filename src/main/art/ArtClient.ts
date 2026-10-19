/**
 * The art server's client (todo 20261019-0931-01), as its README sets out:
 * register once with a proof of work and the build's signature, keep the token
 * and secret, sign every request, ask for a portrait by its facts and poll a
 * job the server is still drawing. Every answer is parsed here into a picture
 * or a typed refusal carrying the server's own reason.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

import type { PortraitFacts, PortraitResult, PortraitSource } from '../../shared/portrait';
import { errorMessage, isRecord } from '../../shared/values';
import { asArtToken, type ArtToken, type ArtTokens } from './artToken';

const JOB_ID = /^[0-9a-f]{24}$/;
/** The server's word for a token it no longer has (`server.py` `verify_client`). */
const UNKNOWN_TOKEN = 'unknown token';

export interface ArtClientDeps {
  /** The server's address, read through: the setting is hot-reloaded. */
  server(): string;
  /** The build's registration secret, or null for a build made without one. */
  buildSecret: string | null;
  tokens: ArtTokens;
  /** The proof of work, off the main thread (`solveOnWorker`). */
  solve(challenge: string, bits: number): Promise<string>;
  /** `tuning.art`'s deadlines, the most work a registration is done for, and the poll's waits. */
  limits(): ArtLimits;
  fetch?: typeof fetch;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

export interface ArtLimits {
  requestMs: number;
  drawMs: number;
  mostBits: number;
  pollMs: number;
  pollMostMs: number;
  pollLeastMs: number;
}

type Answer =
  { status: number; type: string; bytes: Uint8Array } | { status: 'none'; reason: string };

/** An answer that is not a picture, as the client says it. */
class Declined extends Error {
  constructor(readonly result: Exclude<PortraitResult, { kind: 'picture' }>) {
    super(result.kind === 'unavailable' ? 'unavailable' : result.reason);
  }
}

export class ArtClient implements PortraitSource {
  /** One registration at a time, shared by every character asking at once. */
  private registering: Promise<ArtToken> | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly deps: ArtClientDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.wait = deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async portraitOf(facts: PortraitFacts, cancelled: () => boolean): Promise<PortraitResult> {
    if (this.deps.buildSecret === null) return { kind: 'unavailable' };
    const body = new TextEncoder().encode(JSON.stringify(facts));
    try {
      const token = await this.token();
      const first = await this.ask(token, body, cancelled);
      if (first !== UNKNOWN_TOKEN) return first;
      // The server lost the token (a revoke, a wiped database): register once more, then say so.
      await this.deps.tokens.forget();
      const again = await this.ask(await this.token(), body, cancelled);
      return again === UNKNOWN_TOKEN
        ? { kind: 'refused', reason: 'the art server does not know this install after registering' }
        : again;
    } catch (error) {
      if (error instanceof Declined) return error.result;
      return { kind: 'unreachable', reason: errorMessage(error) };
    }
  }

  /** One portrait asked for and polled to its picture, or the server's reason it is not one. */
  private async ask(
    token: ArtToken,
    body: Uint8Array,
    cancelled: () => boolean
  ): Promise<PortraitResult | typeof UNKNOWN_TOKEN> {
    const deadline = this.now() + this.deps.limits().drawMs;
    let answer = await this.send(
      'POST',
      '/v1/portrait',
      body,
      this.signed(token, 'POST', '/v1/portrait', body)
    );
    for (;;) {
      if (answer.status === 'none') return { kind: 'unreachable', reason: answer.reason };
      const picture = pictureOf(answer);
      if (picture !== null) return picture;
      const reason = reasonOf(answer);
      if (answer.status === 401 && reason.startsWith(UNKNOWN_TOKEN)) return UNKNOWN_TOKEN;
      if (answer.status !== 202) {
        return declined(answer.status, reason);
      }
      const job = jobOf(answer, this.deps.limits());
      if (job === null) return { kind: 'unreachable', reason: 'the art server named no job' };
      if (cancelled()) return { kind: 'unreachable', reason: 'no longer wanted' };
      if (this.now() + job.retryMs > deadline) {
        return { kind: 'unreachable', reason: 'the art server took too long to draw it' };
      }
      await this.wait(job.retryMs);
      const path = `/v1/portrait/${job.id}`;
      answer = await this.send(
        'GET',
        path,
        new Uint8Array(),
        this.signed(token, 'GET', path, new Uint8Array())
      );
    }
  }

  private async token(): Promise<ArtToken> {
    const kept = await this.deps.tokens.read();
    if (kept !== null) return kept;
    this.registering ??= this.register().finally(() => {
      this.registering = null;
    });
    return this.registering;
  }

  /** Steps 1 to 3: the challenge, the proof of work, and the build's signature over the challenge. */
  private async register(): Promise<ArtToken> {
    const secret = this.deps.buildSecret;
    if (secret === null) throw new Declined({ kind: 'unavailable' });
    const asked = await this.send('GET', '/v1/challenge', new Uint8Array(), {});
    const challenge = challengeOf(asked);
    const { mostBits } = this.deps.limits();
    if (challenge.bits > mostBits) {
      throw new Declined({
        kind: 'refused',
        reason: `the art server asked for ${challenge.bits} bits of work, more than ${mostBits}`
      });
    }
    const nonce = await this.deps.solve(challenge.challenge, challenge.bits);
    const body = new TextEncoder().encode(
      JSON.stringify({ challenge: challenge.challenge, nonce })
    );
    const build = createHmac('sha256', secret).update(challenge.challenge).digest('hex');
    const answer = await this.send('POST', '/v1/register', body, { 'X-Art-Build': build });
    if (answer.status === 'none')
      throw new Declined({ kind: 'unreachable', reason: answer.reason });
    const token = answer.status === 200 ? asArtToken(jsonOf(answer)) : null;
    if (token === null) {
      const reason = reasonOf(answer);
      throw new Declined(declined(answer.status, `registering: ${reason}`));
    }
    await this.deps.tokens.write(token);
    return token;
  }

  /** Step 4: the four headers, the signature over method, path, time, nonce and the body's digest. */
  private signed(
    token: ArtToken,
    method: string,
    path: string,
    body: Uint8Array
  ): Record<string, string> {
    const time = String(Math.floor(this.now() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const digest = createHash('sha256').update(body).digest('hex');
    const signature = createHmac('sha256', token.secret)
      .update(`${method}\n${path}\n${time}\n${nonce}\n${digest}`)
      .digest('hex');
    return {
      'X-Art-Token': token.token,
      'X-Art-Time': time,
      'X-Art-Nonce': nonce,
      'X-Art-Signature': signature
    };
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    body: Uint8Array,
    headers: Record<string, string>
  ): Promise<Answer> {
    try {
      const response = await this.fetch(this.deps.server() + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(method === 'POST' ? { body } : {}),
        signal: AbortSignal.timeout(this.deps.limits().requestMs)
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, type: response.headers.get('Content-Type') ?? '', bytes };
    } catch (error) {
      return { status: 'none', reason: `the art server did not answer: ${errorMessage(error)}` };
    }
  }
}

type Received = Extract<Answer, { status: number }>;

function pictureOf(answer: Received): PortraitResult | null {
  if (answer.status !== 200) return null;
  const type = answer.type.split(';')[0]!.trim();
  if (type !== 'image/webp' && type !== 'image/png') return null;
  return answer.bytes.length > 0 ? { kind: 'picture', bytes: answer.bytes, type } : null;
}

function jsonOf(answer: Received): unknown {
  if (!answer.type.startsWith('application/json')) return null;
  try {
    return JSON.parse(new TextDecoder().decode(answer.bytes));
  } catch {
    return null;
  }
}

/** The server's own `error`, else what came back. */
function reasonOf(answer: Received): string {
  const json = jsonOf(answer);
  if (isRecord(json) && typeof json['error'] === 'string') return json['error'].slice(0, 200);
  return `the art server answered ${answer.status}${answer.type === '' ? '' : ` with ${answer.type}`}`;
}

function jobOf(answer: Received, limits: ArtLimits): { id: string; retryMs: number } | null {
  const json = jsonOf(answer);
  if (!isRecord(json) || typeof json['job'] !== 'string' || !JOB_ID.test(json['job'])) return null;
  const after = json['retry_after'];
  const named = typeof after === 'number' && Number.isFinite(after) ? after * 1000 : limits.pollMs;
  return {
    id: json['job'],
    retryMs: Math.min(limits.pollMostMs, Math.max(limits.pollLeastMs, named))
  };
}

function challengeOf(answer: Answer): { challenge: string; bits: number } {
  if (answer.status === 'none') throw new Declined({ kind: 'unreachable', reason: answer.reason });
  const json = answer.status === 200 ? jsonOf(answer) : null;
  if (
    isRecord(json) &&
    typeof json['challenge'] === 'string' &&
    /^[0-9a-f]{16,64}$/.test(json['challenge']) &&
    typeof json['bits'] === 'number' &&
    Number.isInteger(json['bits']) &&
    json['bits'] > 0
  ) {
    return { challenge: json['challenge'], bits: json['bits'] };
  }
  throw new Declined(declined(answer.status, reasonOf(answer)));
}

/**
 * What a refusal means for asking again. The server's limits (429) and a full queue or spent
 * budget (5xx) pass, so they are asked again on the next entry, like a server that could not be
 * reached. Anything else is the server saying no to these facts.
 */
function declined(
  status: number,
  reason: string
): Extract<PortraitResult, { kind: 'refused' | 'unreachable' }> {
  return status === 429 || status >= 500
    ? { kind: 'unreachable', reason }
    : { kind: 'refused', reason };
}
