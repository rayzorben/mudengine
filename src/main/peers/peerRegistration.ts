/**
 * Registering this install with the sharing gateway, the art server's way
 * (`node/proofOfWork.ts`): the challenge, the proof of work off main, and the
 * build's HMAC over the challenge in `x-peer-build`. The answer is the token
 * and secret every hello is signed with, kept beside the art server's.
 * Each answer is read through `peerWire.ts`; anything else is a failure that
 * names what came back.
 */
import { createHmac } from 'node:crypto';

import {
  asPeerChallenge,
  asPeerToken,
  PEER_BUILD_HEADER,
  PEER_PATHS,
  type PeerToken
} from '../../shared/peerWire';
import { errorMessage } from '../../shared/values';

export interface RegistrationDeps {
  /** The build's registration secret; registering is not tried without one. */
  buildSecret: string;
  solve(challenge: string, bits: number): Promise<string>;
  /** How long one request may take, and the most work a registration is done for. */
  requestMs: number;
  mostBits: number;
  fetch: typeof fetch;
}

async function json(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  what: string
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch (error) {
    throw new Error(`the sharing server did not answer ${what}: ${errorMessage(error)}`);
  }
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(
      `the sharing server answered ${what} with ${response.status}: ${text.slice(0, 200)}`
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`the sharing server answered ${what} with something that is not JSON`);
  }
}

export async function registerWithGateway(
  server: string,
  deps: RegistrationDeps
): Promise<PeerToken> {
  const signal = (): AbortSignal => AbortSignal.timeout(deps.requestMs);
  const asked = asPeerChallenge(
    await json(deps.fetch, server + PEER_PATHS.challenge, { signal: signal() }, 'the challenge')
  );
  if (asked === null) throw new Error('the sharing server sent a challenge that does not read');
  if (asked.bits > deps.mostBits) {
    throw new Error(
      `the sharing server asked for ${asked.bits} bits of work, more than ${deps.mostBits}`
    );
  }
  const nonce = await deps.solve(asked.challenge, asked.bits);
  const build = createHmac('sha256', deps.buildSecret).update(asked.challenge).digest('hex');
  const token = asPeerToken(
    await json(
      deps.fetch,
      server + PEER_PATHS.register,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [PEER_BUILD_HEADER]: build },
        body: JSON.stringify({ challenge: asked.challenge, nonce }),
        signal: signal()
      },
      'the registration'
    )
  );
  if (token === null) throw new Error('the sharing server sent a token that does not read');
  return token;
}
