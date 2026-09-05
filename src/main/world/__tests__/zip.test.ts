import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { isZip, readZipEntry, zipEntries } from '../zip';
import { archiveOf, written } from './zipWriter';

/**
 * The zip reader, against archives written here and against the one that ships.
 *
 * Two halves, deliberately. **The refusals are checked against archives built
 * by `zipWriter.ts`**, because there is no other way to produce an encrypted
 * entry or a compression method nobody uses — and a refusal that has never been
 * seen to happen is a refusal nobody knows the wording of. **Interoperability
 * is checked against `resources/mdb/2023-09-02-gmud.zip`**, which was written
 * by somebody else's zip program and is the realm the client actually ships: a
 * reader tested only against its own writer proves the pair agree, not that
 * either is right.
 */
describe('what an archive holds', () => {
  it('lists every file, with the sizes the directory states', () => {
    const file = written(
      archiveOf([
        { name: 'realm.mdb', body: Buffer.alloc(4096, 7) },
        { name: 'notes.txt', body: Buffer.from('hello'), stored: true }
      ])
    );
    expect(zipEntries(file).map((entry) => [entry.name, entry.size])).toEqual([
      ['realm.mdb', 4096],
      ['notes.txt', 5]
    ]);
  });

  it('reads a deflated entry back exactly', () => {
    // Compressible, so the writer really deflates rather than storing.
    const body = Buffer.from('the same sentence, over and over. '.repeat(500));
    const file = written(archiveOf([{ name: 'realm.mdb', body }]));
    const [entry] = zipEntries(file);
    expect(readZipEntry(file, entry!).equals(body)).toBe(true);
  });

  it('reads a stored entry back exactly', () => {
    const body = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
    const file = written(archiveOf([{ name: 'realm.db', body, stored: true }]));
    const [entry] = zipEntries(file);
    expect(readZipEntry(file, entry!).equals(body)).toBe(true);
  });

  it('leaves directories out: an entry with no content is not a file', () => {
    const file = written(
      archiveOf([
        { name: 'realms/', body: Buffer.alloc(0), stored: true },
        { name: 'realms/realm.mdb', body: Buffer.from('x'), stored: true }
      ])
    );
    expect(zipEntries(file).map((entry) => entry.name)).toEqual(['realms/realm.mdb']);
  });

  it('is a zip by extension, like every other realm shape', () => {
    expect(isZip('/x/realm.zip')).toBe(true);
    expect(isZip('/x/REALM.ZIP')).toBe(true);
    expect(isZip('/x/realm.mdb')).toBe(false);
  });
});

/*
 * Every one of these would otherwise be an archive read as empty, and an empty
 * archive is the confident, silent, empty realm the whole reader exists to
 * refuse. So each says what it found and what to do about it.
 */
describe('what it refuses, and how loudly', () => {
  it('refuses a file that is not a zip at all', () => {
    const file = written(Buffer.from('this is not an archive'), 'notes.zip');
    expect(() => zipEntries(file)).toThrow(/not a zip archive/i);
  });

  it('refuses an encrypted entry, naming it', () => {
    const file = written(archiveOf([{ name: 'realm.mdb', body: Buffer.from('secret'), flags: 1 }]));
    const [entry] = zipEntries(file);
    expect(() => readZipEntry(file, entry!)).toThrow(/realm\.mdb is encrypted/);
  });

  it('refuses a compression method it does not implement, naming the method', () => {
    const file = written(
      archiveOf([{ name: 'realm.mdb', body: Buffer.from('x'), stored: true, method: 14 }])
    );
    const [entry] = zipEntries(file);
    expect(() => readZipEntry(file, entry!)).toThrow(/method 14/);
  });

  /*
   * The reason the checksum is checked at all: nothing else ever looks at these
   * bytes. A loose file at least passed through somebody's unzip program, which
   * would have said so — reading the archive directly means this is the only
   * place a corrupt realm can be caught before it becomes a map that is quietly
   * wrong.
   */
  it('catches a corrupted entry rather than handing back the damage', () => {
    const bytes = archiveOf([{ name: 'realm.mdb', body: Buffer.alloc(64, 3), stored: true }]);
    // Into the stored body, past the local header and the name.
    const at = 30 + 'realm.mdb'.length + 10;
    bytes.writeUInt8(bytes.readUInt8(at) ^ 0xff, at);
    const file = written(bytes);
    const [entry] = zipEntries(file);
    expect(() => readZipEntry(file, entry!)).toThrow(/corrupt/i);
  });

  it('refuses a zip64 archive, and says to unzip it', () => {
    const bytes = archiveOf([{ name: 'realm.mdb', body: Buffer.from('x'), stored: true }]);
    // The count of entries, set to the sentinel that means "see the zip64
    // record" — which is the shape a >4 GB or >65,535-entry archive takes.
    bytes.writeUInt16LE(0xffff, bytes.length - 22 + 10);
    const file = written(bytes);
    expect(() => zipEntries(file)).toThrow(/zip64.*[Uu]nzip it/s);
  });

  it('reports a truncated archive rather than throwing a range error', () => {
    const bytes = archiveOf([{ name: 'realm.mdb', body: Buffer.alloc(2048, 5) }]);
    const [entry] = zipEntries(written(bytes));
    // Everything after the central directory's account of where the data ends.
    const file = written(bytes.subarray(0, 40), 'cut.zip');
    expect(() => readZipEntry(file, entry!)).toThrow(/cut\.zip/);
  });
});

/*
 * The archive that ships, written by a real zip program rather than by the
 * builder above. Only the directory is read here — inflating 20 MB belongs in
 * the realm suite, where `RealmLibrary.realm.test.ts` converts what comes out.
 */
describe('the archive the client ships', () => {
  const shipped = path.resolve('resources/mdb/2023-09-02-gmud.zip');

  it('holds exactly one realm database', () => {
    const entries = zipEntries(shipped);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toMatch(/\.mdb$/i);
    // Compressed to a fifth of its size, which is the whole reason it is here.
    expect(entries[0]?.size).toBeGreaterThan(entries[0]!.compressedSize * 4);
  });
});
