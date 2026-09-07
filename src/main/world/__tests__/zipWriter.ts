import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * A zip archive built by hand, so that a malformed one can be built too.
 *
 * Beside the tests rather than inside one of them because two files need it:
 * `zip.test.ts` proves the reader's refusals with it, and `RealmSource.test.ts`
 * proves what `openRealm` does with an archive holding no realm, several, or
 * one it can only find out about by reading. There is no other way to produce
 * an encrypted entry or a compression method nobody implements, and a refusal
 * that has never been seen to happen is a refusal nobody knows the wording of.
 *
 * It is **not** the only archive under test: the reader is also pointed at
 * `mdb/2023-09-02-gmud.zip`, written by somebody else's zip program,
 * because a reader tested only against its own writer proves the pair agree
 * rather than that either is right.
 */
export interface Written {
  name: string;
  body: Buffer;
  /** Stored rather than deflated, which is what a zip does for tiny files. */
  stored?: boolean;
  /** General-purpose flags; bit 0 is encryption, bit 11 says UTF-8 names. */
  flags?: number;
  /** Overrides the compression method, for the one nobody implements. */
  method?: number;
}

/** The archive's bytes, laid out as local headers, directory and end record. */
export function archiveOf(files: Written[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let at = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const stored = file.stored === true;
    const body = stored ? file.body : zlib.deflateRawSync(file.body);
    const method = file.method ?? (stored ? 0 : 8);
    const crc = zlib.crc32(file.body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.body.length, 22);
    local.writeUInt16LE(name.length, 26);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(file.flags ?? 0, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(file.body.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(at, 42);

    locals.push(local, name, body);
    central.push(entry, name);
    at += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([...locals, directory, end]);
}

let made = 0;

/** An archive on disk, since the reader takes a path and not bytes. */
export function written(bytes: Buffer, name = `archive-${made++}.zip`): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-zip-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}
