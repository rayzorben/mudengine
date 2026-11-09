import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { storeUpload, uploadName } from '../web/uploads';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-uploads-'));

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('uploadName', () => {
  it('keeps one plain component of the viewer name', () => {
    expect(uploadName('GreaterMUD.mdb')).toBe('GreaterMUD.mdb');
    expect(uploadName('C:\\Users\\me\\wccmmud.mdb')).toBe('wccmmud.mdb');
    expect(uploadName('../../etc/passwd')).toBe('passwd');
    expect(uploadName('.hidden')).toBe('hidden');
    expect(uploadName('a<b>|c.json')).toBe('a_b_c.json');
    expect(uploadName('...')).toBeNull();
    expect(uploadName('')).toBeNull();
  });

  it('shortens a long name and keeps its extension', () => {
    const name = uploadName(`${'a'.repeat(300)}.tar.gz`);
    expect(name?.length).toBe(120);
    expect(name?.endsWith('.gz')).toBe(true);
  });
});

describe('storeUpload', () => {
  it('writes the bytes to a fresh file', async () => {
    const stored = await storeUpload(dir, 'one.json', Readable.from([Buffer.from('{}')]), 10);
    expect(stored).toEqual({ kind: 'stored', file: path.join(dir, 'one.json') });
    expect(fs.readFileSync(path.join(dir, 'one.json'), 'utf8')).toBe('{}');
  });

  it('removes the partial file past the cap', async () => {
    const chunks = [Buffer.alloc(6), Buffer.alloc(6)];
    const stored = await storeUpload(dir, 'big.mdb', Readable.from(chunks), 10);
    expect(stored).toEqual({ kind: 'too-large' });
    expect(fs.existsSync(path.join(dir, 'big.mdb'))).toBe(false);
  });

  it('refuses a name with nothing left of it', async () => {
    expect(await storeUpload(dir, '..', Readable.from([]), 10)).toEqual({ kind: 'bad-name' });
  });
});
