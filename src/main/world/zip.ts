import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Reading one file out of a zip archive, with nothing installed.
 *
 * A realm database is tens of megabytes of Access file that compresses to about
 * a tenth of that, so the shape a realm is actually *distributed* in — and now
 * the shape this repository keeps its own in — is a zip holding one `.mdb`.
 * `RealmSource` reads that shape directly rather than asking somebody to
 * unpack it first, because a step between downloading a realm and using it is a
 * step that gets skipped, and the symptom is the wrong map.
 *
 * **Written here rather than taken from a package**, for the reason
 * `mdb-reader` is bundled and `better-sqlite3` was refused: this runs inside
 * Electron, where a native module needs `electron-rebuild` per platform, and a
 * pure-JavaScript dependency for two hundred lines of container format is a
 * dependency to keep bundled, audited and pinned for ever. `zlib` is a Node
 * builtin and deflate is the only compression a zip in the wild uses.
 *
 * **Everything is read from the central directory**, never by scanning for
 * local headers: a local header may say a stream's sizes are "in the trailing
 * descriptor" and carry zeroes, and a reader that believes it reads nothing at
 * all. The central directory is the authority the format itself nominates.
 *
 * **What it refuses, it refuses out loud.** Zip64, encryption and any
 * compression method that is not stored or deflate are named in the error, with
 * what to do about it — an archive silently read as empty is the confident,
 * silent, empty realm that `realmKind` exists to prevent.
 */
