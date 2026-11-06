import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import yaml from 'yaml';

import type { FightOdds, RoomId } from '../../../shared/world';
import type { NavigationOracle } from '../../../shared/navigation';
import { lapLegs } from '../loopDraft';
import { fightKey, lapFunctions, plainTraveller, planLapLegs, type LapLegsAsk } from '../lapLegs';
import { LapPlanner, planningLegs, type LapLegPlanner } from '../LapPlanner';
import { leg } from '../navigation/plan';
import { planRealmOf } from '../navigation/realm';
import type { Traveller } from '../Router';
import { WorldGraph } from '../WorldGraph';
import { worldOf } from './realmFile';
import { asLoops } from '../../../shared/loops';

/** A corridor of `count` rooms on map 1, joined both ways. */
function corridor(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    m: 1,
    r: i + 1,
    n: `Room ${i + 1}`,
    x: {
      ...(i > 0 ? { w: { m: 1, r: i } } : {}),
      ...(i + 1 < count ? { e: { m: 1, r: i + 2 } } : {})
    }
  }));
}

const purse = { charm: null, wealth: null, banks: [] };
const askOf = (legs: Array<[RoomId, RoomId]>, fights = {}): LapLegsAsk => ({
  traveller: {},
  purse,
  fights,
  legs
});

describe('a lap traveller as plain data', () => {
  it('keeps every field a structured clone carries and drops the functions', () => {
    const traveller: Traveller = {
      level: 7,
      refused: new Set(['1/1|n']),
      keys: [3],
      hazard: () => 1,
      shareOfHealth: () => 0,
      lairDamage: () => 2
    };
    const plain = plainTraveller(traveller);
    expect(plain).toEqual({ level: 7, refused: new Set(['1/1|n']), keys: [3] });
    expect(() => structuredClone(plain)).not.toThrow();
  });

  it('is given back the two functions a lap leg reads', () => {
    const rebuilt = lapFunctions(undefined, { level: 3 });
    expect(rebuilt.shareOfHealth?.(10)).toBe(0);
    expect(typeof rebuilt.hazard).toBe('function');
  });
});

describe('a batch of lap legs', () => {
  it("names each leg's rooms as the plan walks them", () => {
    const world = worldOf(corridor(4));
    const answer = planLapLegs(
      world,
      askOf([
        ['1/1', '1/3'],
        ['1/4', '1/2']
      ])
    );
    expect(answer.rooms).toEqual([
      ['1/1', '1/2', '1/2', '1/3'],
      ['1/4', '1/3', '1/3', '1/2']
    ]);
    expect(answer).toMatchObject({ asked: [], unsure: [] });
  });
});

