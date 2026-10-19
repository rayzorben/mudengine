/**
 * A PNG `data:` URL from the window as its bytes, or null for anything else:
 * another type, broken base64, an image past `mostBytes`, or bytes that do
 * not open with PNG's signature.
 */
import { PNG_DATA_URL as PREFIX } from '../../shared/portrait';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function pngOfDataUrl(value: unknown, mostBytes: number): Uint8Array | null {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return null;
  const base64 = value.slice(PREFIX.length);
  // Four characters carry three bytes; checked before anything is decoded.
  if ((base64.length / 4) * 3 > mostBytes || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  if (bytes.length > mostBytes || SIGNATURE.some((byte, at) => bytes[at] !== byte)) return null;
  return bytes;
}
