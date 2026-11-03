import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { newEd25519Pair } from '../../../node/ed25519';
import { peerKeysAt } from '../peerKeys';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-keys-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a character's keys", () => {
  it('makes a pair per realm once, keeps it readable by this user only, and reads it back', async () => {
    const file = path.join(dir, 'peer-keys', 'brakkle.json');
    let made = 0;
    const make = (): ReturnType<typeof newEd25519Pair> => {
      made += 1;
      return newEd25519Pair();
    };
    const keys = peerKeysAt(file, make);
    const [one, again] = await Promise.all([
      keys.pairFor('orohost:2427'),
      keys.pairFor('orohost:2427')
    ]);
    expect(again).toEqual(one);
    const other = await keys.pairFor('orohost:2427/Paradigm');
    expect(other.publicKey).not.toBe(one.publicKey);
    expect(made).toBe(2);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const reread = await peerKeysAt(file, make).pairFor('orohost:2427');
    expect(reread).toEqual(one);
    expect(made).toBe(2);
  });

  it('refuses to make a pair over a file that does not read, which would end every pin', async () => {
    const file = path.join(dir, 'brakkle.json');
    fs.writeFileSync(file, '{ not json');
    await expect(peerKeysAt(file, newEd25519Pair).pairFor('orohost:2427')).rejects.toThrow(
      /not JSON/
    );
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
  });
});
