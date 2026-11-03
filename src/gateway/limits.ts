/**
 * The peer gateway's numbers. The gateway is its own program on the OCI host
 * and reads no `internal.yaml`, so they live here; a test passes its own.
 * Byte figures are from the todo's `peer-feed-bytes.mjs` over an 8.8 h
 * capture: a sheet is 0.11 KB/s on average and 1.5 KB in its busiest second.
 */
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
  /** Hello nonces remembered against a replay; past it the oldest go first. */
  mostHellos: number;
  /** How long a socket may stay open without a hello. */
  helloMs: number;
  /** Sockets open at once, hello or not. */
  mostSockets: number;
  /** Sockets open at once from one address. */
  mostSocketsPerAddress: number;
  /** The largest frame an install may send, a whole sheet included. */
  maxMessageBytes: number;
  /** What may wait unsent to an install that stopped reading before it is closed. */
  maxBufferedBytes: number;
  /** Frames shorter than this go uncompressed. */
  deflateMinBytes: number;
  /** What one install may send each second on average, every character it plays together, across reconnects. */
  bytesPerSecond: number;
  /** What it may send at once: a whole sheet for each of its characters, and their share lists. */
  burstBytes: number;
  /** Characters one install may claim at once. */
  mostClaims: number;
  /** How often each socket is pinged; one that has not answered the last is closed. */
  pingEveryMs: number;
  /** The largest registration body. */
  maxBodyBytes: number;
}

export const GATEWAY_LIMITS: GatewayLimits = {
  powBits: 20,
  challengeMs: 120_000,
  mostChallenges: 10_000,
  mostInstalls: 20_000,
  helloSkewMs: 120_000,
  mostHellos: 100_000,
  helloMs: 10_000,
  mostSockets: 5000,
  mostSocketsPerAddress: 16,
  maxMessageBytes: 65_536,
  maxBufferedBytes: 1_048_576,
  deflateMinBytes: 512,
  bytesPerSecond: 4096,
  burstBytes: 131_072,
  mostClaims: 8,
  pingEveryMs: 30_000,
  maxBodyBytes: 4096
};
