/**
 * A gzipped tar of named files: the character export's container.
 *
 * Node ships gzip and no archive format, and a `.tar.gz` opens in every
 * archive tool on all three platforms, so a player can look inside or unpack
 * one by hand. Only what the export writes is supported: regular files under
 * ustar's name and prefix fields. Reading refuses anything malformed rather
 * than guessing; `mudengine-config` › *A character travels as one file*.
 */
import { promisify } from 'node:util';
import zlib from 'node:zlib';

export interface TarEntry {
  name: string;
  data: Buffer;
}

const BLOCK = 512;
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export async function packTarball(entries: readonly TarEntry[]): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(header(entry.name, entry.data.length), entry.data, padding(entry.data.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzip(Buffer.concat(parts));
}

/** The files, or null when the bytes are not a tarball this module wrote. */
export async function unpackTarball(bytes: Buffer, maxBytes: number): Promise<TarEntry[] | null> {
  let tar: Buffer;
  try {
    tar = await gunzip(bytes, { maxOutputLength: maxBytes });
  } catch {
    return null;
  }
  const entries: TarEntry[] = [];
  for (let at = 0; at + BLOCK <= tar.length;) {
    const block = tar.subarray(at, at + BLOCK);
    if (block.every((byte) => byte === 0)) return entries;
    if (!checksumHolds(block)) return null;
    const size = Number.parseInt(field(block, 124, 12), 8);
    if (!Number.isSafeInteger(size) || size < 0) return null;
    const start = at + BLOCK;
    if (start + size > tar.length) return null;
    const type = String.fromCharCode(block[156] ?? 0);
    if (type === '0' || type === '\0') {
      const prefix = field(block, 345, 155);
      const name = field(block, 0, 100);
      entries.push({
        name: prefix.length > 0 ? `${prefix}/${name}` : name,
        data: tar.subarray(start, start + size)
      });
    } else if (type !== '5') {
      return null;
    }
    at = start + size + ((BLOCK - (size % BLOCK)) % BLOCK);
  }
  return null;
}

function header(path: string, size: number): Buffer {
  const { name, prefix } = splitName(path);
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 'ascii');
  block.write('0000000\0', 108, 'ascii');
  block.write('0000000\0', 116, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  block.write(
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, '0')}\0`,
    136,
    'ascii'
  );
  block.write('        ', 148, 'ascii');
  block.write('0', 156, 'ascii');
  block.write('ustar\0' + '00', 257, 'ascii');
  block.write(prefix, 345, 155, 'utf8');
  block.write(`${checksum(block).toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

/** ustar keeps a long path as a prefix and a name, split at a slash. */
function splitName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`the path ${path} is too long for a tarball`);
}

function padding(size: number): Buffer {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

function checksum(block: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : (block[i] ?? 0);
  return sum;
}

function checksumHolds(block: Buffer): boolean {
  return Number.parseInt(field(block, 148, 8), 8) === checksum(block);
}

function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw
    .subarray(0, end === -1 ? length : end)
    .toString('utf8')
    .trim();
}
