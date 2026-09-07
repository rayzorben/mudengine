import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isWithin, listHome } from '../browse';

const wording = {
  outside: () => 'outside',
  unreadable: (target: string, message: string) => `unreadable ${target}: ${message}`
};
const isRealm = (name: string) => /\.(mdb|zip)$/i.test(name);

let home = '';
let elsewhere = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-browse-home-'));
  elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-browse-elsewhere-'));
  fs.mkdirSync(path.join(home, 'profiles', 'soul'), { recursive: true });
  fs.writeFileSync(path.join(home, 'profiles', 'soul', 'profile.yaml'), 'name: Soul\n');
  fs.writeFileSync(path.join(home, 'internal.yaml'), 'tuning: {}\n');
  fs.writeFileSync(path.join(home, 'realm.mdb'), 'not really');
  fs.writeFileSync(path.join(elsewhere, 'secret.txt'), 'nope');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

describe('isWithin', () => {
  it('is the root or under it, and never a sibling with the same prefix', () => {
    expect(isWithin('/home/a', '/home/a')).toBe(true);
    expect(isWithin('/home/a', '/home/a/b')).toBe(true);
    expect(isWithin('/home/a', '/home/ab')).toBe(false);
    expect(isWithin('/home/a', '/home')).toBe(false);
  });
});

describe('listHome', () => {
  it('lists the root, directories first, with sizes and the realm files marked', async () => {
    const listing = await listHome(home, null, isRealm, wording);
    expect(listing.error).toBeNull();
    expect(listing.parent).toBeNull();
    expect(listing.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      'directory:profiles',
      'file:internal.yaml',
      'file:realm.mdb'
    ]);
    const realm = listing.entries.find((entry) => entry.name === 'realm.mdb')!;
    expect(realm.realm).toBe(true);
    expect(realm.size).toBe(10);
    expect(listing.entries.find((entry) => entry.name === 'internal.yaml')!.realm).toBe(false);
  });

  it('lists a directory under the root, with its parent', async () => {
    const listing = await listHome(home, path.join(home, 'profiles', 'soul'), isRealm, wording);
    expect(listing.error).toBeNull();
    expect(listing.entries.map((entry) => entry.name)).toEqual(['profile.yaml']);
    expect(listing.parent).toBe(path.join(listing.root, 'profiles'));
  });

  it('lists the directory holding a file, and says which file was asked about', async () => {
    const listing = await listHome(home, path.join(home, 'internal.yaml'), isRealm, wording);
    expect(listing.error).toBeNull();
    expect(listing.dir).toBe(listing.root);
    expect(listing.selected).toBe('internal.yaml');
  });

  it('refuses a path outside the root, by every spelling', async () => {
    for (const target of [
      elsewhere,
      path.join(home, '..'),
      path.join(home, '..', path.basename(elsewhere)),
      `${home}-sibling`,
      '/'
    ]) {
      const listing = await listHome(home, target, isRealm, wording);
      expect(listing.error, target).toBe('outside');
      expect(listing.entries, target).toEqual([]);
    }
  });

  it('refuses a symlink that points outside the root', async () => {
    if (process.platform === 'win32') return;
    fs.symlinkSync(elsewhere, path.join(home, 'escape'));
    const listing = await listHome(home, path.join(home, 'escape'), isRealm, wording);
    expect(listing.error).toBe('outside');
  });

  it('reports a path that does not exist rather than guessing', async () => {
    const listing = await listHome(home, path.join(home, 'nowhere'), isRealm, wording);
    expect(listing.error).toMatch(/^unreadable /);
    expect(listing.entries).toEqual([]);
  });
});
