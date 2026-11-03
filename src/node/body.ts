/**
 * A request's body read up to a cap, for the web host's sign-in and the peer
 * gateway's registration. Past the cap the request is destroyed rather than
 * read on, so a caller sending more cannot make the server hold it, and no
 * answer reaches that caller.
 */
import type http from 'node:http';

export type CappedBody =
  { kind: 'read'; text: string } | { kind: 'too-large' } | { kind: 'failed'; reason: string };

export function readCapped(request: http.IncomingMessage, most: number): Promise<CappedBody> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > most) {
        resolve({ kind: 'too-large' });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () =>
      resolve({ kind: 'read', text: Buffer.concat(chunks).toString('utf8') })
    );
    request.on('error', (error) => resolve({ kind: 'failed', reason: error.message }));
  });
}
