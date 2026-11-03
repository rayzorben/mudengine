import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { buildRealm } from '../buildRealm';
import { openRealm } from '../RealmSource';
import { WorldGraph } from '../WorldGraph';

/**
 * The engine's breadth-first sweep (`navigation/sweep.ts`) on the two world
 * databases in `mdb/`, against answers measured before it replaced the
 * searches written by hand in `withinSteps` and `WorldGraph.searchMobRow`
 * (2026-11-03). Each figure is a digest of every answer over a fixed sample of
 * rooms, so a change in any one of them fails. Skips where an archive is
 * absent. The timed-passage sweep (`corridorFrom`) finds the two dives into
 * the Muddy Underwater Passage in both, once `drowning`'s `DamageNoMR 0` is
 * read as its 5–20 roll (2026-11-03). A traveller whose bar is unread finds a
 * room command's one-off hit a wall (`Router.hitCost`), so 10 of the 1,704
 * sampled sweeps reach fewer rooms: 196 between them, behind the pyramid pits,
 * the flaming portals, a tentacle hole and the roof at 8/758 (2026-11-03).
 */
const MEASURED = {
  gmud: {
    within: '4df39121086b6a3a',
    rows: { asked: 1638, resolved: 388, digest: 'f00dfbd2f8e0ad8a' }
  },
  pmud: {
    within: '4efdaccdf6aea77c',
    rows: { asked: 1832, resolved: 451, digest: '44bd251f9ba47d49' }
  }
} as const;

const worlds = new Map<string, WorldGraph>();
let dir = '';

const archives = Object.keys(MEASURED).filter((name) => fs.existsSync(`mdb/${name}.zip`));

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-sweeps-'));
  for (const name of archives) {
    const source = openRealm(path.resolve(`mdb/${name}.zip`));
    try {
      const built = buildRealm(source, '2026-11-03');
      const file = path.join(dir, `${name}.jsonl.gz`);
      fs.writeFileSync(
        file,
        zlib.gzipSync([JSON.stringify(built.header), ...built.lines].join('\n') + '\n')
      );
      worlds.set(name, WorldGraph.load(file));
    } finally {
      source.close();
    }
  }
}, 240_000);

afterAll(() => {
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

const roomsOf = (world: WorldGraph): string[] =>
  [...world.everyRoom()].map((room) => `${room.map}/${room.room}`);

describe.each(archives)('the sweeps on %s', (name) => {
  const measured = MEASURED[name as keyof typeof MEASURED];

  it('reaches the same rooms within twelve moves, for nobody and for two travellers', () => {
    const world = worlds.get(name)!;
    const hash = crypto.createHash('sha256');
    for (const at of roomsOf(world).filter((_, i) => i % 200 === 0)) {
      for (const traveller of [undefined, {}, { level: 5 }]) {
        const got = world.withinSteps(at, 12, traveller);
        hash.update(`${at}|${JSON.stringify([...got].sort())}\n`);
      }
    }
    expect(hash.digest('hex').slice(0, 16)).toBe(measured.within);
  });

  it('puts the oasis pool and well dives under holding breath, and nothing else', () => {
    const world = worlds.get(name)!;
    const passages = roomsOf(world).flatMap((at) =>
      world.portalsFrom(at).flatMap((way) => {
        const corridor = way.requirement.corridor;
        return corridor === undefined ? [] : [{ at, to: `${way.map}/${way.room}`, ...corridor }];
      })
    );
    const dive = { spell: 512, name: 'holding breath', rooms: 11, ends: true, ticks: 25 };
    expect(passages).toEqual([
      { at: '12/73', to: '12/121', ...dive, then: 'drowning' },
      { at: '12/118', to: '12/131', ...dive, then: 'drowning' }
    ]);
    const under = roomsOf(world).filter((at) => world.spellOver(at) !== null);
    expect(under.sort()).toEqual(
      Array.from({ length: 11 }, (_, index) => `12/${121 + index}`).sort()
    );
    // The way through costs its eleven rooms on top of the steps.
    const route = world.route('12/73', '12/118', {});
    expect(route.blocked).toBe(false);
    expect(route.hazards).toContainEqual(
      expect.objectContaining({ spell: 'holding breath', corridor: expect.anything() })
    );
  });

  it('resolves a shared monster name to the same row from the same rooms', () => {
    const world = worlds.get(name)!;
    const names = world
      .mobNames()
      .filter((mob) => (world.mobAsPrinted(mob)?.ids?.length ?? 0) >= 2);
    const answers: string[] = [];
    let asked = 0;
    for (const mob of names) {
      for (const at of roomsOf(world).filter((_, i) => i % 8000 === 0)) {
        asked += 1;
        const choice = world.resolveMobRow(mob, at);
        if (choice !== null) answers.push(`${mob}@${at}=${JSON.stringify(choice)}`);
      }
    }
    const digest = crypto.createHash('sha256').update(answers.sort().join('\n')).digest('hex');
    expect({ asked, resolved: answers.length, digest: digest.slice(0, 16) }).toEqual(measured.rows);
  }, 60_000);
});
