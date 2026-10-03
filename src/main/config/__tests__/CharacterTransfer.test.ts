import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { homeAt, type Home } from '../../app/home';
import { exportCharacter, importCharacter } from '../CharacterTransfer';
import { packTarball } from '../tarball';

let dirs: string[];
let from: Home;
let to: Home;

const MAX = 10_000_000;
const PROFILE = [
  '# my own comment',
  'name: Festus',
  'server: Paradigm',
  'account:',
  '  username: soul',
  '  password: hunter2',
  ''
].join('\n');

function put(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function home(): Home {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-transfer-'));
  dirs.push(dir);
  return homeAt(dir);
}

beforeEach(() => {
  dirs = [];
  from = home();
  to = home();
  put(from.profile('festus').file, PROFILE);
  put(path.join(from.profile('festus').loops, 'sewers.yaml'), 'name: Sewers\n');
  put(from.server('paradigm').file, 'name: Paradigm\nhost: example.test\nport: 23\n');
  put(from.record('memory', 'festus'), '{"exits":[]}');
  // The fight log is a directory: each segment and fold travels, a fold being written does not.
  put(path.join(from.record('fights', 'festus'), '0001.jsonl.gz'), 'gz bytes');
  put(path.join(from.record('fights', 'festus'), '0001.folds.json'), '{}');
  put(path.join(from.record('fights', 'festus'), '.0002.folds.json.1-1.tmp'), '{}');
});

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function exported(password: boolean): Promise<Buffer> {
  const result = await exportCharacter(from, 'festus', password);
  if (!result.ok) throw new Error(result.error);
  return result.bytes;
}

describe('a character exported and imported', () => {
  it('arrives with its realm, its loops and its records, the comment kept', async () => {
    const result = await importCharacter(to, await exported(true), {
      maxBytes: MAX,
      taken: () => false
    });
    expect(result).toMatchObject({ kind: 'imported', id: 'festus', name: 'Festus' });
    expect(fs.readFileSync(to.profile('festus').file, 'utf8')).toBe(PROFILE);
    expect(fs.existsSync(path.join(to.profile('festus').loops, 'sewers.yaml'))).toBe(true);
    expect(fs.existsSync(to.server('paradigm').file)).toBe(true);
    expect(fs.readFileSync(to.record('memory', 'festus'), 'utf8')).toBe('{"exits":[]}');
    expect(fs.readdirSync(to.record('fights', 'festus')).sort()).toEqual([
      '0001.folds.json',
      '0001.jsonl.gz'
    ]);
    expect(fs.readFileSync(path.join(to.record('fights', 'festus'), '0001.jsonl.gz'), 'utf8')).toBe(
      'gz bytes'
    );
  });

  it('leaves the password out unless asked, and says it must be typed', async () => {
    const result = await importCharacter(to, await exported(false), {
      maxBytes: MAX,
      taken: () => false
    });
    expect(fs.readFileSync(to.profile('festus').file, 'utf8')).not.toContain('hunter2');
    expect(fs.readFileSync(to.profile('festus').file, 'utf8')).toContain('username: soul');
    expect(result.kind === 'imported' && result.notes.length).toBe(2);
  });

  it('never overwrites: a taken id gets a free one, a same-named realm is used as it is', async () => {
    put(to.profile('festus').file, 'name: Someone else\nserver: Paradigm\n');
    put(to.server('mine').file, 'name: Paradigm\nhost: here.test\nport: 23\n');
    const result = await importCharacter(to, await exported(true), {
      maxBytes: MAX,
      taken: () => false
    });
    expect(result).toMatchObject({ kind: 'imported', id: 'festus-2' });
    expect(fs.readFileSync(to.profile('festus').file, 'utf8')).toContain('Someone else');
    expect(fs.existsSync(to.record('memory', 'festus-2'))).toBe(true);
    expect(fs.existsSync(to.server('paradigm').dir)).toBe(false);
  });

  it('counts a loaded character as taken even with no file', async () => {
    const result = await importCharacter(to, await exported(true), {
      maxBytes: MAX,
      taken: (id) => id === 'festus'
    });
    expect(result).toMatchObject({ kind: 'imported', id: 'festus-2' });
  });

  it('is a tarball that tar itself lists', async () => {
    const file = path.join(dirs[0] ?? '', 'out.tar.gz');
    fs.writeFileSync(file, await exported(false));
    const listed = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n');
    expect(listed).toEqual([
      'mudengine-character.json',
      'profiles/festus/profile.yaml',
      'profiles/festus/loops/sewers.yaml',
      'servers/paradigm/server.yaml',
      'memory/festus.json',
      'fights/festus/0001.folds.json',
      'fights/festus/0001.jsonl.gz'
    ]);
  });

  it('refuses a file with anything else in it, and writes nothing', async () => {
    const bytes = await packTarball([
      {
        name: 'mudengine-character.json',
        data: Buffer.from('{"format":"mudengine-character","character":"festus","realm":null}')
      },
      { name: 'profiles/festus/profile.yaml', data: Buffer.from(PROFILE) },
      { name: 'profiles/festus/../../escape.yaml', data: Buffer.from('x') }
    ]);
    const climbing = await packTarball([
      {
        name: 'mudengine-character.json',
        data: Buffer.from('{"format":"mudengine-character","character":"festus","realm":null}')
      },
      { name: 'profiles/festus/profile.yaml', data: Buffer.from(PROFILE) },
      { name: 'fights/festus/../../escape.yaml', data: Buffer.from('x') }
    ]);
    expect((await importCharacter(to, climbing, { maxBytes: MAX, taken: () => false })).kind).toBe(
      'refused'
    );
    const result = await importCharacter(to, bytes, { maxBytes: MAX, taken: () => false });
    expect(result.kind).toBe('refused');
    expect(fs.existsSync(to.profilesDir)).toBe(false);
  });

  it('takes back the files and directories of a failed import, so a retry keeps the id', async () => {
    // A file where the memory directory goes: the realm is written, then this fails.
    put(path.join(to.root, 'memory'), 'in the way');
    const failed = await importCharacter(to, await exported(true), {
      maxBytes: MAX,
      taken: () => false
    });
    expect(failed.kind).toBe('refused');
    expect(fs.existsSync(to.serversDir)).toBe(false);
    fs.rmSync(path.join(to.root, 'memory'));
    const retried = await importCharacter(to, await exported(true), {
      maxBytes: MAX,
      taken: () => false
    });
    expect(retried).toMatchObject({ kind: 'imported', id: 'festus' });
  });

  it('refuses what is not a tarball at all', async () => {
    const result = await importCharacter(to, Buffer.from('hello'), {
      maxBytes: MAX,
      taken: () => false
    });
    expect(result.kind).toBe('refused');
  });
});
