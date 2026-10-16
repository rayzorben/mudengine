import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { revision, revisionNow, spell, type Watched } from '../revision';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-revision-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const yaml = (name: string): boolean => name.endsWith('.yaml');

function tree(): Watched[] {
  return [
    { kind: 'file', path: path.join(dir, 'default.yaml') },
    { kind: 'files', dir: path.join(dir, 'loops'), accept: yaml },
    {
      kind: 'each',
      dir: path.join(dir, 'profiles'),
      each: (id) => [{ kind: 'file', path: path.join(dir, 'profiles', id, 'profile.yaml') }]
    }
  ];
}

function write(relative: string, body: string): void {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

describe('revision', () => {
  // The poll reads one way and the settle the other; a difference in spelling
  // would read as a change on every tick.
  it('reads the same either way', async () => {
    write('default.yaml', 'a: 1\n');
    write('loops/one.yaml', 'name: one\n');
    write('loops/notes.txt', 'not a loop\n');
    write('profiles/rayzor/profile.yaml', 'server: local\n');
    fs.mkdirSync(path.join(dir, 'profiles', '.sync'));
    expect(spell(await revision(tree()))).toBe(spell(revisionNow(tree())));
  });

  it('reads nothing on disk as a state, the same either way', async () => {
    const empty = spell(revisionNow(tree()));
    expect(empty).toBe('');
    expect(spell(await revision(tree()))).toBe(empty);
  });

  it('moves when a file appears, changes or goes', async () => {
    write('profiles/rayzor/profile.yaml', 'server: local\n');
    const before = spell(await revision(tree()));

    write('profiles/festus/profile.yaml', 'server: local\n');
    const added = spell(await revision(tree()));
    expect(added).not.toBe(before);

    write('profiles/festus/profile.yaml', 'server: elsewhere\n');
    const changed = spell(await revision(tree()));
    expect(changed).not.toBe(added);

    fs.rmSync(path.join(dir, 'profiles', 'festus'), { recursive: true });
    expect(spell(await revision(tree()))).toBe(before);
  });

  it('ignores a file the filter refuses', async () => {
    write('loops/one.yaml', 'name: one\n');
    const before = spell(await revision(tree()));
    write('loops/one.yaml~', 'backup\n');
    expect(spell(await revision(tree()))).toBe(before);
  });
});
