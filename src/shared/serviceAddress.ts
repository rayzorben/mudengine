/**
 * The address of a service the client signs requests to, the art server
 * (`artConfig.ts`) and the peer gateway (`peersConfig.ts`): `https://`, or
 * `http://` only on this machine, since what is sent about a character is not
 * for a plain hop across the internet.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The address without a trailing slash, or null for anything else. */
export function asServiceAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const secure =
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!secure || url.search !== '' || url.hash !== '' || url.username !== '') return null;
  return url.href.replace(/\/+$/, '');
}
