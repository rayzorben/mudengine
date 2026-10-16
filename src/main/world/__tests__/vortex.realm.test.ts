import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { buildRealm } from '../buildRealm';
import { openRealm } from '../RealmSource';
import { WorldGraph } from '../WorldGraph';

/**
 * Todo 145 on orohost's world database (gmud.zip), with the shipped
 * `movement.keepOutOf`: a level 30 character carrying a token of Silvermere
 * in the Black Wasteland (3/740) routes to the Hazy Swamp vortex (3/782).
 * Skips where the archive is absent.
 */
const archive = path.resolve('mdb/gmud.zip');
const available = fs.existsSync(archive);
let dir = '';
let world: WorldGraph | null = null;

beforeAll(() => {
  if (!available) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-vortex-'));
  const source = openRealm(archive);
  try {
    const built = buildRealm(source, '2026-10-16');
    const file = path.join(dir, 'gmud.jsonl.gz');
    fs.writeFileSync(
      file,
      zlib.gzipSync([JSON.stringify(built.header), ...built.lines].join('\n') + '\n')
    );
    world = WorldGraph.load(file);
  } finally {
    source.close();
  }
}, 120_000);

afterAll(() => {
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!available)('the Black Wasteland on gmud.zip', () => {
  const keepOut = { words: ['vortex', 'Negative Power Plane'] };
  const traveller = () => ({
    level: 30,
    keys: [world!.itemIdNamed('token of Silvermere')!],
    packKnown: true,
    keepOut
  });

  it('walks the wasteland to the vortex at 3/756, whoever reads the route', () => {
    for (const alternatives of [false, true]) {
      const route = world!.route('3/740', '3/782', traveller(), { alternatives });
      expect(route.steps).toHaveLength(15);
      expect(route.steps.at(-1)).toMatchObject({ from: '3/756', to: '3/782' });
      expect(route.steps.some((step) => step.invoke !== undefined)).toBe(false);
      expect(route.keptOut).toBeUndefined();
    }
  });

  it('still asks before a walk from the Pillaged Museum goes into it', () => {
    const refused = world!.route('3/613', '3/669', traveller());
    expect(refused.blocked).toBe(true);
    expect(refused.blocks?.some((block) => block.kind === 'keptOut')).toBe(true);
    const read = world!.route('3/613', '3/669', traveller(), { alternatives: true });
    expect(read.steps).toHaveLength(1);
    expect(read.keptOut?.words).toEqual(['vortex']);
    expect(read.keptOut?.round.blocked).toBe(true);
  });
});
