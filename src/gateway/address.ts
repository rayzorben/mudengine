/**
 * Where a request came from, as the gateway counts it: the sockets an address
 * holds and the challenges and registrations it asks for.
 *
 * Caddy sets `X-Forwarded-For` to the address it was dialled from, replacing
 * whatever the caller sent, and the gateway listens on loopback so it is
 * reachable only through Caddy; the last entry is Caddy's
 * (`mudengine-session` › `parts/peers.md`).
 *
 * An IPv6 address is counted by its /64: one home or one host is handed a
 * whole /64, so counting each address would give one caller billions of
 * fresh limits. An IPv4 address mapped into IPv6 is counted as itself.
 */
import type http from 'node:http';
import { isIPv4, isIPv6 } from 'node:net';

/** The first four groups of an IPv6 address, or null when it does not read as one. */
function prefix64(address: string): string | null {
  const bare = address.split('%')[0] ?? '';
  if (!isIPv6(bare)) return null;
  const halves = bare.split('::');
  const head = halves[0] === '' ? [] : (halves[0] ?? '').split(':');
  const tail = halves.length > 1 && halves[1] !== '' ? (halves[1] ?? '').split(':') : [];
  // A dotted IPv4 tail fills two groups.
  const tailGroups = tail.length + (tail.some((group) => group.includes('.')) ? 1 : 0);
  const groups = [...head, ...Array<string>(8 - head.length - tailGroups).fill('0'), ...tail];
  return groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':');
}

/** The key an address is counted under: an IPv4 address, or an IPv6 /64. */
export function addressKey(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined && isIPv4(mapped)) return mapped;
  const net = prefix64(address);
  return net === null ? address : `${net}::/64`;
}

/** Where a request came from, by `addressKey`. */
export function addressOf(request: http.IncomingMessage): string {
  const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',');
  const last = forwarded[forwarded.length - 1]?.trim() ?? '';
  return addressKey(last.length > 0 ? last : (request.socket.remoteAddress ?? 'unknown'));
}
