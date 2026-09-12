import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// @ts-expect-error -- scripts/ is untyped by design; see scripts/lib/register.mjs
import { localProfiles } from '../../../../scripts/lib/local-realm.mjs';

/*
 * The probes resolve a character the way the client does, loops included.
 *
 * `resolveProfile` cannot read a directory, so the helper has to fold
 * `global/loops/`, `servers/<id>/loops/` and `profiles/<id>/loops/` in itself
 * — and for as long as it did not, every probe saw a character with no loops
 * and `play-probe`'s loop branch never ran (todo 02, 2026-09-12). One
 * regression: a character with a loop file on disk resolves with it.
 */
describe('a probe resolves a character with its loops', () => {
  let root: string;

  const write = (file: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body, 'utf8');
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-probe-loops-'));
    write('global/default.yaml', 'connection:\n  encoding: cp437\n');
    write('servers/test/server.yaml', 'name: Test Realm\nhost: orohost\nport: 2427\n');
    write(
      'profiles/vaelor/profile.yaml',
      'server: Test Realm\naccount:\n  username: vaelor\n  password: secret\n'
    );
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('folds the three loop directories in, narrowest winning by name', () => {
    write(
      'global/loops/everyone.yaml',
      "name: Everyone\nstops: ['Town Gates 1/2150', 'Newhaven, Arena']\n"
    );
    write(
      'servers/test/loops/realm.yaml',
      "name: Realm\nstops: ['Town Gates 1/2150', 'Newhaven, Arena']\n"
    );
    // The same name as the server's: the character's own is the one it walks.
    write(
      'profiles/vaelor/loops/realm.yaml',
      "name: Realm\nstops: ['Dank Chamber 7/1237', 'Small Room 7/1241']\n"
    );
    write(
      'profiles/vaelor/loops/mutants.yaml',
      "name: Mutant Singles Loop\nstops: ['Dank Chamber 7/1237', 'Small Room 7/1241']\n"
    );

    const [profile] = localProfiles(root) as { config: { automation: { loops: unknown[] } } }[];
    expect(profile).toBeDefined();
    const loops = profile!.config.automation.loops as { name: string; stops: { room: string }[] }[];
    expect(loops.map((loop) => loop.name).sort()).toEqual([
      'Everyone',
      'Mutant Singles Loop',
      'Realm'
    ]);
    // Normalised, not raw: a stop is `{ room }`, never the bare string the file wrote.
    expect(loops.find((loop) => loop.name === 'Realm')?.stops[0]).toEqual({
      room: 'Dank Chamber 7/1237'
    });
  });

  it('resolves a character with no loop files to no loops, as before', () => {
    const [profile] = localProfiles(root) as { config: { automation: { loops: unknown[] } } }[];
    expect(profile?.config.automation.loops).toEqual([]);
  });
});