export interface ZipEntry {
  /** The path as the archive spells it, separators and all. */
  readonly name: string;
  /** Uncompressed length, from the central directory. */
  readonly size: number;
  readonly compressedSize: number;
  readonly method: number;
  readonly crc: number;
  readonly headerOffset: number;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const CENTRAL_FILE_HEADER_SIZE = 46;
const LOCAL_FILE_HEADER_SIZE = 30;
const STORED = 0;
const DEFLATED = 8;
/** Fields the format sets to all-ones to mean "the real value is in the zip64 record". */
const NO_U16 = 0xffff;
const NO_U32 = 0xffffffff;
/** General-purpose bit 0 is encryption; bit 11 says the names are UTF-8. */
const ENCRYPTED = 0x0001;
const UTF8_NAMES = 0x0800;

/** Is this a zip file? By extension, exactly as `realmKind` decides the rest. */
export function isZip(file: string): boolean {
  return path.extname(file).toLowerCase() === '.zip';
}

/**
 * Every file the archive holds.
 *
 * Reads the whole archive: a realm zip is a couple of megabytes and this
 * happens once, when somebody chooses a file. Directories are left out — they
 * are entries with a trailing separator and no content, and no caller here can
 * do anything with one.
 */
export function zipEntries(file: string): ZipEntry[] {
  const archive = fs.readFileSync(file);
  const label = path.basename(file);
  try {
    return index(archive, label);
  } catch (error) {
    if (error instanceof RangeError) throw new Error(`${label}: truncated or not a zip archive.`);
    throw error;
  }
}

/** One entry's bytes, decompressed and checked against the archive's own CRC. */
export function readZipEntry(file: string, entry: ZipEntry): Buffer {
  const archive = fs.readFileSync(file);
  const label = path.basename(file);
  try {
    return extract(archive, entry, label);
  } catch (error) {
    if (error instanceof RangeError)
      throw new Error(`${label}: ${entry.name} runs past the end of the archive.`);
    throw error;
  }
}

function index(archive: Buffer, label: string): ZipEntry[] {
  const end = endOfCentralDirectory(archive);
  if (end < 0) throw new Error(`${label}: not a zip archive.`);

  const count = archive.readUInt16LE(end + 10);
  const directory = archive.readUInt32LE(end + 16);
  if (count === NO_U16 || directory === NO_U32 || archive.readUInt32LE(end + 12) === NO_U32)
    throw new Error(
      `${label}: a zip64 archive, which this reader does not read. Unzip it and name the ` +
        'database inside it instead.'
    );

  const entries: ZipEntry[] = [];
  let at = directory;
  for (let read = 0; read < count; read++) {
    if (archive.readUInt32LE(at) !== CENTRAL_FILE_HEADER)
      throw new Error(`${label}: the archive's directory is damaged at entry ${read + 1}.`);
    const flags = archive.readUInt16LE(at + 8);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    // Bit 11 is the only statement a zip makes about its names; without it the
    // format says CP437, whose low half is ASCII — which every name this has
    // ever met is.
    const name = archive.toString(
      (flags & UTF8_NAMES) === 0 ? 'latin1' : 'utf8',
      at + CENTRAL_FILE_HEADER_SIZE,
      at + CENTRAL_FILE_HEADER_SIZE + nameLength
    );
    const size = archive.readUInt32LE(at + 24);
    const compressedSize = archive.readUInt32LE(at + 20);
    if (size === NO_U32 || compressedSize === NO_U32)
      throw new Error(
        `${label}: ${name} is stored in zip64 form, which this reader does not read. ` +
          'Unzip it and name the database inside it instead.'
      );
    if (!name.endsWith('/'))
      entries.push({
        name,
        size,
        compressedSize,
        method: (flags & ENCRYPTED) === 0 ? archive.readUInt16LE(at + 10) : -1,
        crc: archive.readUInt32LE(at + 16),
        headerOffset: archive.readUInt32LE(at + 42)
      });
    at += CENTRAL_FILE_HEADER_SIZE + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Where the central directory starts.
 *
 * Scanned backwards, because the record it ends with carries a comment of up to
 * 64 KB and there is no other way to find it. A comment containing the
 * signature would be found first; the directory walk then fails to see a header
 * where one should be, and says so, rather than reading nonsense.
 */
function endOfCentralDirectory(archive: Buffer): number {
  const last = archive.length - END_OF_CENTRAL_DIRECTORY_SIZE;
  const earliest = Math.max(0, last - NO_U16);
  for (let at = last; at >= earliest; at--)
    if (archive.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) return at;
  return -1;
}

function extract(archive: Buffer, entry: ZipEntry, label: string): Buffer {
  if (entry.method === -1)
    throw new Error(`${label}: ${entry.name} is encrypted, so it cannot be read.`);
  if (entry.method !== STORED && entry.method !== DEFLATED)
    throw new Error(
      `${label}: ${entry.name} uses compression method ${entry.method}, and only stored and ` +
        'deflated entries can be read. Unzip it and name the database inside it instead.'
    );

  const at = entry.headerOffset;
  if (archive.readUInt32LE(at) !== LOCAL_FILE_HEADER)
    throw new Error(`${label}: ${entry.name} is not where the archive's directory says it is.`);
  // The local header's own name and extra lengths, not the directory's: the two
  // legitimately differ, and an entry read at the directory's offsets comes out
  // shifted by however many bytes of extra field the writer chose to add here.
  const from =
    at + LOCAL_FILE_HEADER_SIZE + archive.readUInt16LE(at + 26) + archive.readUInt16LE(at + 28);
  const stored = archive.subarray(from, from + entry.compressedSize);
  if (stored.length !== entry.compressedSize)
    throw new Error(`${label}: ${entry.name} runs past the end of the archive.`);

  // `maxOutputLength` is the archive's own answer for how big this is, so a
  // header claiming one size and expanding to another fails here rather than
  // taking the process's memory with it.
  const data =
    entry.method === STORED
      ? Buffer.from(stored)
      : zlib.inflateRawSync(stored, { maxOutputLength: entry.size });

  if (data.length !== entry.size)
    throw new Error(
      `${label}: ${entry.name} unpacked to ${data.length} bytes where the archive says ${entry.size}.`
    );
  // Checked because the whole point of reading the archive rather than a loose
  // file is that nobody unpacked it — so nothing else has ever looked at these
  // bytes, and a realm read half-corrupt is a map that is quietly wrong.
  if (zlib.crc32(data) !== entry.crc)
    throw new Error(`${label}: ${entry.name} is corrupt (checksum mismatch).`);
  return data;
}
