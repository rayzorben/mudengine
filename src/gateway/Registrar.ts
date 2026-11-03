/**
 * Who may open a socket: an install registers once, as with the art server,
 * by doing a proof of work and signing the challenge with the build's secret,
 * and is given a token and a secret. Each socket's hello is then signed with
 * that secret over a time and a nonce never used before. Tokens are held in
 * memory only: after a restart an install's hello is refused as an unknown
 * token, and it registers again.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { meetsProofOfWork } from '../node/proofOfWork';
import {
  helloText,
  type PeerChallenge,
  type PeerRegistration,
  type PeerToken,
  type PeerUp
} from '../shared/peerWire';
import type { GatewayLimits } from './limits';

export interface RegistrarDeps {
  /** The build secret the client is built with (`ART_BUILD_SECRET`). */
  buildSecret: string;
  limits: GatewayLimits;
  now(): number;
  /** `bytes` random bytes as hex. */
  random(bytes: number): string;
}

/** Why a registration was refused, as the gateway says it. */
export type RegisterRefusal = 'unknown challenge' | 'not enough work' | 'not a mudengine build';

export type HelloCheck = 'ok' | 'unknown-token' | 'signature';

type Hello = Extract<PeerUp, { k: 'hello' }>;

function hmac(secret: string, text: string): string {
  return createHmac('sha256', secret).update(text).digest('hex');
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Drop the oldest entries of an insertion-ordered map until it holds `most`. */
function trim<K, V>(map: Map<K, V>, most: number): void {
  for (const key of map.keys()) {
    if (map.size <= most) return;
    map.delete(key);
  }
}

export class Registrar {
  /** Each challenge given out and when it lapses. */
  private readonly challenges = new Map<string, number>();
  /** Each install's token and secret. */
  private readonly installs = new Map<string, string>();
  /** Hello nonces seen and when each may be forgotten, so a hello cannot be sent twice. */
  private readonly nonces = new Map<string, number>();

  constructor(private readonly deps: RegistrarDeps) {}

  challenge(): PeerChallenge {
    const { limits } = this.deps;
    const challenge = this.deps.random(32);
    this.challenges.set(challenge, this.deps.now() + limits.challengeMs);
    trim(this.challenges, limits.mostChallenges);
    return { challenge, bits: limits.powBits };
  }

  register(asked: PeerRegistration, build: string): PeerToken | RegisterRefusal {
    const lapses = this.challenges.get(asked.challenge);
    // Used once, answered or not.
    this.challenges.delete(asked.challenge);
    if (lapses === undefined || lapses < this.deps.now()) return 'unknown challenge';
    if (!meetsProofOfWork(asked.challenge, asked.nonce, this.deps.limits.powBits)) {
      return 'not enough work';
    }
    if (!sameHex(build, hmac(this.deps.buildSecret, asked.challenge))) {
      return 'not a mudengine build';
    }
    const token = { token: this.deps.random(12), secret: this.deps.random(32) };
    this.installs.set(token.token, token.secret);
    trim(this.installs, this.deps.limits.mostInstalls);
    return token;
  }

  hello(frame: Hello): HelloCheck {
    const secret = this.installs.get(frame.token);
    if (secret === undefined) return 'unknown-token';
    const now = this.deps.now();
    const skew = this.deps.limits.helloSkewMs;
    for (const [nonce, forget] of this.nonces) {
      if (forget > now) break;
      this.nonces.delete(nonce);
    }
    const seen = `${frame.token}:${frame.nonce}`;
    if (Math.abs(frame.time * 1000 - now) > skew || this.nonces.has(seen)) return 'signature';
    if (!sameHex(frame.sig, hmac(secret, helloText(frame.time, frame.nonce)))) return 'signature';
    this.nonces.set(seen, now + 2 * skew);
    return 'ok';
  }
}
