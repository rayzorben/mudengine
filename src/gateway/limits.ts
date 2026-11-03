/**
 * The peer gateway's numbers. The gateway is its own program on the OCI host
 * and reads no `internal.yaml`, so they live here; a test passes its own.
 * Byte figures are from the todo's `peer-feed-bytes.mjs` over an 8.8 h
 * capture: a sheet is 0.11 KB/s on average and 1.5 KB in its busiest second.
 */
import { DAY_MS } from '../shared/values';

export interface GatewayLimits {
  /** Zero bits the registration's proof of work must find: about a million hashes at 20, as the art server. */
  powBits: number;
  /** How long a registration challenge may be answered. */
  challengeMs: number;
  /** Challenges held unanswered at once; the oldest goes first. */
  mostChallenges: number;
  /** Installs registered and held in memory; the oldest goes first, and registers again. */
  mostInstalls: number;
  /** How far a hello's clock may be from the gateway's, either way. */
  helloSkewMs: number;
  /** The largest frame an install may send, a whole sheet included. */
  maxMessageBytes: number;
  /** What may wait unsent to an install that stopped reading before it is closed. */
  maxBufferedBytes: number;
  /** Frames shorter than this go uncompressed. */
  deflateMinBytes: number;
  /** What one install may send each second on average, every character it plays together. */
  bytesPerSecond: number;
  /** What it may send at once: a whole sheet for each of its characters, and their share lists. */
  burstBytes: number;
  /** Characters one install may claim at once. */
  mostClaims: number;
  /** Names pinned to keys on disk; past it a new name is refused. */
  mostPins: number;
  /** How long a pinned name must go unclaimed before another key may take it: a character remade after this long. */
  claimIdleMs: number;
  /** How often each socket is pinged; one that has not answered the last is closed. */
  pingEveryMs: number;
  /** The largest registration body. */
  maxBodyBytes: number;
}

export const GATEWAY_LIMITS: GatewayLimits = {
  powBits: 20,
  challengeMs: 120_000,
  mostChallenges: 1000,
  mostInstalls: 20_000,
  helloSkewMs: 120_000,
  maxMessageBytes: 65_536,
  maxBufferedBytes: 1_048_576,
  deflateMinBytes: 512,
  bytesPerSecond: 4096,
  burstBytes: 131_072,
  mostClaims: 8,
  mostPins: 100_000,
  claimIdleMs: 90 * DAY_MS,
  pingEveryMs: 30_000,
  maxBodyBytes: 4096
};