describe('the batches a lap index plans', () => {
  const planners: LapPlanner[] = [];
  afterEach(() => {
    for (const planner of planners.splice(0)) planner.dispose();
  });

  it('looks up the fights a batch asked and plans those legs again with them', async () => {
    const asks: LapLegsAsk[] = [];
    // Leg 1 asks about an orc until the table holds it; leg 0 never asks.
    const planner: LapLegPlanner = {
      plan: (_file, _world, ask) => {
        asks.push(ask);
        const known = ask.fights[fightKey({ monster: 'orc', room: '1/2' })] !== undefined;
        const second = ask.legs.length > 1 ? 1 : 0;
        return Promise.resolve({
          rooms: ask.legs.map(([from, to]) => [from, known ? 'after' : 'before', to]),
          asked: known ? [] : [{ monster: 'orc', room: '1/2' }],
          unsure: known ? [] : [second]
        });
      }
    };
    const fight = vi.fn((): FightOdds => ({ kind: 'win', survives: 0.9 }));
    const plan = planningLegs(planner, null, worldOf(corridor(2)), { traveller: {}, purse }, fight);
    const rooms = await plan([
      ['a', 'b'],
      ['c', 'd']
    ]);
    expect(rooms).toEqual([
      ['a', 'before', 'b'],
      ['c', 'after', 'd']
    ]);
    expect(fight).toHaveBeenCalledTimes(1);
    expect(asks.map((ask) => ask.legs)).toEqual([
      [
        ['a', 'b'],
        ['c', 'd']
      ],
      [['c', 'd']]
    ]);
  });

  it('plans on main where the realm has no file, and from a worker where it has', async () => {
    const world = worldOf(corridor(3));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-lap-'));
    const echo = path.join(dir, 'echo.mjs');
    fs.writeFileSync(
      echo,
      "import { parentPort } from 'node:worker_threads';\n" +
        'parentPort.on(\'message\', (m) => parentPort.postMessage({ id: m.id, kind: "lap", answer: { rooms: m.ask.legs.map(() => ["from the worker"]), asked: [], unsure: [] } }));\n'
    );
    const said: string[] = [];
    const planner = new LapPlanner(echo, (message) => said.push(message));
    planners.push(planner);
    const onMain = await planner.plan(null, world, askOf([['1/1', '1/3']]));
    expect(onMain.rooms).toEqual([['1/1', '1/2', '1/2', '1/3']]);
    const fromWorker = await planner.plan('a realm file', world, askOf([['1/1', '1/3']]));
    expect(fromWorker.rooms).toEqual([['from the worker']]);
    expect(said).toEqual([]);
  });

  it('answers a batch still out with no rooms at quit, and plans nothing after', async () => {
    const world = worldOf(corridor(3));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-lap-'));
    const silent = path.join(dir, 'silent.mjs');
    fs.writeFileSync(
      silent,
      "import { parentPort } from 'node:worker_threads';\nparentPort.on('message', () => {});\n"
    );
    const planner = new LapPlanner(silent, () => undefined);
    const out = planner.plan('a realm file', world, askOf([['1/1', '1/3']]));
    planner.dispose();
    expect((await out).rooms).toEqual([[]]);
    expect((await planner.plan(null, world, askOf([['1/1', '1/3']]))).rooms).toEqual([[]]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('plans on main once the worker fails, saying so once', async () => {
    const world = worldOf(corridor(3));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-lap-'));
    const dying = path.join(dir, 'dies.mjs');
    fs.writeFileSync(
      dying,
      "import { parentPort } from 'node:worker_threads';\n" +
        "parentPort.on('message', () => { throw new Error('worker fell over'); });\n"
    );
    const said: string[] = [];
    const planner = new LapPlanner(dying, (message) => said.push(message));
    planners.push(planner);
    const first = await planner.plan('a realm file', world, askOf([['1/1', '1/3']]));
    const second = await planner.plan('a realm file', world, askOf([['1/3', '1/1']]));
    expect(first.rooms).toEqual([['1/1', '1/2', '1/2', '1/3']]);
    expect(second.rooms).toEqual([['1/3', '1/2', '1/2', '1/1']]);
    expect(said).toHaveLength(1);
  });
});

/*
 * On the realm that ships: planning through the table of fights a batch
 * asked, and again until it asks nothing new, walks the rooms planning with
 * the oracle itself walks, for the shelf's first loops.
 */
const realmFile = path.resolve('resources/world/paradigm.jsonl.gz');
const shelfFile = path.resolve('resources/loops/megamud.yaml');
const graph = fs.existsSync(realmFile) ? WorldGraph.load(realmFile) : null;

describe.skipIf(graph === null || !fs.existsSync(shelfFile))(
  'the shelf on the shipped realm',
  () => {
    it('walks the rooms the oracle itself walks', async () => {
      const world = graph!;
      const loops = asLoops(
        (yaml.parse(fs.readFileSync(shelfFile, 'utf8')) as { loops: unknown }).loops
      );
      const resolve = (stop: { at: { map: number; room: number } | null }) =>
        stop.at === null ? null : `${stop.at.map}/${stop.at.room}`;
      const legs = loops
        .slice(0, 40)
        .flatMap((loop) => lapLegs(loop, resolve) ?? [])
        .slice(0, 120);
      // A fight's odds that depend on the monster, so a table with the wrong answer would show.
      const fight = (monster: string): FightOdds =>
        monster.length % 2 === 0 ? { kind: 'win', survives: 0.9 } : { kind: 'lose', survives: 0.2 };
      const plain = { level: 30, strength: 60, keys: [], packKnown: true };
      const traveller: Traveller = { ...plain, ...lapFunctions(world, plain) };
      const oracle: NavigationOracle = { fight: (monster) => fight(monster), affords: () => null };
      const looked = vi.fn((asked: { monster: string }) => fight(asked.monster));
      const direct = legs.map(([from, to]) =>
        leg(planRealmOf(world), oracle, from, to, traveller).steps.flatMap((step) => [
          step.from,
          step.to
        ])
      );
      const inProcess: LapLegPlanner = {
        plan: (_file, on, ask) => Promise.resolve(planLapLegs(on, ask))
      };
      const planned = await planningLegs(
        inProcess,
        null,
        world,
        { traveller: plain, purse },
        looked
      )(legs);
      expect(legs.length).toBeGreaterThan(50);
      // Positive control: some leg on the way asked about a fight, so the table was used.
      expect(looked.mock.calls.length).toBeGreaterThan(0);
      expect(planned).toEqual(direct);
    });
  }
);
