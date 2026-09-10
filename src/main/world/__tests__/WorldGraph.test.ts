import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { WorldGraph, dangerPenalty, edgeBlock, edgePenalty } from '../WorldGraph';
import type { Traveller } from '../WorldGraph';
import type { Requirement, RouteBlock, WorldRoom } from '../../../shared/world';
import {
  REQUIREMENT_KINDS,
  ROUTE_BLOCK_KINDS,
  describeBlock,
  hazardAvoided,
  lairsAlong
} from '../../../shared/world';
import { roomId } from '../../../shared/world';
import { questLevel } from '../../../shared/quests';

/** Writes a throwaway world file in the format `build-world.mjs` emits. */
function makeWorld(
  rooms: Array<Record<string, unknown>>,
  mobs?: Array<Record<string, unknown>> | Record<string, unknown>,
  version?: number
): WorldGraph {
  // Either the mob table on its own -- which is what nearly every case here
  // wants -- or a whole header, for the ones that need the item and spell
  // indexes beside it.
  const tables = Array.isArray(mobs) ? { mobs } : (mobs ?? {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-world-'));
  const file = path.join(dir, 'rooms.jsonl.gz');
  const header = JSON.stringify({
    v: version ?? (mobs ? 3 : 1),
    source: 'test',
    rooms: rooms.length,
    generatedAt: 'x',
    ...tables
  });
  const body = [header, ...rooms.map((r) => JSON.stringify(r))].join('\n') + '\n';
  fs.writeFileSync(file, zlib.gzipSync(body));
  const graph = WorldGraph.load(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return graph;
}

/** A corridor of `count` rooms on map 1, each linked east to the next. */
function corridor(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    m: 1,
    r: i + 1,
    n: `Room ${i + 1}`,
    x: i + 1 < count ? { e: { m: 1, r: i + 2 } } : {}
  }));
}

describe('loading', () => {
  it('reads the header and indexes rooms by id', () => {
    const graph = makeWorld(corridor(3));
    expect(graph.size).toBe(3);
    expect(graph.info.source).toBe('test');
    expect(graph.get(1, 2)?.name).toBe('Room 2');
  });

  it('returns an empty graph for a missing file rather than throwing', () => {
    // The app must start even if the world data was never built.
    expect(WorldGraph.load('/nonexistent/rooms.jsonl.gz').size).toBe(0);
  });

  it('skips a malformed line instead of losing the realm', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-world-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const body = [
      JSON.stringify({ v: 1, source: 'test', rooms: 2, generatedAt: 'x' }),
      '{ not json',
      JSON.stringify({ m: 1, r: 1, n: 'Fine', x: {} })
    ].join('\n');
    fs.writeFileSync(file, zlib.gzipSync(body));
    expect(WorldGraph.load(file).size).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses exit instructions on load', () => {
    const graph = makeWorld([
      { m: 1, r: 1, n: 'A', x: { w: { m: 1, r: 2, i: 'Door [1000 picklocks/strength]' } } },
      { m: 1, r: 2, n: 'B', x: {} }
    ]);
    expect(graph.get(1, 1)?.exits[0]?.requirement).toMatchObject({
      kind: 'door',
      pickDifficulty: 1000
    });
  });
});

describe('name lookup', () => {
  const graph = makeWorld([
    { m: 1, r: 1, n: 'Mossy Tunnel', x: {} },
    { m: 2, r: 5, n: 'Mossy Tunnel', x: {} },
    { m: 1, r: 9, n: 'Bank of Godfrey', x: {} }
  ]);

  it('returns every room bearing a repeated name', () => {
    // Names are far from unique; this is the whole reason room resolution is
    // hard, and a lookup that returned one would silently pick wrong.
    expect(graph.findByName('Mossy Tunnel')).toHaveLength(2);
  });

  it('matches case-insensitively', () => {
    expect(graph.findByName('bank of godfrey')).toHaveLength(1);
  });

  it('searches by substring, capped', () => {
    expect(graph.searchByName('mossy')).toHaveLength(2);
    expect(graph.searchByName('godfrey')[0]?.room).toBe(9);
    expect(graph.searchByName('')).toEqual([]);
  });
});

describe('edgePenalty', () => {
  it('charges nothing for a Text exit, which is a command not an obstacle', () => {
    expect(edgePenalty({ kind: 'text', raw: 'Text: go path' }, {})).toBe(0);
  });

  it('charges for a door', () => {
    expect(edgePenalty({ kind: 'door', raw: 'Door' }, {})).toBeGreaterThan(0);
  });

  /*
   * And only once somebody has looked. `Traveller.keys` went unset from the
   * day it was written until todo 00 (2026-09-06), so this pruned every keyed
   * door in the realm on an answer nobody had asked for — the question and the
   * silence looked identical. `packKnown` is the difference.
   */
  it('prunes a keyed door when the listed pack has no key and it cannot be picked', () => {
    const req = { kind: 'key' as const, raw: 'Key: 1124', keyId: 1124 };
    expect(edgePenalty(req, { keys: [], packKnown: true })).toBeNull();
  });

  it('only discourages the same door while nobody has listed the pack', () => {
    const req = { kind: 'key' as const, raw: 'Key: 1124', keyId: 1124 };
    expect(edgePenalty(req, {})).toBe(60);
    expect(edgeBlock(req, {})).toBeNull();
  });

  it('allows a keyed door when the key is carried', () => {
    const req = { kind: 'key' as const, raw: 'Key: 1124', keyId: 1124 };
    expect(edgePenalty(req, { keys: [1124] })).toBe(4);
  });

  it('allows a keyed door the character can pick, at a price', () => {
    const req = {
      kind: 'key' as const,
      raw: 'Key: 1124 [or 301 picklocks/strength]',
      keyId: 1124,
      pickDifficulty: 301
    };
    // Above the minimum but not far: dearer than a plain forced door, nowhere
    // near a wall. Far below it: a wall, and still a number — when there is
    // no other way, it is the way.
    const price = edgePenalty(req, { pickSkill: 400 })!;
    expect(price).toBeGreaterThan(30);
    expect(price).toBeLessThan(1000);
    expect(edgePenalty(req, { pickSkill: 2000 })).toBe(30);
    expect(edgePenalty(req, { pickSkill: 10 })!).toBeGreaterThan(100_000);
  });

  it('prunes a level-gated exit outside the range', () => {
    const req = { kind: 'level' as const, raw: 'Level: 10 to 999', minLevel: 10, maxLevel: 999 };
    expect(edgePenalty(req, { level: 4 })).toBeNull();
    expect(edgePenalty(req, { level: 20 })).toBe(0);
  });

  it('does not prune a level gate for an unknown level, but discourages it', () => {
    // Refusing to route because we have not seen a stat sheet yet would make
    // the feature useless in exactly the situation it is most wanted.
    const req = { kind: 'level' as const, raw: 'Level: 10 to 999', minLevel: 10, maxLevel: 999 };
    expect(edgePenalty(req, { level: null })).toBeGreaterThan(0);
  });

  /* A gate whose price the realm did not record: all that can be said without
     a number is whether the character has anything at all. */
  it('prunes a priceless toll only when the traveller is known to be broke', () => {
    const req = { kind: 'toll' as const, raw: 'Toll' };
    expect(edgePenalty(req, { wealth: 0 })).toBeNull();
    expect(edgePenalty(req, { wealth: 500 })).toBeGreaterThan(0);
    expect(edgePenalty(req, {})).toBeGreaterThan(0);
  });

  /*
   * The reported failure, as an assertion.
   *
   * `Toll: 5` is 5 *gold* — 500 copper — and a character holding 499 cannot
   * pass. Routing one through anyway is what walked a penniless character into
   * the Town Gates over and over, and the refusal it produced went unread.
   */
  it('prunes a priced toll the purse cannot cover', () => {
    const req = { kind: 'toll' as const, raw: 'Toll: 5', tollCopper: 500 };
    expect(edgePenalty(req, { wealth: 0 })).toBeNull();
    expect(edgePenalty(req, { wealth: 499 })).toBeNull();
    expect(edgePenalty(req, { wealth: 500 })).toBeGreaterThan(0);
    expect(edgeBlock(req, { wealth: 0 })?.kind).toBe('toll');
    expect(edgeBlock(req, { wealth: 499 })?.kind).toBe('toll');
    expect(edgeBlock(req, { wealth: 500 })).toBeNull();
  });

  /*
   * Unknown never blocks. Nobody having listed the purse is not the same as an
   * empty one, and refusing to route on it would strand every character whose
   * inventory has not arrived yet — the reassuring answer is only dangerous
   * when it permits harm, and this one merely permits a walk.
   */
  it('does not block a priced toll on a purse nobody has stated', () => {
    const req = { kind: 'toll' as const, raw: 'Toll: 5', tollCopper: 500 };
    expect(edgeBlock(req, {})).toBeNull();
    expect(edgeBlock(req, { wealth: null })).toBeNull();
    expect(edgePenalty(req, {})).toBeGreaterThan(0);
  });

  /* `Toll: 0` is a gate that charges nothing, which anybody can pass. */
  it('lets anybody through a toll that charges nothing', () => {
    const req = { kind: 'toll' as const, raw: 'Toll: 0', tollCopper: 0 };
    expect(edgeBlock(req, { wealth: 0 })).toBeNull();
    expect(edgePenalty(req, { wealth: 0 })).toBeGreaterThan(0);
  });

  it('prefers a searchable hidden exit over one needing unknown actions', () => {
    const searchable = { kind: 'hidden' as const, raw: 'Hidden/Searchable', searchable: true };
    const opaque = { kind: 'hidden' as const, raw: 'Hidden/Needs 2 Actions', searchable: false };
    expect(edgePenalty(searchable, {})!).toBeLessThan(edgePenalty(opaque, {})!);
  });

  /*
   * The other kind of hidden exit, once the levers are read — todo 01.
   *
   * A passage this room can open costs the commands, exactly as a searchable
   * one costs the search: `Walker.pullLevers` sends them, so the route is
   * priced through it rather than around it. 150 of the shipped realm's gated
   * exits are that shape.
   */
  it('prices a hidden exit this room can open like a search', () => {
    const here = {
      kind: 'hidden' as const,
      raw: 'Hidden/Needs 1 Actions, any order',
      searchable: false,
      actionsNeeded: 1,
      actions: [{ say: ['pull lever'] }]
    };
    const opaque = { kind: 'hidden' as const, raw: 'Hidden/Needs 2 Actions', searchable: false };
    expect(edgePenalty(here, {})!).toBeLessThan(edgePenalty(opaque, {})!);
    expect(edgePenalty(here, {})!).toBeGreaterThanOrEqual(25);
  });

  /* A lever two rooms away is a detour this planner does not plan, so nothing
     about the price changes — only what the client can now *say* about it. */
  it('leaves a hidden exit whose lever is elsewhere priced as it was', () => {
    const away = {
      kind: 'hidden' as const,
      raw: 'Hidden/Needs 1 Actions, any order',
      searchable: false,
      actionsNeeded: 1,
      actions: [{ say: ['pull lever'], at: { map: 1, room: 1339 } }]
    };
    const opaque = { kind: 'hidden' as const, raw: 'Hidden/Needs 1 Actions', searchable: false };
    expect(edgePenalty(away, {})).toBe(edgePenalty(opaque, {}));
  });

  it('scales a trap with its damage', () => {
    const light = { kind: 'trap' as const, raw: 'Trap, 5 damage', damage: 5 };
    const heavy = { kind: 'trap' as const, raw: 'Trap, 90 damage', damage: 90 };
    expect(edgePenalty(heavy, {})!).toBeGreaterThan(edgePenalty(light, {})!);
  });

  it('never returns a negative penalty', () => {
    // The original A* charged -500 for a door, which makes the search prefer
    // doors and breaks admissibility. That is not reproduced.
    const kinds = ['door', 'key', 'level', 'toll', 'text', 'item', 'trap', 'hidden', 'unknown'];
    for (const kind of kinds) {
      const penalty = edgePenalty({ kind: kind as never, raw: kind }, { keys: [], level: 10 });
      if (penalty !== null) expect(penalty, kind).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('routing', () => {
  it('walks a corridor', () => {
    const graph = makeWorld(corridor(5));
    const route = graph.route('1/1', '1/5');
    expect(route.blocked).toBe(false);
    expect(route.steps).toHaveLength(4);
    expect(route.steps.map((s) => s.command)).toEqual(['e', 'e', 'e', 'e']);
    expect(route.steps.at(-1)?.name).toBe('Room 5');
  });

  it('returns an empty route for start === goal', () => {
    const graph = makeWorld(corridor(3));
    expect(graph.route('1/1', '1/1')).toMatchObject({ blocked: false, steps: [] });
  });

  it('reports an unknown start or destination rather than hanging', () => {
    const graph = makeWorld(corridor(3));
    expect(graph.route('9/9', '1/1').blocked).toBe(true);
    expect(graph.route('1/1', '9/9').reason).toMatch(/Unknown destination/);
  });

  it('reports no route when none exists', () => {
    const graph = makeWorld([
      { m: 1, r: 1, n: 'A', x: {} },
      { m: 1, r: 2, n: 'B', x: {} }
    ]);
    expect(graph.route('1/1', '1/2')).toMatchObject({ blocked: true });
  });

  it('prefers a longer clear path over a shorter one through a door', () => {
    // The point of instruction-aware costs: a door is worth a dozen rooms.
    const graph = makeWorld([
      { m: 1, r: 1, n: 'Start', x: { e: { m: 1, r: 2, i: 'Door' }, n: { m: 1, r: 10 } } },
      { m: 1, r: 2, n: 'Goal', x: {} },
      { m: 1, r: 10, n: 'Long A', x: { e: { m: 1, r: 11 } } },
      { m: 1, r: 11, n: 'Long B', x: { e: { m: 1, r: 12 } } },
      { m: 1, r: 12, n: 'Long C', x: { s: { m: 1, r: 2 } } }
    ]);
    const route = graph.route('1/1', '1/2');
    expect(route.steps).toHaveLength(4);
    expect(route.steps[0]?.direction).toBe('n');
  });

  it('takes the door when the detour is long enough', () => {
    const graph = makeWorld([
      { m: 1, r: 1, n: 'Start', x: { e: { m: 1, r: 2, i: 'Door' } } },
      { m: 1, r: 2, n: 'Goal', x: {} }
    ]);
    const route = graph.route('1/1', '1/2');
    expect(route.steps).toHaveLength(1);
    expect(route.steps[0]?.requirement?.kind).toBe('door');
  });

  it('emits the Text command instead of the direction', () => {
    // A route that emits `w` at one of these does not work.
    const graph = makeWorld([
      {
        m: 11,
        r: 1,
        n: 'Portal Room',
        x: { w: { m: 11, r: 35, i: 'Text: go crimson, enter crimson' } }
      },
      { m: 11, r: 35, n: 'Crimson Hall', x: {} }
    ]);
    const route = graph.route('11/1', '11/35');
    expect(route.steps[0]?.command).toBe('go crimson');
    expect(route.steps[0]?.direction).toBe('w');
  });

  /**
   * A locked door beside a long way round. The detour is six rooms, which is
   * longer than a held key costs (4) but the only option without one.
   */
  const lockedDoorWorld = [
    { m: 1, r: 1, n: 'Start', x: { e: { m: 1, r: 2, i: 'Key: 99' }, n: { m: 1, r: 10 } } },
    { m: 1, r: 2, n: 'Goal', x: {} },
    { m: 1, r: 10, n: 'D1', x: { e: { m: 1, r: 11 } } },
    { m: 1, r: 11, n: 'D2', x: { e: { m: 1, r: 12 } } },
    { m: 1, r: 12, n: 'D3', x: { e: { m: 1, r: 13 } } },
    { m: 1, r: 13, n: 'D4', x: { e: { m: 1, r: 14 } } },
    { m: 1, r: 14, n: 'D5', x: { s: { m: 1, r: 2 } } }
  ];

  it('routes around an exit the character cannot pass', () => {
    const route = makeWorld(lockedDoorWorld).route('1/1', '1/2', { keys: [] });
    expect(route.blocked).toBe(false);
    expect(route.steps.map((s) => s.direction)).toEqual(['n', 'e', 'e', 'e', 'e', 's']);
  });

  it('goes straight through when the character holds the key', () => {
    const route = makeWorld(lockedDoorWorld).route('1/1', '1/2', { keys: [99] });
    expect(route.steps).toHaveLength(1);
    expect(route.steps[0]?.requirement?.kind).toBe('key');
  });

  it('still prefers a short clear path over a door it could open', () => {
    // Holding the key does not make the door free; two clear rooms beat it.
    const graph = makeWorld([
      { m: 1, r: 1, n: 'Start', x: { e: { m: 1, r: 2, i: 'Key: 99' }, n: { m: 1, r: 10 } } },
      { m: 1, r: 2, n: 'Goal', x: {} },
      { m: 1, r: 10, n: 'Detour', x: { e: { m: 1, r: 2 } } }
    ]);
    expect(graph.route('1/1', '1/2', { keys: [99] }).steps).toHaveLength(2);
  });

  it('ignores an exit pointing outside the dataset', () => {
    // A hole in the realm data is not a route; following it would produce a
    // step that cannot be walked.
    const graph = makeWorld([
      { m: 1, r: 1, n: 'Start', x: { e: { m: 99, r: 99 }, n: { m: 1, r: 2 } } },
      { m: 1, r: 2, n: 'Goal', x: {} }
    ]);
    expect(graph.route('1/1', '1/2').steps.map((s) => s.direction)).toEqual(['n']);
  });

  it('carries the requirement onto the step so the UI can explain it', () => {
    const graph = makeWorld([
      { m: 1, r: 1, n: 'Start', x: { e: { m: 1, r: 2, i: 'Trap, 30 damage' } } },
      { m: 1, r: 2, n: 'Goal', x: {} }
    ]);
    expect(graph.route('1/1', '1/2').steps[0]?.requirement).toMatchObject({
      kind: 'trap',
      damage: 30
    });
  });

  /*
   * A route the player saved is followed wherever it can be: its steps cost a
   * fraction of an ordinary one, so the long way round a saved route beats a
   * shortcut the player did not draw.
   */
  it('prefers the corridors of a saved route over a shorter way', () => {
    // 1 — 2 directly, or 1 — 3 — 4 — 2 the long way round.
    const graph = makeWorld([
      { m: 1, r: 1, n: 'A', x: { e: { m: 1, r: 2 }, s: { m: 1, r: 3 } } },
      { m: 1, r: 2, n: 'B', x: { w: { m: 1, r: 1 }, s: { m: 1, r: 4 } } },
      { m: 1, r: 3, n: 'C', x: { n: { m: 1, r: 1 }, e: { m: 1, r: 4 } } },
      { m: 1, r: 4, n: 'D', x: { n: { m: 1, r: 2 }, w: { m: 1, r: 3 } } }
    ]);
    expect(graph.route('1/1', '1/2').steps.map((s) => s.to)).toEqual(['1/2']);
    const preferred = new Set(['1/1|1/3', '1/3|1/4', '1/4|1/2']);
    expect(graph.route('1/1', '1/2', { preferred }).steps.map((s) => s.to)).toEqual([
      '1/3',
      '1/4',
      '1/2'
    ]);
    // And the preference is a discount, never a free pass through a refusal.
    const refused = new Set(['1/3|e']);
    expect(graph.route('1/1', '1/2', { preferred, refused }).steps.map((s) => s.to)).toEqual([
      '1/2'
    ]);
  });

  it('terminates on a cycle', () => {
    const graph = makeWorld([
      { m: 1, r: 1, n: 'A', x: { e: { m: 1, r: 2 } } },
      { m: 1, r: 2, n: 'B', x: { w: { m: 1, r: 1 } } }
    ]);
    expect(graph.route('1/1', '1/999').blocked).toBe(true);
  });
});

describe('the real realm data', () => {
  const file = path.resolve('resources/world/paradigm.jsonl.gz');
  const available = fs.existsSync(file);
  const graph = available ? WorldGraph.load(file) : null;

  it.runIf(available)('loads every room', () => {
    expect(graph!.size).toBeGreaterThan(50_000);
    expect(graph!.info.rooms).toBe(graph!.size);
  });

  it.runIf(available)('knows the room the live server put us in', () => {
    // Verified against gmud-tgs:2427: the client reported "Bank of Godfrey"
    // with exits north, east and a closed gate west.
    const room = graph!.get(1, 297);
    expect(room?.name).toBe('Bank of Godfrey');
    expect(room?.exits.map((e) => e.direction).sort()).toEqual(['e', 'n', 'w']);
    expect(room?.exits.find((e) => e.direction === 'w')?.requirement?.kind).toBe('door');
  });

  /*
   * todo 03, 2026-09-06: *"route from 1, 1377 to 1, 2260 took the wrong route
   * ... it tried to go east at 1, 1422 which is the wrong class, it should
   * have tried at 1, 1423."*
   *
   * The crypt is fifteen rooms all called `Crypt, Shadowed Hall` in a line,
   * whose east exits read `Class: 1 OK` through `Class: 15 OK` — one class
   * each. Priced as an unevaluable condition they all cost the same, so A*
   * took whichever lay first on the shortest path and the walk was answered
   * `You may not go through this exit!`.
   *
   * Against the shipped realm rather than a fixture, because the fixture that
   * would prove this *is* the realm: the maze, the class ids and the join from
   * `Class: Paladin` to row 3 are all in the file.
   */
  it.runIf(available)("walks a class-gated maze by the character's own class", () => {
    const paladin = graph!.classId('Paladin');
    expect(paladin).toBe(3);

    // The two doors the report names, as the realm states them.
    const wrong = graph!.get(1, 1422)?.exits.find((exit) => exit.direction === 'e');
    const right = graph!.get(1, 1423)?.exits.find((exit) => exit.direction === 'e');
    expect(wrong?.requirement?.classOk).toBe(6);
    expect(right?.requirement?.classOk).toBe(3);

    const route = graph!.route(roomId(1, 1377), roomId(1, 2260), { classId: paladin });
    expect(route.blocked).toBe(false);
    /*
     * The assertion that matters is not which way it went but that it never
     * steps through a door this class is refused at — a route checked only at
     * 1/1422 would pass while walking into `Class: 6 OK` two rooms further on.
     */
    for (const step of route.steps) {
      const gate = step.requirement;
      if (gate?.kind !== 'class') continue;
      expect(gate.classOk === undefined || gate.classOk === paladin).toBe(true);
      expect(gate.classNo).not.toBe(paladin);
    }
    // And it does take the one the report names, from the room it names.
    expect(
      route.steps.some((step) => step.from === roomId(1, 1423) && step.direction === 'e')
    ).toBe(true);
    expect(
      route.steps.some((step) => step.from === roomId(1, 1422) && step.direction === 'e')
    ).toBe(false);
  });

  /* And a character whose sheet nobody has read is still given a route: the
     gate is discouraged, never pruned, or an unread sheet would strand it. */
  it.runIf(available)('still routes a character whose class is unknown', () => {
    const route = graph!.route(roomId(1, 1377), roomId(1, 2260), {});
    expect(route.blocked).toBe(false);
    expect(route.steps.length).toBeGreaterThan(0);
  });

  /*
   * todo 00, 2026-09-06: the seven conditions todo 03 left at the flat
   * unevaluable price, each surveyed against both realm databases on this
   * machine and given whatever the data actually settles.
   *
   * This one is the survey itself, asserted rather than remembered: every
   * gated instruction the shipped realm holds is *read*, not merely
   * classified. A kind that parses to a kind and no numbers is a chip with
   * nothing in it and a price that cannot be computed, which is exactly the
   * state all seven were in.
   */
  it.runIf(available)('reads the numbers out of every gated instruction it ships', () => {
    const seen = new Map<string, number>();
    let unread = 0;
    for (const room of graph!.everyRoom()) {
      for (const exit of room.exits) {
        const gate = exit.requirement;
        if (!gate) continue;
        seen.set(gate.kind, (seen.get(gate.kind) ?? 0) + 1);
        const read =
          gate.kind === 'race'
            ? gate.raceOk !== undefined || gate.raceNo !== undefined
            : gate.kind === 'alignment'
              ? gate.minAlignment !== undefined
              : gate.kind === 'ability'
                ? // `Ability: 0` is the realm's empty slot; the id is dropped
                  // and the exit is plain, which is a reading and not a miss.
                  gate.abilityId !== undefined || gate.raw.startsWith('Ability: 0 ')
                : gate.kind === 'cast'
                  ? gate.spellEffect !== undefined || gate.raw === 'Cast: pre-0, post-0'
                  : gate.kind === 'spell'
                    ? gate.spellEffect !== undefined
                    : gate.kind === 'item'
                      ? gate.keyId !== undefined || gate.raw.endsWith(': 0')
                      : true;
        if (!read) unread += 1;
      }
    }
    expect(unread).toBe(0);
    // The survey, so a realm rebuilt from a different database that lost one of
    // these fails here rather than silently routing round a gate that is gone.
    expect(seen.get('race')).toBe(2);
    expect(seen.get('alignment')).toBe(14);
    expect(seen.get('ability')).toBe(9);
    expect(seen.get('cast')).toBe(293);
    expect(seen.get('spell')).toBe(22);
    expect(seen.get('timed')).toBe(1);
    expect(seen.get('item')).toBe(268);
  });

  /*
   * A cast exit never refuses anybody — and 217 of the 293 fire a teleport, so
   * the room the exit table names is not the room the character is standing in
   * a moment later.
   *
   * `8/1797 w` is one of the 108 `gloomy teleport` exits: the table says it
   * leads to 8/1806 and the spell rolls a room in 8/633–656. The old flat 60
   * priced that as a corridor with a nuisance on it.
   */
  it.runIf(available)('tells a cast exit that moves you from one that does not', () => {
    const scatter = graph!.get(8, 1797)?.exits.find((exit) => exit.direction === 'w');
    expect(scatter?.requirement?.raw).toBe('Cast: pre-0, post-1257');
    expect(scatter?.requirement?.spellEffect).toBe('relocates');
    expect(edgePenalty(scatter!.requirement, {})).toBe(100_000);

    // Every one of them, and every kind of them: the split is the realm's.
    const effects = new Map<string, number>();
    for (const room of graph!.everyRoom()) {
      for (const exit of room.exits) {
        if (exit.requirement?.kind !== 'cast') continue;
        effects.set(
          exit.requirement.spellEffect ?? 'none',
          (effects.get(exit.requirement.spellEffect ?? 'none') ?? 0) + 1
        );
      }
    }
    expect(effects.get('relocates')).toBe(217);
    expect(effects.get('script')).toBe(61);
    expect(effects.get('plain')).toBe(14);
    // `Cast: pre-0, post-0` names no spell, and the server builds a plain exit.
    expect(effects.get('none')).toBe(1);
  });

  /*
   * The chain, not the spell in front of you.
   *
   * `EndCast` hands the character *another* spell when this one ends, and two
   * of the shipped realm's cast exits carry a spell that says nothing at all
   * on its own: `timer` (685) is `EndCast 686`, and 686 is `pyramid 1
   * teleport` — a `TextBlock`, a realm script this client does not convert.
   * Read one row deep, both looked like plain corridors and cost nothing.
   *
   * And the other direction: `holding breath` ends in `drowning`, which does
   * damage — a character effect. Damage does not stop anybody arriving, so
   * that one is a corridor, and following the chain is what establishes it
   * rather than assuming it.
   */
  it('follows a spell that only names another spell', () => {
    const scripted = [...graph!.everyRoom()]
      .flatMap((room) => room.exits)
      .filter((exit) => exit.requirement?.castPre === 685 || exit.requirement?.castPre === 732);
    expect(scripted.length).toBeGreaterThan(0);
    for (const exit of scripted) expect(exit.requirement?.spellEffect).toBe('script');

    const breath = [...graph!.everyRoom()]
      .flatMap((room) => room.exits)
      .find((exit) => exit.requirement?.castPre === 512);
    expect(breath?.requirement?.spellEffect).toBe('plain');
  });

  /*
   * And a wall rather than a prune, which is the whole of the decision: the
   * character standing inside a scatter maze needs a way out, and re-planning
   * after each unexpected arrival is how anybody gets out of one. Pruning
   * every scattering exit would strand them.
   */
  it.runIf(available)('still offers a way out of a maze that scatters you', () => {
    const route = graph!.route(roomId(8, 1797), roomId(1, 1), {});
    expect(route.blocked).toBe(false);
    expect(route.steps.length).toBeGreaterThan(0);
  });

  /*
   * A spell trap is a trap and not a gate — `SpellTrapExit.CanMoveThroughExit`
   * lets everybody through — so it is priced by what the spell does. 21 of the
   * shipped realm's 22 are `poison darts`, whose power is 12–20.
   */
  it.runIf(available)('prices a spell trap by the hurt the realm states', () => {
    const trapped = [...graph!.everyRoom()]
      .flatMap((room) => room.exits)
      .filter((exit) => exit.requirement?.kind === 'spell');
    const darts = trapped.find((exit) => exit.requirement?.spellId === 905);
    expect(darts?.requirement?.damage).toBe(16);
    expect(edgePenalty(darts!.requirement, {})).toBe(36);
    /*
     * The other one fires a `TextBlock` — a realm script this client does not
     * convert — so it is *unread* rather than harmless, and gets the same
     * discouragement a cast exit's script gets. The trap floor would have
     * promised the one thing an unread script cannot promise: that the
     * character is still standing where it walked to.
     */
    const trigger = trapped.find((exit) => exit.requirement?.spellId === 851);
    expect(trigger?.requirement?.spellEffect).toBe('script');
    expect(trigger?.requirement?.damage).toBeUndefined();
    expect(edgePenalty(trigger!.requirement, {})).toBe(60);
  });

  /*
   * `Race: 13 OK, 0 NO` — the Gaunt One's own stair, and the only way into
   * 7/1362 Gloomy Temple in the whole realm.
   */
  it.runIf(available)("walks a race-gated stair by the character's own race", () => {
    const gaunt = graph!.raceId('Gaunt One');
    expect(gaunt).toBe(13);
    const stair = graph!.get(7, 1361)?.exits.find((exit) => exit.direction === 'd');
    expect(stair?.requirement?.raceOk).toBe(13);

    expect(graph!.route(roomId(7, 311), roomId(7, 1362), { raceId: gaunt }).blocked).toBe(false);
    // And a Dwarf is refused — with the refusal *said*, which is the half the
    // class gate shipped without: a pruned edge nothing can explain reports
    // that the rooms are not joined in the data, which is untrue.
    const refused = graph!.route(roomId(7, 311), roomId(7, 1362), {
      raceId: graph!.raceId('Dwarf')
    });
    expect(refused.blocked).toBe(true);
    expect(refused.blocks?.some((block) => block.kind === 'born')).toBe(true);
    // **Named, not numbered.** `admits only race 13` is the `Key: 1124`
    // half-read, and the realm's own table is right there to answer it.
    expect(refused.reason).toContain('Gaunt One');
    expect(refused.reason).toContain('Dwarf');
    // An unread sheet is still given a route: discouraged, never pruned.
    expect(graph!.route(roomId(7, 311), roomId(7, 1362), {}).blocked).toBe(false);
  });

  /*
   * `Alignment: Saint to Seedy` — the temple, which turns away anybody the
   * realm ranks below Seedy. The window is a range on the scale
   * `src/shared/alignment.ts` states, and the realm spells `Fiend` where the
   * roster spells `FIEND`, which is why nothing compares the words directly.
   */
  it.runIf(available)('reads a standing window against the roster’s own word', () => {
    const temple = graph!.get(1, 521)?.exits.find((exit) => exit.direction === 'w');
    expect(temple?.requirement?.minAlignment).toBe('Saint');
    expect(temple?.requirement?.maxAlignment).toBe('Seedy');
    expect(edgePenalty(temple!.requirement, { alignment: 'Good' })).toBe(0);
    expect(edgePenalty(temple!.requirement, { alignment: 'Outlaw' })).toBeNull();
    // Nobody has read a roster yet, which is the first seconds of every
    // session: discouraged, never pruned.
    expect(edgePenalty(temple!.requirement, { alignment: null })).toBe(60);

    // The other direction, and the realm's own spelling of the bottom end.
    const pit = graph!.get(3, 348)?.exits.find((exit) => exit.direction === 'u');
    expect(pit?.requirement?.raw).toBe('Alignment: Neutral to Fiend');
    expect(pit?.requirement?.maxAlignment).toBe('FIEND');
    expect(edgePenalty(pit!.requirement, { alignment: 'Saint' })).toBeNull();
    expect(edgePenalty(pit!.requirement, { alignment: 'Villain' })).toBe(0);
  });

  /*
   * `Item: 191` is `rope and grapple`, on 157 of the shipped realm's exits.
   * The pack only ever lowers the price — see `edgePenalty`'s item case for
   * why the other half cannot be written yet.
   */
  it.runIf(available)('waves a character carrying the rope through the rope gates', () => {
    const rope = graph!.itemIdsCarried([{ name: 'rope and grapple' }]);
    expect(rope).toEqual([191]);
    const gated = [...graph!.everyRoom()]
      .flatMap((room) => room.exits)
      .find((exit) => exit.requirement?.kind === 'item' && exit.requirement.keyId === 191);
    expect(edgePenalty(gated!.requirement, { keys: rope, packKnown: true })).toBe(0);
    /*
     * Listed and not in it is a **wall** — the server refuses outright, and
     * pricing that as merely discouraged is what walks a character into the
     * refusal that has `refusedEdges` write a real corridor off for the
     * session. Nobody having looked is a different answer, and it never prunes.
     */
    expect(edgePenalty(gated!.requirement, { keys: [], packKnown: true })).toBeNull();
    expect(edgePenalty(gated!.requirement, { keys: [] })).toBe(60);
    expect(edgeBlock(gated!.requirement, { keys: [] })).toBeNull();
    expect(edgeBlock(gated!.requirement, { keys: [], packKnown: true })?.kind).toBe('item');

    // A name two rows share says which *kind* of thing is in the pack and not
    // which row, so it says nothing at all rather than picking one.
    expect(graph!.itemIdsCarried([{ name: 'iron key' }])).toEqual([]);
    // And the listing's own marks come off first.
    expect(graph!.itemIdsCarried([{ name: 'rope and grapple (Readied)' }])).toEqual([191]);
  });

  /*
   * The reported failure, 2026-09-06: `2 bone key` in the pack against
   * `Key: 177` on the Sealed Tomb's north door. The count comes off in the
   * parse; what is left for the realm to settle is the plural some realms put
   * on a counted entry, and it is settled by asking rather than by trimming.
   */
  it.runIf(available)('undoes a counted key line’s plural only where the index agrees', () => {
    expect(graph!.itemIdNamed('bone key')).toBe(177);
    // The corpus's other spelling of the same fact. `keys` is not a row, and
    // `key` is not this realm's, so the shorter name has to be the answer.
    expect(graph!.itemIdNamed('bone keys')).toBe(177);
    /*
     * And a real name that merely ends in `s` answers with its own row. That
     * is the reason the trim cannot happen in the parse, where there is
     * nothing to ask: `padded gloves`, `rigid leather pants` and `spiked
     * leather boots` are rows, and a blind `s` would have looked for names the
     * realm does not have.
     */
    const gloves = graph!.itemsNamed(['padded gloves'])['padded gloves'];
    expect(gloves).toBeDefined();
    expect(graph!.itemIdNamed('padded gloves')).toBe(gloves!.id);
    // A name that resolves to nothing either way still resolves to nothing.
    expect(graph!.itemIdNamed('bicycles')).toBeNull();
    // And a shared name is no more answerable through its plural: `iron key`
    // is three rows, so `iron keys` says which *kind* and not which row.
    expect(graph!.itemIdNamed('iron keys')).toBeNull();
  });

  /*
   * The end of the reported chain, in the room it was reported from. The
   * tracker's half — `2 bone key` becoming two `bone key`s — is asserted in
   * `CharacterTracker.test.ts`; this is what that buys.
   */
  it.runIf(available)('opens the Sealed Tomb to a character listing two bone keys', () => {
    const north = graph!.get(1, 1309)?.exits.find((exit) => exit.direction === 'n');
    expect(north?.requirement?.raw).toBe('Key: 177');

    const carried = graph!.itemIdsCarried([{ name: 'bone key' }, { name: 'bone key' }]);
    expect(carried).toEqual([177]);
    expect(edgePenalty(north!.requirement, { keys: carried, packKnown: true })).toBe(4);

    /*
     * And the shape that was reported: the count still on the front of the
     * name resolves to nothing, so the pack reads as empty and the door reads
     * as a wall — which is the whole of *unable to route because missing key
     * but I have the key*.
     */
    expect(graph!.itemIdsCarried([{ name: '2 bone key' }])).toEqual([]);
    expect(edgePenalty(north!.requirement, { keys: [], packKnown: true })).toBeNull();
    expect(edgeBlock(north!.requirement, { keys: [], packKnown: true })?.kind).toBe('key');
  });

  it.runIf(available)('routes across the realm in reasonable time', () => {
    const started = Date.now();
    const route = graph!.route(roomId(1, 297), roomId(1, 1));
    const elapsed = Date.now() - started;
    expect(route.blocked).toBe(false);
    expect(route.steps.length).toBeGreaterThan(0);
    // Well under a frame; this runs on the main process and must not stall it.
    expect(elapsed).toBeLessThan(500);
  });
});

describe('the shipped realm data', () => {
  /*
   * The tests above build synthetic worlds, which is right for the algorithm
   * but proves nothing about the 55,806 rooms that actually ship. These read
   * the committed file, so a change to `build-world.mjs` that quietly alters
   * the shape of an exit fails here rather than in a route someone is walking.
   */
  const REALM = path.resolve('resources/world/paradigm.jsonl.gz');
  const realm = fs.existsSync(REALM) ? WorldGraph.load(REALM) : null;
  const has = realm !== null && realm.size > 0;

  it.runIf(has)('loads every room', () => {
    expect(realm!.size).toBeGreaterThan(50_000);
  });

  /*
   * The monster index, on the file that actually ships. Around 1,450 names, and
   * the ones spot-checked here are the two the wound-band arithmetic was worked
   * out against — a build that quietly stopped emitting them would otherwise
   * only show up as every bar in the game reading "unknown monster".
   */
  it.runIf(has)('names what the realm’s monsters are worth', () => {
    expect(realm!.mobCount).toBeGreaterThan(1_000);
    expect(realm!.mob('giant rat')?.hp).toBe(12);
    expect(realm!.mob('The Orc Rogue')?.hp).toBe(30);
  });

  it.runIf(has)('routes a `Text:` exit as a command, not as a direction', () => {
    /*
     * `Newhaven, Docks` leaves south to `Small Pier` via
     * `Text: borrow skiff, go skiff, row skiff`. The direction does not work
     * there — sending `s` is simply wrong — so the route has to emit the
     * phrasing. This is the rule the realm-data import exists to preserve, and
     * a real exit is the only honest way to check it.
     */
    const docks = realm!.get(1, 2149);
    const skiff = docks?.exits.find((exit) => exit.requirement?.kind === 'text');
    expect(skiff, 'the Docks still have their skiff exit').toBeDefined();

    const route = realm!.route(roomId(1, 2147), roomId(skiff!.map, skiff!.room), { level: 1 });
    expect(route.blocked).toBe(false);

    const last = route.steps.at(-1)!;
    expect(last.command).toBe('borrow skiff');
    expect(last.command).not.toBe(last.direction);
    expect(last.requirement?.kind).toBe('text');
  });

  it.runIf(has)('emits bare directions for ordinary exits', () => {
    // The other half of the same rule: only a gated exit gets a phrasing.
    const route = realm!.route(roomId(1, 2147), roomId(1, 2149), { level: 1 });
    expect(route.blocked).toBe(false);
    for (const step of route.steps) {
      if (step.requirement === null) expect(step.command).toBe(step.direction);
    }
  });

  /*
   * The reported gate, on the file that ships (todo 01).
   *
   * `Inner Gate` 1/1331 leaves north through `Door [301 picklocks/strength]`,
   * and the lever that raises it is in the `Guardroom` at 1/1345 — one room
   * west. The exit's own instruction never mentions an action, so nothing
   * reading `Requirement.actions` could find it; this is why the index is
   * built from the rooms' commands and keyed by the exit.
   */
  it.runIf(has)('names the lever that opens a gate from another room', () => {
    /*
     * Two of them, one in each Guardroom flanking the gate — 1/1339 east and
     * 1/1345 west — and the exit states no `Needs N Actions` count at all, so
     * they are alternatives rather than a set. The wire settles it: the player
     * walked into one of them, typed `pull lever`, and the gate came up.
     */
    const levers = realm!.leversFor(roomId(1, 1331), 'n');
    expect(levers.map((lever) => [lever.at, lever.roomName, lever.say])).toEqual([
      ['1/1339', 'Guardroom', 'pull lever'],
      ['1/1345', 'Guardroom', 'pull lever']
    ]);
    // And the requirement itself says nothing about it, which is the point.
    const gate = realm!.get(1, 1331)?.exits.find((exit) => exit.direction === 'n');
    expect(gate?.requirement?.kind).toBe('door');
    expect(gate?.requirement?.actions).toBeUndefined();
    expect(gate?.requirement?.actionsNeeded).toBeUndefined();

    /*
     * And the router still takes the character to the gate: the reported
     * traveller had 0 picklocks against the door's 301 and 86 strength, so the
     * edge is priced as a wall and remains the only way through — which is why
     * the walk arrives there and why the errand is the answer rather than a
     * cheaper route being one.
     */
    const traveller = { pickSkill: 0, strength: 86, level: 20 };
    const through = realm!.route(roomId(1, 1331), roomId(1, 1375), traveller);
    expect(through.blocked).toBe(false);
    expect(through.steps.map((step) => step.command)).toEqual(['n']);

    // The errand is walkable: each Guardroom is a route away and comes back.
    for (const guardroom of ['1/1339', '1/1345']) {
      expect(realm!.route(roomId(1, 1331), guardroom, traveller).blocked).toBe(false);
      expect(realm!.route(guardroom, roomId(1, 1375), traveller).blocked).toBe(false);
    }
  });

  /* An ordinary exit has none, which is 225 exits short of all of them. */
  it.runIf(has)('names none for an exit nothing opens', () => {
    expect(realm!.leversFor(roomId(1, 1), 'n')).toEqual([]);
  });

  /*
   * The other reported room (todo 04), and the answer to *"this is stock mud,
   * rooms 100% should match the mdb"*: they do. `Crypt, Stone Hallway` 1/1056
   * leaves north through `Hidden/Needs 2 Actions, any order`, and the realm
   * names both levers — one in 1/1038 and one in 1/1044, each its own room. The
   * exit is real and it was shut; what the console said was that the realm data
   * had promised an exit that does not exist.
   *
   * This is the shape `Walker.runLeverSet` walks: a **set**, because the stated
   * count matches the levers found, ordered by `Requirement.actions`, which is
   * the only place the realm's own order survives.
   */
  it.runIf(has)('names both levers of the gate reported as a routing fault', () => {
    const gate = realm!.get(1, 1056)?.exits.find((exit) => exit.direction === 'n');
    expect(gate?.requirement?.kind).toBe('hidden');
    expect(gate?.requirement?.actionsNeeded).toBe(2);
    expect(gate?.requirement?.searchable).not.toBe(true);
    // Ordered, and every one of them placed — which is what makes it walkable.
    expect(gate?.requirement?.actions?.map((act) => act.at)).toEqual([
      { map: 1, room: 1038 },
      { map: 1, room: 1044 }
    ]);
    expect(realm!.leversFor(roomId(1, 1056), 'n').map((lever) => lever.at)).toEqual([
      '1/1038',
      '1/1044'
    ]);
    // And the round of them can be walked: out to each lever and back to the gate.
    const traveller = { level: 20 };
    expect(realm!.route(roomId(1, 1056), '1/1038', traveller).blocked).toBe(false);
    expect(realm!.route('1/1038', '1/1044', traveller).blocked).toBe(false);
    expect(realm!.route('1/1044', roomId(1, 1056), traveller).blocked).toBe(false);
  });
});

/*
 * Access stores fixed-width text padded, and a realm file is now something a
 * player points at rather than something this project built. `findByName` has
 * always trimmed its query; the index had not, so a padded record was filed
 * under a key no lookup could produce and the room was unfindable by name.
 * Sixteen rooms in the shipped realm arrived that way.
 */
describe('a realm record whose name carries padding', () => {
  it('is still found by the name the server prints', () => {
    const graph = makeWorld([
      { m: 1, r: 1, n: 'Private Tomb                    ', x: {} },
      { m: 1, r: 2, n: 'Town Gates', x: {} }
    ]);
    expect(graph.findByName('Private Tomb').map((room) => room.room)).toEqual([1]);
  });

  it('shares a bucket with an unpadded room of the same name', () => {
    const graph = makeWorld([
      { m: 1, r: 1, n: 'Private Tomb   ', x: {} },
      { m: 1, r: 2, n: 'Private Tomb', x: {} }
    ]);
    // Which is the point: they *are* the same name, and a resolver that saw one
    // of them would report a unique match for a room that has two.
    expect(graph.findByName('Private Tomb')).toHaveLength(2);
  });
});

/**
 * Monster health, looked up by the only handle the wire ever gives: a name.
 *
 * The realm data is keyed by id and spells names in its own case; the stream
 * spells one monster several ways in the same fight. A lookup that disagreed
 * with the damage ledger about which of those is the key would silently keep
 * two half-fights.
 */
describe('what the realm says a monster is worth', () => {
  const world = makeWorld(corridor(2), [
    { n: 'wharf rat', hp: 12, d: 'h' },
    { n: 'cocoon', hp: 100, hi: 250 },
    { n: 'broken', hp: 0 },
    // The realm data disagreeing with itself about one name, which is 21 of the
    // 1,514 in the shipped realm.
    { n: 'shade', hp: 40, d: 'h', x: 1 },
    // Attacking one costs alignment, always for the first and only sometimes
    // for the second — the distinction that keeps the refusal from swallowing
    // the commonest monster in the realm.
    { n: 'village priest', hp: 200, d: 'p', ep: 'a' },
    { n: 'giant rat', hp: 12, d: 'h', x: 1, ep: 's' }
  ]);

  it('finds a monster however the stream spelled it', () => {
    expect(world.mob('wharf rat')?.hp).toBe(12);
    expect(world.mob('The Wharf Rat')?.hp).toBe(12);
    expect(world.mob('  a wharf   rat ')?.hp).toBe(12);
  });

  /*
   * The high end, and the span said out loud. Over-stating a monster's health
   * means it dies before the bar promised; under-stating it says "nearly dead"
   * about something that is not, which is the error that keeps a character in
   * a fight it should have left.
   */
  it('works from the high end of a name the realm data is unsure about', () => {
    expect(world.mob('cocoon')).toEqual({
      name: 'cocoon',
      hp: 250,
      span: [100, 250],
      disposition: null,
      uncertain: false,
      costly: 'never'
    });
  });

  /*
   * Whether it starts the fight, which is the question auto-combat turns on.
   * A realm file with no `d` on a row says *nothing* about that monster rather
   * than saying it is peaceable — the same distinction every absence in this
   * client keeps, and the one that stops a v4 realm reading as a harmless one.
   */
  it('says whether a monster attacks on sight, and admits when it cannot', () => {
    expect(world.mob('wharf rat')?.disposition).toBe('hostile');
    expect(world.mob('wharf rat')?.uncertain).toBe(false);
    expect(world.mob('cocoon')?.disposition).toBeNull();
  });

  it('marks a name whose realm rows disagree', () => {
    expect(world.mob('shade')?.disposition).toBe('hostile');
    expect(world.mob('shade')?.uncertain).toBe(true);
  });

  /*
   * What attacking one costs the *character* rather than the fight: ten evil
   * points, cumulative. Three answers, because a name covers several rows and
   * they need not agree.
   */
  it('says what attacking one costs, in three answers', () => {
    expect(world.mob('village priest')?.costly).toBe('always');
    expect(world.mob('giant rat')?.costly).toBe('sometimes');
    expect(world.mob('shade')?.costly).toBe('never');
  });

  it('refuses a maximum of zero rather than dividing by it later', () => {
    expect(world.mob('broken')).toBeUndefined();
  });

  it('says nothing about a monster it does not carry', () => {
    expect(world.mob('grue')).toBeUndefined();
  });

  /* A realm built before the index existed simply names no monsters. */
  it('loads a realm from before this index existed', () => {
    const old = makeWorld(corridor(2));
    expect(old.size).toBe(2);
    expect(old.mobCount).toBe(0);
    expect(old.mob('giant rat')).toBeUndefined();
  });
});

/**
 * What a shop stocks and what a spell costs, read back out of the header.
 *
 * Both are v4; a realm built before them names no shops and no spells, and
 * every consumer already has to answer "the realm does not say" — so an older
 * file degrades to exactly that case rather than failing to load.
 */
describe('the shop and spell indexes', () => {
  /** A world file with the v4 header, written the way the build script emits. */
  const richWorld = (header: Record<string, unknown>): WorldGraph => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-world-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const body =
      [
        JSON.stringify({ v: 4, source: 'test', rooms: 1, generatedAt: 'x', ...header }),
        JSON.stringify({ m: 1, r: 1, n: 'Market', x: {}, s: 4 })
      ].join('\n') + '\n';
    fs.writeFileSync(file, zlib.gzipSync(body));
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  };

  const stocked = () =>
    richWorld({
      items: [
        { id: 12, n: 'lantern', price: 2, enc: 30 },
        { id: 34, n: 'crowbar' }
      ],
      shops: [{ id: 4, n: 'General Store', items: [12, 34, 999], markup: 250 }]
    });

  it('names every item a shop stocks, so a card needs no second lookup', () => {
    const shop = stocked().shop(4);
    expect(shop?.name).toBe('General Store');
    expect(shop?.markup).toBe(250);
    expect(shop?.items).toEqual([
      { id: 12, name: 'lantern', price: 2, encumbrance: 30 },
      { id: 34, name: 'crowbar' }
    ]);
  });

  /* An id the item index does not carry is a row the realm dropped. Naming it
     "item 999" would be worse than leaving it out. */
  it('leaves out a stocked id it cannot name', () => {
    expect(
      stocked()
        .shop(4)
        ?.items.some((item) => item.id === 999)
    ).toBe(false);
  });

  it('says nothing about a shop the realm has no stock for', () => {
    expect(stocked().shop(5)).toBeUndefined();
  });

  /*
   * Where a shop *is*, which `WorldItem.shops` names and cannot answer.
   *
   * `Sold by: General Store` was a lead the client could print and not act on,
   * because a shop is a property of a room and the item index carries only the
   * shop's name. This is that join, and it is what makes a shop in the
   * Reference card the control it looks like it should be.
   */
  describe('where a shop is', () => {
    /** Two named shops: one in a single room, one in three. */
    const placed = (): WorldGraph => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-world-'));
      const file = path.join(dir, 'rooms.jsonl.gz');
      const rooms = [
        { m: 1, r: 1, n: 'Market Square', x: {}, s: 4 },
        { m: 1, r: 2, n: 'Guild Hall', x: {}, s: 5 },
        { m: 2, r: 7, n: 'Barracks', x: {}, s: 5 },
        { m: 3, r: 9, n: 'Keep', x: {}, s: 5 },
        // A room with no shop at all, and one whose shop the header never named.
        { m: 1, r: 3, n: 'Alley', x: {} },
        { m: 1, r: 4, n: 'Cellar', x: {}, s: 99 }
      ];
      const body =
        [
          JSON.stringify({
            v: 4,
            source: 'test',
            rooms: rooms.length,
            generatedAt: 'x',
            items: [{ id: 12, n: 'lantern' }],
            shops: [
              { id: 4, n: 'General Store', items: [12] },
              { id: 5, n: 'Trainer', t: 8, items: [] },
              // Named, stocked, and in no room: a lead with no place.
              { id: 6, n: 'Lost Emporium', items: [12] }
            ]
          }),
          ...rooms.map((room) => JSON.stringify(room))
        ].join('\n') + '\n';
      fs.writeFileSync(file, zlib.gzipSync(body));
      const graph = WorldGraph.load(file);
      fs.rmSync(dir, { recursive: true, force: true });
      return graph;
    };

    it('names the one room holding it, so a click can plan a route', () => {
      expect(placed().shopPlace('General Store')).toEqual({
        at: 'one',
        map: 1,
        room: 1,
        roomName: 'Market Square'
      });
    });

    /* Case and surrounding space are the item index's, not the shop table's:
       the two are separate columns of the realm database. */
    it('matches the name however the item index spelled it', () => {
      expect(placed().shopPlace('  general STORE ')).toMatchObject({ at: 'one', room: 1 });
    });

    /*
     * Measured against the shipped realm 2026-09-03: 231 shop names are
     * placed, 216 in exactly one room and 15 in between two and **fourteen**
     * — `albion inn` is in fourteen of them. Picking the first would send a
     * character somewhere arbitrary, so the count is reported and the card
     * leaves the name as text.
     */
    it('reports the count rather than picking one of several, and lists them to choose from', () => {
      const place = placed().shopPlace('Trainer');
      expect(place).toMatchObject({ at: 'several', count: 3 });
      // The rooms ride along for a control that lets the player *choose*
      // one — never for a button that walks to the first.
      expect(place?.at === 'several' ? place.rooms : []).toHaveLength(3);
    });

    it('answers nothing for a shop the realm places in no room', () => {
      expect(placed().shopPlace('Lost Emporium')).toBeUndefined();
    });

    it('answers nothing for a name the realm has never heard of, or for none', () => {
      expect(placed().shopPlace('Fishmonger')).toBeUndefined();
      expect(placed().shopPlace('   ')).toBeUndefined();
    });

    /* A room whose shop number the header never named contributes no name at
       all, rather than an empty-string key every unnamed shop would collide in. */
    it('ignores a room whose shop the header does not name', () => {
      expect(placed().shopPlace('')).toBeUndefined();
    });
  });

  it('carries the shop number on the room, which is how one is found at all', () => {
    expect(stocked().byId(roomId(1, 1))?.shop).toBe(4);
  });

  it('finds a spell by prefix ahead of one that merely contains it', () => {
    const graph = richWorld({
      spells: [
        { id: 1, n: 'Greater Heal', mana: 20 },
        { id: 2, n: 'Heal', short: 'hea', level: 2, mana: 5 }
      ]
    });
    // Somebody typing `heal` means the spell called Heal, not the eleven with
    // "heal" somewhere in the name.
    expect(graph.searchSpells('heal').map((spell) => spell.name)).toEqual(['Heal', 'Greater Heal']);
    expect(graph.searchSpells('heal')[0]).toEqual({
      id: 2,
      name: 'Heal',
      short: 'hea',
      level: 2,
      mana: 5
    });
  });

  it('matches an abbreviation exactly, which is what the realm accepts', () => {
    const graph = richWorld({ spells: [{ id: 2, n: 'Heal', short: 'hea' }] });
    expect(graph.searchSpells('hea')).toHaveLength(1);
  });

  it('answers an empty query with the list rather than nothing', () => {
    expect(richWorld({ spells: [{ id: 1, n: 'Light' }] }).searchSpells('')).toHaveLength(1);
  });

  it('degrades to knowing nothing on a realm built before either existed', () => {
    const old = makeWorld(corridor(2));
    expect(old.shop(4)).toBeUndefined();
    expect(old.spellCount).toBe(0);
    expect(old.searchSpells('heal')).toEqual([]);
  });
});

describe('looking a name up across everything the realm knows', () => {
  const rich = (): WorldGraph => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-world-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const body =
      JSON.stringify({
        v: 5,
        source: 'test',
        rooms: 0,
        generatedAt: 'x',
        items: [{ id: 12, n: 'healing salve', price: 8, enc: 4 }],
        spells: [{ id: 2, n: 'Heal', short: 'hea', level: 2, mana: 5 }],
        mobs: [{ n: 'heald the butcher', hp: 40, d: 'p' }]
      }) + '\n';
    fs.writeFileSync(file, zlib.gzipSync(body));
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  };

  /** A realm whose header is exactly what the caller says, at format 14. */
  const withHeader = (header: Record<string, unknown>): WorldGraph => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-world-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const body =
      JSON.stringify({ v: 14, source: 'test', rooms: 0, generatedAt: 'x', ...header }) + '\n';
    fs.writeFileSync(file, zlib.gzipSync(body));
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  };

  it('answers one query from all three name indexes at once', () => {
    // The person asking has a *name* — off a room listing, a pack, a shop
    // shelf — and should not have to know which table answers it.
    const found = rich().lookup('heal');
    expect(found.mobs.map((mob) => mob.name)).toEqual(['heald the butcher']);
    expect(found.items.map((item) => item.name)).toEqual(['healing salve']);
    expect(found.spells.map((spell) => spell.name)).toEqual(['Heal']);
  });

  it('answers an empty query with nothing rather than everything', () => {
    const found = rich().lookup('');
    // `classNames` is the realm's own class table rather than a search result,
    // so an empty query returns it empty too — nothing was looked up.
    expect(found).toEqual({
      mobs: [],
      items: [],
      spells: [],
      races: [],
      classes: [],
      classNames: {}
    });
  });

  /*
   * What the two `ExpTable` columns are for: the multiplier the whole
   * experience table is built from. Both recorded pairs, from characters whose
   * tables this client has off the wire — see `src/shared/experience.ts`.
   */
  it('adds the race and the class to a base of a hundred', () => {
    const graph = withHeader({
      races: [
        { id: 11, n: 'Kang', expTable: 150 },
        { id: 13, n: 'Gaunt One', expTable: 120 },
        // A race the realm prices at nothing: absent from the built row, and
        // contributing nothing to the sum, which is what absent means here.
        { id: 1, n: 'Human' }
      ],
      classes: [
        { id: 3, n: 'Paladin', expTable: 490 },
        { id: 15, n: 'Mystic', expTable: 420 },
        // Stock MajorMUD's Thief. A sign filter anywhere on this path charges
        // one a fifth more per level than the realm does.
        { id: 8, n: 'Thief', expTable: -20 }
      ]
    });
    expect(graph.experiencePercent('Kang', 'Paladin')).toBe(740);
    expect(graph.experiencePercent('Gaunt One', 'Mystic')).toBe(640);
    expect(graph.experiencePercent('human', 'thief')).toBe(80);
  });

  it('refuses a race or a class the realm does not name', () => {
    // Not the base rate. A missing term is not a zero one — a realm converted
    // before v10 names no races at all — and a plausible wrong table is worse
    // on this card than no table.
    const graph = withHeader({
      races: [{ id: 11, n: 'Kang', expTable: 150 }],
      classes: [{ id: 3, n: 'Paladin', expTable: 490 }]
    });
    expect(graph.experiencePercent('Nekojin', 'Paladin')).toBeNull();
    expect(graph.experiencePercent('Kang', 'Necromancer')).toBeNull();
    expect(graph.experiencePercent('', '')).toBeNull();
  });

  /*
   * Format 14: every one of the five indexes carries `Abil-n` pairs, and until
   * 2026-08-31 only the item reader looked for them. The failure mode this
   * guards is silent — a builder writing `ab` and a loader never reading it
   * loses the whole feature with no error anywhere, which is exactly what had
   * already happened to four of the five tables.
   */
  it('reads the effect pairs back off every index that carries them', () => {
    const graph = withHeader({
      items: [{ id: 1, n: 'ring', ab: [[46, 10]] }],
      mobs: [{ n: 'wraith', hp: 40, d: 'p', ab: [[3, 100]] }],
      spells: [{ id: 2, n: 'mend', ab: [[18, 0]] }],
      races: [{ id: 3, n: 'Kang', ab: [[21, 100]] }],
      classes: [{ id: 4, n: 'Thief', ab: [[1003, 10]] }]
    });
    const found = graph.lookup('');
    expect(graph.mob('wraith')?.abilities).toEqual([[3, 100]]);
    expect(graph.lookup('ring').items[0]?.abilities).toEqual([[46, 10]]);
    expect(graph.lookup('mend').spells[0]?.abilities).toEqual([[18, 0]]);
    expect(graph.lookup('Kang').races[0]?.abilities).toEqual([[21, 100]]);
    expect(graph.lookup('Thief').classes[0]?.abilities).toEqual([[1003, 10]]);
    expect(found).toBeDefined();
  });

  /*
   * A realm converted before format 14 has no `ab` on those four, and must
   * load rather than fail — the same degradation every earlier bump takes.
   */
  it('loads a realm built before the effects were written, without them', () => {
    const graph = withHeader({
      mobs: [{ n: 'wraith', hp: 40, d: 'p' }],
      spells: [{ id: 2, n: 'mend' }]
    });
    expect(graph.mob('wraith')?.abilities).toBeUndefined();
    expect(graph.lookup('mend').spells[0]?.abilities).toBeUndefined();
  });

  it('caps each kind separately, so one crowd cannot drown the others', () => {
    const graph = (() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-world-'));
      const file = path.join(dir, 'rooms.jsonl.gz');
      const spells = Array.from({ length: 40 }, (_, index) => ({
        id: index + 1,
        n: `Heal ${index + 1}`
      }));
      const body =
        JSON.stringify({
          v: 5,
          source: 'test',
          rooms: 0,
          generatedAt: 'x',
          spells,
          mobs: [{ n: 'healer', hp: 10, d: 'p' }]
        }) + '\n';
      fs.writeFileSync(file, zlib.gzipSync(body));
      const built = WorldGraph.load(file);
      fs.rmSync(dir, { recursive: true, force: true });
      return built;
    })();
    const found = graph.lookup('heal');
    expect(found.spells.length).toBeLessThanOrEqual(12);
    // The forty spells did not push the one monster out.
    expect(found.mobs.map((mob) => mob.name)).toEqual(['healer']);
  });

  /*
   * The server hangs a modifier off either end of a monster's name and this
   * client's database does not carry the modifier list, so the name a person
   * clicks off the room listing is a name the table cannot match as printed.
   * The listing itself has always undone it (`classifyOccupant`); the panel
   * answering the click had not, and told them the world data did not name a
   * monster the card beside it was describing.
   */
  it('finds a monster the server printed with a name modifier', () => {
    const found = rich().lookup('fierce heald the butcher');
    expect(found.mobs.map((mob) => mob.name)).toEqual(['heald the butcher']);
  });

  it('will not invent one by matching a shortened name loosely', () => {
    // `butcher` is a substring of a monster the realm has, and a word left
    // over from stripping is not a claim that monster is what was clicked.
    expect(rich().lookup('small rat of butcher').mobs).toEqual([]);
  });

  it('reads a printed name for anything else holding one off the wire', () => {
    // The health estimator asks this way: the name in a combat line carries
    // the modifier, and the row it needs is filed under the name without it.
    expect(rich().mobAsPrinted('nasty heald the butcher')?.name).toBe('heald the butcher');
    expect(rich().mobAsPrinted('heald the butcher')?.name).toBe('heald the butcher');
    expect(rich().mobAsPrinted('butcher')).toBeUndefined();
  });
});

/*
 * The file carries the realm's numbers; the words are `shared/items.ts`'s
 * reading of them, applied on load so a correction reaches an already
 * converted realm without a rebuild.
 */
describe('reading an item kind back off disk', () => {
  const graph = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-world-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const body =
      JSON.stringify({
        v: 6,
        source: 'test',
        rooms: 0,
        generatedAt: 'x',
        items: [
          {
            id: 100,
            n: 'quarterstaff',
            type: 1,
            worn: 1,
            wpn: { min: 2, max: 12, spd: 1200, str: 30, kind: 1 }
          },
          { id: 336, n: 'padded boots', type: 0, worn: 5, arm: { ac: 10, dr: 1, kind: 1 } },
          { id: 500, n: 'scroll of flash', type: 9, uses: 1 },
          { id: 7, n: 'brass key' },
          { id: 8, n: 'odd thing', type: 42, worn: 13 }
        ]
      }) + '\n';
    fs.writeFileSync(file, zlib.gzipSync(body));
    const loaded = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return loaded;
  })();

  it('names a weapon, its slot and its skill', () => {
    expect(graph.item(100)).toEqual({
      id: 100,
      name: 'quarterstaff',
      kind: 'weapon',
      slot: 'Weapon Hand',
      worn: 1,
      /*
       * `WeaponType` names two axes — handedness and damage kind — and was read
       * as one, so a quarterstaff said `staff` and nothing in the table said it
       * needs both hands. See `WEAPON_CLASS`.
       */
      weapon: {
        min: 2,
        max: 12,
        speed: 1200,
        strength: 30,
        type: 'two-handed blunt',
        hands: 2
      }
    });
  });

  it('names armour, its slot and its material', () => {
    expect(graph.item(336)).toEqual({
      id: 336,
      name: 'padded boots',
      kind: 'armour',
      slot: 'Feet',
      worn: 5,
      // Class 1 is the whole cloth category — padded, cotton, silk, robes —
      // and neither `padded` nor MMUD-Explorer's `Silk` was true of it.
      armour: { ac: 10, dr: 1, material: 'cloth' }
    });
  });

  it('carries a use count and nothing invented beside it', () => {
    expect(graph.item(500)).toEqual({ id: 500, name: 'scroll of flash', kind: 'scroll', uses: 1 });
  });

  it('says nothing for an item the file says nothing about', () => {
    expect(graph.item(7)).toEqual({ id: 7, name: 'brass key' });
  });

  /*
   * A number the sample never showed is not given a word — but the number is
   * kept, because a listing that names an item carrying it can still teach
   * what the server prints for it (`shared/lore.ts`, `SlotLoreEntry`).
   */
  it('leaves an unrecognised kind or slot unnamed, and keeps the code', () => {
    expect(graph.item(8)).toEqual({ id: 8, name: 'odd thing', worn: 13 });
  });
});

/*
 * A glyph beside a room's name is a claim, made the moment the name is
 * printed — before the room resolves — so it is only made when every room
 * bearing the name agrees.
 */
describe('what kind of place a room name is', () => {
  const graph = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-world-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const body =
      [
        JSON.stringify({
          v: 7,
          source: 'test',
          rooms: 4,
          generatedAt: 'x',
          items: [{ id: 12, n: 'lantern' }],
          shops: [
            { id: 1, n: 'Bank of Godfrey', items: [], t: 7 },
            { id: 2, n: 'General Store', items: [12], t: 10 },
            { id: 3, n: 'Temple', items: [12], t: 5 }
          ],
          mobs: [{ n: 'giant rat', hp: 20 }],
          spells: [{ id: 1, n: 'Heal', short: 'heal', level: 2, mana: 4 }]
        }),
        JSON.stringify({ m: 1, r: 1, n: 'Bank', s: 1 }),
        JSON.stringify({ m: 1, r: 2, n: 'Bank', s: 1 }),
        JSON.stringify({ m: 1, r: 3, n: 'Square', s: 2 }),
        JSON.stringify({ m: 1, r: 4, n: 'Square' }),
        JSON.stringify({ m: 1, r: 5, n: 'Chapel', s: 3 })
      ].join('\n') + '\n';
    fs.writeFileSync(file, zlib.gzipSync(body));
    const loaded = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return loaded;
  })();

  it('names the kind when every room bearing the name agrees', () => {
    expect(graph.placeNamed('Bank')).toEqual({ kind: 'bank', shop: 'Bank of Godfrey' });
    expect(graph.placeNamed('Chapel')).toEqual({ kind: 'temple', shop: 'Temple' });
    expect(graph.shop(1)?.kind).toBe('bank');
    // Kept for its kind alone: it stocks nothing.
    expect(graph.shop(1)?.items).toEqual([]);
  });

  it('claims nothing when they disagree, or when there is no such room', () => {
    expect(graph.placeNamed('Square')).toBeUndefined();
    expect(graph.placeNamed('Nowhere')).toBeUndefined();
  });

  it('lists every name it knows, lower-cased, for the console to recognise', () => {
    expect(graph.names()).toEqual({
      items: ['lantern'],
      mobs: ['giant rat'],
      spells: ['heal'],
      races: [],
      classes: [],
      // Multi-word only, and both fixture rooms are called `Bank` or `Square`.
      rooms: []
    });
  });
});

/*
 * The console asks about a room on its *name* line, which is before
 * `Obvious exits:` has completed the room and settled which of the thirteen
 * Town Gates this is. So the answer has to be refused whenever the rooms
 * sharing a name disagree — a button that sends a command the room does not
 * take is not a button that does nothing, it is one that says the text out
 * loud to everybody standing there.
 */
/*
 * A lever is filed by the exit it opens and not by the room it is pulled in,
 * because that is the direction every question about it is asked from: a walk
 * refused at a gate asks *is there anything anywhere that opens this*, and the
 * room it is standing in is the one place the answer is not.
 */
describe('the levers that open an exit', () => {
  const world = (): WorldGraph =>
    makeWorld([
      { m: 1, r: 1, n: 'Inner Gate', x: { e: { m: 1, r: 2, i: 'Door' }, w: { m: 1, r: 9 } } },
      { m: 1, r: 2, n: 'Courtyard', x: { w: { m: 1, r: 1 } } },
      {
        m: 1,
        r: 9,
        n: 'Guardroom',
        x: { e: { m: 1, r: 1 } },
        cmd: [{ say: ['pull lever', 'move lever'], opens: { room: '1/1', direction: 'e' } }]
      }
    ]);

  it('answers with the room the lever is pulled in and what to type', () => {
    expect(world().leversFor('1/1', 'e')).toEqual([
      { at: '1/9', roomName: 'Guardroom', say: 'pull lever' }
    ]);
  });

  /* The realm's own spelling first; the rest are synonyms for one lever, and
     the client sends one command — `Requirement.commands` is read the same way. */
  it('keeps only the realm’s own spelling', () => {
    expect(world().leversFor('1/1', 'e')[0]!.say).toBe('pull lever');
  });

  it('answers nothing for the other direction, and for a room with no lever', () => {
    expect(world().leversFor('1/1', 'w')).toEqual([]);
    expect(world().leversFor('1/9', 'e')).toEqual([]);
  });

  /* A room-script command that moves you is a portal, not a lever, and the two
     are told apart by `opens` — the field that exists for exactly that. */
  it('does not read a teleport as a lever', () => {
    const graph = makeWorld([
      { m: 1, r: 1, n: 'Pool', x: {}, cmd: [{ say: ['dive pool'], to: '1/2' }] },
      { m: 1, r: 2, n: 'Cavern', x: {} }
    ]);
    expect(graph.leversFor('1/2', 'n')).toEqual([]);
  });

  /* Several levers for one exit come back in the order the rooms were read, so
     `specific order` is honoured by whoever sends them. */
  it('keeps every lever an exit needs', () => {
    const graph = makeWorld([
      { m: 1, r: 1, n: 'Gate', x: { n: { m: 1, r: 2, i: 'Hidden/Needs 2 Actions' } } },
      { m: 1, r: 2, n: 'Beyond', x: {} },
      {
        m: 1,
        r: 3,
        n: 'West Room',
        cmd: [{ say: ['pull red'], opens: { room: '1/1', direction: 'n' } }],
        x: {}
      },
      {
        m: 1,
        r: 4,
        n: 'East Room',
        cmd: [{ say: ['pull blue'], opens: { room: '1/1', direction: 'n' } }],
        x: {}
      }
    ]);
    expect(graph.leversFor('1/1', 'n').map((lever) => lever.at)).toEqual(['1/3', '1/4']);
  });
});

describe('the commands a room named this takes', () => {
  const withRooms = (rooms: Array<Record<string, unknown>>): WorldGraph => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-exits-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const body =
      [
        JSON.stringify({ v: 11, source: 'test', rooms: rooms.length, generatedAt: 'x' }),
        ...rooms.map((room) => JSON.stringify(room))
      ].join('\n') + '\n';
    fs.writeFileSync(file, zlib.gzipSync(body));
    const loaded = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return loaded;
  };

  it('answers with the realm’s own first phrasing', () => {
    const graph = withRooms([
      { m: 1, r: 1, n: 'Sewer Grate', x: { d: { m: 1, r: 2, i: 'Text: go manhole, go man' } } }
    ]);
    expect(graph.exitCommandsNamed('Sewer Grate')).toEqual(['go manhole']);
  });

  it('says nothing for a room whose exits carry no command', () => {
    const graph = withRooms([{ m: 1, r: 1, n: 'Town Square', x: { n: { m: 1, r: 2 } } }]);
    expect(graph.exitCommandsNamed('Town Square')).toBeUndefined();
  });

  it('refuses a name whose rooms disagree', () => {
    const graph = withRooms([
      { m: 1, r: 1, n: 'Town Gates', x: { d: { m: 1, r: 3, i: 'Text: go manhole' } } },
      { m: 1, r: 2, n: 'Town Gates', x: { d: { m: 1, r: 4, i: 'Text: go hatch' } } }
    ]);
    expect(graph.exitCommandsNamed('Town Gates')).toBeUndefined();
  });

  /*
   * Agreement is the test, not uniqueness: two rooms of one name that offer
   * the same way onward answer the same thing whichever one you are in.
   */
  it('answers when several rooms of the name agree', () => {
    const graph = withRooms([
      { m: 1, r: 1, n: 'Sewer Grate', x: { d: { m: 1, r: 3, i: 'Text: go manhole' } } },
      { m: 1, r: 2, n: 'Sewer Grate', x: { d: { m: 1, r: 4, i: 'Text: go manhole' } } }
    ]);
    expect(graph.exitCommandsNamed('Sewer Grate')).toEqual(['go manhole']);
  });

  it('says nothing about a room the realm does not have', () => {
    expect(withRooms([]).exitCommandsNamed('Nowhere')).toBeUndefined();
  });
});

/*
 * The realm's `Spells` table is every *effect* the engine has, not a
 * spellbook: 848 of the shipped realm's 2,094 rows state no level, mana,
 * energy or abbreviation because nobody casts them. Linked on sight they turn
 * prose into false spells — `Encumbrance:` in an inventory listing offered a
 * card reading "encumbrance · SPELL · Lasts 1", off the effect row behind
 * being overloaded (id 1236).
 */
describe('only castable spells are offered to the console', () => {
  const withSpells = (spells: unknown[]): WorldGraph => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-castable-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const body =
      [
        JSON.stringify({ v: 7, source: 'test', rooms: 1, generatedAt: 'x', spells }),
        JSON.stringify({ m: 1, r: 1, n: 'Square' })
      ].join('\n') + '\n';
    fs.writeFileSync(file, zlib.gzipSync(body));
    const loaded = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return loaded;
  };

  it('drops an effect row that states nothing a caster would need', () => {
    const graph = withSpells([
      { id: 1236, n: 'encumbrance', dur: 1 },
      { id: 900, n: 'breathes a jet of frost' },
      { id: 901, n: 'food' }
    ]);
    expect(graph.names().spells).toEqual([]);
  });

  /*
   * Any one of the four signals is enough, and it has to be: `harm` and `mend`
   * carry no abbreviation on the shipped realm and are real spells, kept by
   * their level and mana.
   */
  it('keeps a spell that states any one of level, mana, energy or abbreviation', () => {
    expect(withSpells([{ id: 1, n: 'Magic Missile', short: 'mmis' }]).names().spells).toEqual([
      'magic missile'
    ]);
    expect(withSpells([{ id: 12, n: 'harm', level: 1, mana: 1 }]).names().spells).toEqual(['harm']);
    expect(withSpells([{ id: 13, n: 'zap', energy: 500 }]).names().spells).toEqual(['zap']);
  });

  /*
   * The filter governs what is underlined without being asked, and nothing
   * else: somebody who types `encumbrance` into the Reference card is asking,
   * and the realm's answer is the one to give.
   */
  it('still answers a search for one by name', () => {
    const graph = withSpells([{ id: 1236, n: 'encumbrance', dur: 1 }]);
    expect(graph.searchSpells('encumbrance').map((spell) => spell.name)).toEqual(['encumbrance']);
  });
});

/*
 * Format 20: how a monster fights, read back off the file and handed to its
 * entity with every spell it names resolved — the shape `menace.ts` weighs.
 */
describe('how a monster fights, read back', () => {
  function withProfiles(version: number): WorldGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-profiles-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = JSON.stringify({
      v: version,
      source: 'test',
      rooms: 1,
      generatedAt: 'x',
      mobs: [
        {
          n: 'guardsman',
          hp: 200,
          d: 'h',
          ds: 888,
          pf: [
            {
              a: [
                [1, 0.85, 80, 8, 30, 1000, 583],
                [2, 0.15, 5429, 1, 30, 1000]
              ],
              c: [[66, 0.1, 12]]
            }
          ]
        },
        { n: 'old man', hp: 10, d: 'p' }
      ],
      spells: [
        { id: 66, n: 'hold person', tg: 8, dur: 4, res: 2, ab: [[74, 0]] },
        { id: 583, n: 'knockdown', ab: [[74, 1]] },
        { id: 888, n: 'calls for aid', ab: [[12, 13]] }
      ]
    });
    const body = [header, JSON.stringify({ m: 1, r: 1, n: 'Square' })].join('\n') + '\n';
    fs.writeFileSync(file, zlib.gzipSync(body));
    const loaded = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return loaded;
  }

  it('loads the profiles and whether a spell can be resisted', () => {
    const graph = withProfiles(20);
    expect(graph.mob('guardsman')?.profiles).toEqual([
      {
        attacks: [
          { kind: 'melee', chance: 0.85, accuracy: 80, min: 8, max: 30, energy: 1000, onHit: 583 },
          { kind: 'spell', chance: 0.15, spell: 5429, castChance: 1, level: 30, energy: 1000 }
        ],
        casts: [{ spell: 66, chance: 0.1, level: 12 }]
      }
    ]);
    expect(graph.spellById(66)?.resist).toBe(2);
    expect(graph.spellById(583)?.resist).toBeUndefined();
  });

  /* Two absences: a file written with profiles that states none for a name
     is saying it fights with nothing; a file written before them says
     nothing at all, which is weighed as unknown rather than as harmless. */
  it('tells a name that fights with nothing from a file that says nothing', () => {
    expect(withProfiles(20).mob('old man')?.profiles).toEqual([]);
    expect(withProfiles(19).mob('old man')?.profiles).toBeUndefined();
  });

  it('hands the entity its profiles and every spell they or its death name', () => {
    const entity = withProfiles(20).buildMobEntity('guardsman');
    expect(entity.profiles).toHaveLength(1);
    expect(
      Object.keys(entity.spells ?? {})
        .map(Number)
        .sort((a, b) => a - b)
    ).toEqual([66, 583, 888]);
    expect(entity.spells?.[66]?.name).toBe('hold person');
    // Spell 5429 is named by the profile and absent from this file: no entry,
    // rather than one invented for it.
    expect(entity.spells?.[5429]).toBeUndefined();
  });
});

describe('lairs', () => {
  function withLairs(): WorldGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-lair-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = JSON.stringify({
      v: 9,
      source: 'test',
      rooms: 2,
      generatedAt: 'x',
      mobs: [
        { n: 'giant rat', hp: 12, i: [1, 109], d: 'h' },
        { n: 'cave bear', hp: 50, i: [80], d: 'h' }
      ]
    });
    const entrance = {
      m: 1,
      r: 1,
      n: 'Dungeon, Entrance',
      x: { n: { m: 1, r: 2 } },
      lair: '(Max 3): 1,109,'
    };
    const cavern = {
      m: 1,
      r: 2,
      n: 'Small Cavern',
      x: { s: { m: 1, r: 1 } },
      lair: '(Max 1): 80,'
    };
    fs.writeFileSync(
      file,
      zlib.gzipSync([header, JSON.stringify(entrance), JSON.stringify(cavern)].join('\n') + '\n')
    );
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  }

  it('resolves a lair descriptor to monsters by the realm’s own numbers', () => {
    const world = withLairs();
    expect(world.mobById(109)?.name).toBe('giant rat');
    expect(world.lairOf(world.byId('1/1')!).map((mob) => mob.name)).toEqual(['giant rat']);
    expect(world.lairOf(world.byId('1/2')!).map((mob) => mob.hp)).toEqual([50]);
  });

  /* The face's question: how many at once, and what. */
  it('reads the lair whole, with how many are up at once', () => {
    const world = withLairs();
    const lair = world.lair(world.byId('1/1')!);
    expect(lair?.max).toBe(3);
    expect(lair?.mobs.map((mob) => mob.name)).toEqual(['giant rat']);
    expect(world.lair(world.byId('1/2')!)).toEqual({
      max: 1,
      mobs: [expect.objectContaining({ name: 'cave bear', hp: 50 })]
    });
  });

  it('is no lair at all for a room the realm does not mark as one', () => {
    const world = withLairs();
    expect(world.lair({ ...world.byId('1/1')!, lair: undefined })).toBeNull();
    // A descriptor naming nothing the table knows is still a lair -- the map
    // marks it as one -- and comes back empty so the face can say why.
    expect(world.lair({ ...world.byId('1/1')!, lair: '(Max 2): 9999,' })).toEqual({
      max: 2,
      mobs: []
    });
  });

  /*
   * Weighed by the rows the lair names, not by the name (todo 01, 2026-09-10).
   * The guard post on the Hillside Path names row 224, a 100-HP gnoll scout
   * that lands a blow in twenty-five; folded by name it was weighed as row
   * 2204, the 830-HP one that swings four times a round, and a level-12
   * Paladin was told the room was expected to kill it.
   */
  describe('weighed by the row it names', () => {
    const weak = { a: [[1, 1, 70, 4, 15, 500, 0]], c: [] };
    const strong = { a: [[1, 1, 150, 15, 40, 250, 0]], c: [] };
    const rooms = [
      { m: 1, r: 1, n: 'Guard Post', x: {}, lair: '(Max 3): 224,' },
      { m: 1, r: 2, n: 'Barracks', x: {}, lair: '(Max 1): 2204,' },
      { m: 1, r: 3, n: 'Gate', x: {}, lair: '(Max 2): 14,' },
      { m: 1, r: 4, n: 'Stall', x: {}, lair: '(Max 1): 5,' }
    ];
    const byRow = () =>
      makeWorld(
        rooms,
        {
          mobs: [
            {
              n: 'gnoll scout',
              hp: 100,
              hi: 830,
              i: [224, 2204],
              d: 'h',
              pf: [weak, strong],
              pr: [0, 1],
              pd: 'hh'
            },
            {
              n: 'guardsman',
              hp: 200,
              i: [13, 14],
              d: 'h',
              x: 1,
              pf: [weak],
              pr: [0, 0],
              pd: 'he'
            },
            { n: 'old man', hp: 10, i: [5], d: 'p', pf: [weak], pr: [-1], pd: 'p' }
          ]
        },
        31
      );

    it('hands a lair the row’s own profile, not the fold’s worst', () => {
      const graph = byRow();
      expect(graph.buildMobEntity('gnoll scout').profiles).toHaveLength(2);
      const [scout] = graph.lairEntities(graph.byId('1/1')!);
      expect(scout?.profiles).toHaveLength(1);
      expect(scout?.profiles?.[0]?.attacks[0]).toMatchObject({ accuracy: 70 });
      const [veteran] = graph.lairEntities(graph.byId('1/2')!);
      expect(veteran?.profiles?.[0]?.attacks[0]).toMatchObject({ accuracy: 150 });
    });

    it('and the row’s own disposition, certain about itself', () => {
      const graph = byRow();
      expect(graph.mob('guardsman')).toMatchObject({ disposition: 'hostile', uncertain: true });
      expect(graph.lairEntities(graph.byId('1/3')!)[0]).toMatchObject({
        disposition: 'hates-evil',
        uncertain: false
      });
    });

    it('reads a row that states no attack as fighting with nothing', () => {
      expect(byRow().lairEntities(byRow().byId('1/4')!)[0]?.profiles).toEqual([]);
    });

    it('degrades to the fold on a file written before the rows were kept', () => {
      const graph = makeWorld(
        rooms,
        {
          mobs: [{ n: 'gnoll scout', hp: 100, hi: 830, i: [224, 2204], d: 'h', pf: [weak, strong] }]
        },
        30
      );
      expect(graph.lairEntities(graph.byId('1/1')!)[0]?.profiles).toHaveLength(2);
    });

    it('is empty for a room that is not a lair', () => {
      const graph = byRow();
      expect(graph.lairEntities({ ...graph.byId('1/1')!, lair: undefined })).toEqual([]);
    });
  });

  it('reads the Max count as a count, never as a monster', () => {
    const world = withLairs();
    // `(Max 1): 80,` — the 1 is not monster #1.
    expect(world.lairOf(world.byId('1/2')!).map((mob) => mob.name)).toEqual(['cave bear']);
  });

  /*
   * The shipped realm is Paradigm's, and every one of its 14,068 lairs ends in
   * the exporter's own bracketed parameters. Read as monster numbers, the
   * Lucky Strike Casino's pair of drunks became six creatures.
   */
  it('reads the exporter’s bracketed parameters as parameters, not monsters', () => {
    const world = withLairs();
    const spelled = { ...world.byId('1/1')!, lair: '(Max 3): 1,109,[6-30-31-2]' };
    expect(world.lairOf(spelled).map((mob) => mob.name)).toEqual(['giant rat']);
    expect(world.lair(spelled)?.max).toBe(3);
  });

  /*
   * GreaterMUD writes a single space into `Rooms.Lair` for every ordinary
   * room, and the converter's emptiness test lets a space through — so on that
   * realm every one of 55,806 rooms was a lair on the map and a lair of
   * nothing on the card.
   */
  it('is no lair for a descriptor naming nothing at all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-blanklair-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = JSON.stringify({
      v: 9,
      source: 'test',
      rooms: 1,
      generatedAt: 'x',
      mobs: [{ n: 'giant rat', hp: 12, i: [1], d: 'h' }]
    });
    const blank = { m: 1, r: 1, n: 'Plain Road', x: {}, lair: ' ' };
    fs.writeFileSync(file, zlib.gzipSync([header, JSON.stringify(blank)].join('\n') + '\n'));
    const world = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    // Undefined, not an empty lair: the map's glyph reads this field directly.
    expect(world.byId('1/1')?.lair).toBeUndefined();
    expect(world.lair(world.byId('1/1')!)).toBeNull();
  });
});

/*
 * *Where do I find one of these* — the reverse of `Rooms.NPC` and
 * `Rooms.Lair`, which the world file has carried since it began and which
 * nothing could read backwards.
 */
describe('where the realm puts a monster', () => {
  function withPlacements(): WorldGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-spawns-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = JSON.stringify({
      v: 9,
      source: 'test',
      rooms: 5,
      generatedAt: 'x',
      mobs: [
        { n: 'wounded messenger', hp: 9999, i: [243], d: 'p' },
        { n: 'snow cat', hp: 300, i: [70, 71], d: 'h' },
        { n: 'healer', hp: 40, i: [47], d: 'p' },
        { n: 'summoned wisp', hp: 5, i: [900], d: 'h' }
      ]
    });
    const rooms = [
      // The resident, and a lair in the same room: two claims, and `npc` is
      // the specific one.
      { m: 1, r: 527, n: 'Temple Healer', x: {}, npc: 243, lair: '(Max 1): 47,[2-16-16-1]' },
      // Three rooms of one name, and one of another: the group is the name.
      { m: 2, r: 1, n: 'Snowy Plains', x: {}, lair: '(Max 2): 70,[6-30-31-2]' },
      { m: 2, r: 2, n: 'Snowy Plains', x: {}, lair: '(Max 2): 71,[6-30-31-2]' },
      { m: 2, r: 3, n: 'Snowy Plains', x: {}, lair: '(Max 3): 70,[6-30-31-3]' },
      { m: 2, r: 9, n: 'Ice Field', x: {}, lair: '(Max 2): 70,[6-30-31-2]' }
    ];
    fs.writeFileSync(
      file,
      zlib.gzipSync([header, ...rooms.map((room) => JSON.stringify(room))].join('\n') + '\n')
    );
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  }

  /* The reported case: search a name, see the room, walk there. */
  it('names the room a resident lives in, as one place', () => {
    const world = withPlacements();
    const places = world.mobPlaces(world.mob('wounded messenger')!);
    expect(places).toEqual({
      rooms: 1,
      more: 0,
      spawns: [
        {
          via: 'npc',
          roomName: 'Temple Healer',
          count: 1,
          rooms: [{ map: 1, room: 527 }],
          max: null
        }
      ]
    });
  });

  /*
   * A name resolving to several of the realm's rows is one monster, and every
   * row's placements are its placements — `snow cat` is ids 70 and 71.
   */
  it('groups by room name, and counts the rooms behind each', () => {
    const world = withPlacements();
    const places = world.mobPlaces(world.mob('snow cat')!)!;
    expect(places.rooms).toBe(4);
    expect(places.more).toBe(0);
    expect(places.spawns.map((spawn) => [spawn.roomName, spawn.count])).toEqual([
      // Widest spread first: it is where the thing is most likely to be.
      ['Snowy Plains', 3],
      ['Ice Field', 1]
    ]);
    // Every address is kept, so a group of several is a choice rather than a
    // guess at which of them was meant.
    expect(places.spawns[0]!.rooms).toEqual([
      { map: 2, room: 1 },
      { map: 2, room: 2 },
      { map: 2, room: 3 }
    ]);
  });

  /* A figure the rows disagree about is no figure. */
  it('states the slot count only where the group agrees on one', () => {
    const world = withPlacements();
    const places = world.mobPlaces(world.mob('snow cat')!)!;
    // Snowy Plains is two rooms at Max 2 and one at Max 3.
    expect(places.spawns[0]!.max).toBeNull();
    expect(places.spawns[1]!.max).toBe(2);
  });

  /*
   * One room reached both ways is one place, and the resident wins: the realm
   * saying a creature lives here is a stronger claim than its being one
   * candidate for a regeneration slot.
   */
  it('folds a room that is both a lair and a home, keeping the home', () => {
    const world = withPlacements();
    const healer = world.mobPlaces(world.mob('healer')!)!;
    expect(healer.spawns.map((spawn) => spawn.via)).toEqual(['lair']);
    const messenger = world.mobPlaces(world.mob('wounded messenger')!)!;
    expect(messenger.rooms).toBe(1);
    expect(messenger.spawns.map((spawn) => spawn.via)).toEqual(['npc']);
  });

  /*
   * Undefined rather than an empty list: 153 of the shipped realm's 1,514
   * names are summoned or scripted in, and *no rooms* would read as a claim
   * that the thing is nowhere.
   */
  it('answers nothing for a monster the realm places in no room', () => {
    const world = withPlacements();
    expect(world.mobPlaces(world.mob('summoned wisp')!)).toBeUndefined();
  });

  /* A truncated answer that reads as a whole one is the lie a cap can tell. */
  it('caps the groups and the rooms in one, and says how many it left out', () => {
    const world = withPlacements();
    const places = world.mobPlaces(world.mob('snow cat')!, 1, 2)!;
    expect(places.spawns).toHaveLength(1);
    expect(places.more).toBe(1);
    // The count is every room, whether or not the list holds it.
    expect(places.spawns[0]!.count).toBe(3);
    expect(places.spawns[0]!.rooms).toHaveLength(2);
    // And the total is the rooms, not the groups.
    expect(places.rooms).toBe(4);
  });
});

describe('what a door costs to force', () => {
  /*
   * Both numbers, because that is what `parseInstruction` produces for this
   * raw string: `[N picklocks/strength]` records the same figure for each
   * channel. A fixture that set only `pickDifficulty` while its own `raw`
   * offered strength was crediting a warrior's strength against a lock the
   * realm had never said strength opened.
   */
  const door = (difficulty: number): Requirement => ({
    kind: 'door',
    raw: `Door [${difficulty} picklocks/strength]`,
    pickDifficulty: difficulty,
    bashDifficulty: difficulty
  });

  /** `Key: 2126 [or 157 picklocks]` — 89 exits in the shipped realm. */
  const pickOnly = (difficulty: number): Requirement => ({
    kind: 'door',
    raw: `Door [${difficulty} picklocks]`,
    pickDifficulty: difficulty
  });

  it('is a plain door when the realm asks nothing of the character', () => {
    expect(edgePenalty(door(0), {})).toBe(12);
  });

  it('is priced as a wall below the minimum, and worse the further below', () => {
    const weak = edgePenalty(door(1000), { strength: 30 })!;
    const nearly = edgePenalty(door(1000), { strength: 900 })!;
    expect(weak).toBeGreaterThan(100_000);
    expect(nearly).toBeGreaterThan(100_000);
    expect(weak).toBeGreaterThan(nearly);
    // And still a number: when there is no other way, it is the way.
    expect(edgePenalty(door(3000), { strength: 30 })).not.toBeNull();
    /*
     * The grade stays on the door's own scale. It was `wall × (1 − ratio)` on
     * top of the wall, so the gap between two doors the character could not
     * force was worth tens of thousands of plain steps, and the router walked
     * them: a strength-90 character went three maps round to prefer a 100
     * door over a 251 one.
     */
    expect(weak - nearly).toBeLessThanOrEqual(12 * 5);
    expect(weak).toBeLessThanOrEqual(100_000 + 12 * 10);
  });

  it('is close to a plain door at the minimum and cheaper well above it', () => {
    const atMinimum = edgePenalty(door(30), { strength: 30 })!;
    const easy = edgePenalty(door(30), { strength: 150 })!;
    expect(atMinimum).toBeLessThan(100);
    expect(easy).toBeLessThan(atMinimum);
    expect(easy).toBe(12);
  });

  it('takes whichever of picklocks and strength is the better, and knows nothing means neither', () => {
    expect(edgePenalty(door(30), { pickSkill: 40, strength: 5 })).toBeLessThan(100);
    expect(edgePenalty(door(30), {})!).toBeGreaterThan(100_000);
  });

  it('does not credit strength against a lock the realm says only picklocks open', () => {
    // The same character, the same number, and the only difference is whether
    // the instruction offered `/strength` at all.
    expect(edgePenalty(door(30), { strength: 200 })).toBeLessThan(100);
    expect(edgePenalty(pickOnly(30), { strength: 200 })!).toBeGreaterThan(100_000);
    expect(edgePenalty(pickOnly(30), { pickSkill: 200 })).toBeLessThan(100);
  });

  it('is a plain door when the realm records no number at all', () => {
    // `Door`, 1,015 of them in the shipped realm. The router has always priced
    // these as ordinary, and the walker forces them for the same reason.
    expect(edgePenalty({ kind: 'door', raw: 'Door' }, {})).toBe(12);
  });
});

describe('an edge the live server refused', () => {
  it('is priced as a wall, not preferred while any other way exists', () => {
    const graph = makeWorld([
      { m: 1, r: 1, n: 'A', x: { e: { m: 1, r: 2 }, s: { m: 1, r: 3 } } },
      { m: 1, r: 2, n: 'B', x: { w: { m: 1, r: 1 } } },
      { m: 1, r: 3, n: 'C', x: { n: { m: 1, r: 1 }, e: { m: 1, r: 4 } } },
      { m: 1, r: 4, n: 'D', x: { w: { m: 1, r: 3 }, n: { m: 1, r: 2 } } }
    ]);
    // Directly east is one step; the server refused it live, so the route
    // goes round — and still arrives, because a wall is a price, not a hole.
    const route = graph.route('1/1', '1/2', { refused: new Set(['1/1|e']) });
    expect(route.blocked).toBe(false);
    expect(route.steps.map((step) => step.command)).toEqual(['s', 'e', 'n']);
  });
});

describe('naming what blocked a route', () => {
  /*
   * Two rooms with one way between them, shut. The realm has no other path, so
   * the route is refused -- and the refusal used to be one line of free text
   * that named nothing.
   */
  const gated = (instruction: string): Array<Record<string, unknown>> => [
    // `i` is the exit's raw instruction, which is what the realm file carries
    // and `parseInstruction` reads -- not a pre-parsed requirement object.
    { m: 1, r: 1, n: 'Start', x: { e: { m: 1, r: 2, i: instruction } } },
    { m: 1, r: 2, n: 'Vault', x: { w: { m: 1, r: 1 } } }
  ];

  it('names the lock, and the key, on a way it cannot open', () => {
    const graph = makeWorld(gated('Key: 1124'));
    const route = graph.route(roomId(1, 1), roomId(1, 2), { keys: [], packKnown: true });
    expect(route.blocked).toBe(true);
    expect(route.blocks).toEqual([
      { kind: 'key', at: '1/1', to: '1/2', name: 'Vault', keyId: 1124 }
    ]);
    // The number, because this fixture's realm has no item table to name it
    // from — see the shipped-realm test for the sentence a real one produces.
    expect(route.reason).toContain('1124');
    expect(route.reason).toContain('Vault');
  });

  it('names the level it wanted and the level the character is', () => {
    const graph = makeWorld(gated('Level: 12 to 999'));
    const route = graph.route(roomId(1, 1), roomId(1, 2), { level: 9 });
    expect(route.blocks).toEqual([
      // No `maxLevel`: `999` is how the realm writes no ceiling.
      { kind: 'level', at: '1/1', to: '1/2', name: 'Vault', level: 9, minLevel: 12 }
    ]);
    // The number that was not met is the whole of what somebody can act on.
    expect(route.reason).toContain('12');
    expect(route.reason).toContain('9');
  });

  it('names a toll it cannot pay', () => {
    const graph = makeWorld(gated('Toll'));
    const route = graph.route(roomId(1, 1), roomId(1, 2), { wealth: 0 });
    // No price on the block: `Toll` with no number is a gate the realm did not
    // price, and inventing one would be worse than saying nothing.
    expect(route.blocks).toEqual([
      { kind: 'toll', at: '1/1', to: '1/2', name: 'Vault', purseCopper: 0 }
    ]);
  });

  /*
   * The reported failure, said in words somebody can act on.
   *
   * *"you have nothing to pay it with"* was the only thing this could say while
   * the price went unread, and it is wrong for a character holding money that
   * is merely not enough. The number that was not met is the whole of what
   * anybody can do something about — the rule the level gate above follows.
   */
  it('states what a priced toll costs and what the purse holds', () => {
    const graph = makeWorld(gated('Toll: 5'));
    const route = graph.route(roomId(1, 1), roomId(1, 2), { wealth: 200 });
    expect(route.blocks).toEqual([
      { kind: 'toll', at: '1/1', to: '1/2', name: 'Vault', tollCopper: 500, purseCopper: 200 }
    ]);
    // Whole gold where it divides evenly, which is how the realm prices tolls
    // and how the server says it on the wire (`5 gold crowns`).
    expect(route.reason).toContain('5 gold');
    expect(route.reason).toContain('2 gold');
  });

  /* A purse that is not a whole number of gold keeps its own unit rather than
     being rounded into a coin nobody is holding. */
  it('states an odd purse in the coin it is actually in', () => {
    const graph = makeWorld(gated('Toll: 5'));
    const route = graph.route(roomId(1, 1), roomId(1, 2), { wealth: 237 });
    expect(route.reason).toContain('237 copper');
  });

  /*
   * Every condition, not the first. Clearing one and being refused again by a
   * condition that was there all along is the failure `HangUp`'s accumulated
   * `reasons[]` already exists to prevent.
   */
  it('accumulates, so clearing one gate does not surprise you with the next', () => {
    const graph = makeWorld([
      {
        m: 1,
        r: 1,
        n: 'Start',
        x: { e: { m: 1, r: 2, i: 'Level: 12 to 999' } }
      },
      {
        m: 1,
        r: 2,
        n: 'Middle',
        x: { e: { m: 1, r: 3, i: 'Key: 7' }, w: { m: 1, r: 1 } }
      },
      { m: 1, r: 3, n: 'End', x: { w: { m: 1, r: 2 } } }
    ]);
    const route = graph.route(roomId(1, 1), roomId(1, 3), {
      level: 9,
      keys: [],
      packKnown: true
    });
    expect(route.blocks?.map((block) => block.kind)).toEqual(['level', 'key']);
    // In walking order, so the first one met is the first one read.
    expect(
      route.blocks?.map((block) => (block.kind === 'unreachable' ? null : block.name))
    ).toEqual(['Middle', 'End']);
  });

  it('says so plainly when the two rooms are not joined at all', () => {
    const graph = makeWorld([
      { m: 1, r: 1, n: 'Start', x: {} },
      { m: 1, r: 2, n: 'Island', x: {} }
    ]);
    const route = graph.route(roomId(1, 1), roomId(1, 2));
    expect(route.blocks).toEqual([{ kind: 'unreachable' }]);
  });

  it('reports nothing when there is a way round', () => {
    // The gate is real, and irrelevant: a route that exists is not a refusal,
    // and naming a door nobody has to open would be noise.
    const graph = makeWorld([
      {
        m: 1,
        r: 1,
        n: 'Start',
        x: { e: { m: 1, r: 2, i: 'Key: 7' }, s: { m: 1, r: 3 } }
      },
      { m: 1, r: 2, n: 'Vault', x: {} },
      { m: 1, r: 3, n: 'Long way', x: { e: { m: 1, r: 2 } } }
    ]);
    const route = graph.route(roomId(1, 1), roomId(1, 2), { keys: [] });
    expect(route.blocked).toBe(false);
    expect(route.blocks).toBeUndefined();
  });

  /*
   * `edgeBlock` is a second reading of the same decisions `edgePenalty` makes,
   * kept separate because one runs in the A* hot loop and the other only along
   * a found path. Separate readings drift, so they are asserted against each
   * other: a pruned edge with no block would refuse in silence, and a block on
   * a priced edge would name a gate the character can walk through.
   *
   * **Driven off `REQUIREMENT_KINDS`, not off a list here.** The list here is
   * what let the class gate ship pruning with nothing to say about it: it was
   * added to `edgePenalty` in todo 03 and to neither this file nor
   * `edgeBlock`, so a route stopped by a class gate reported that the two
   * rooms were not joined in the data. Every kind now has to appear, and the
   * assertion below fails the build for one that does not.
   */
  it('agrees with edgePenalty about what is impassable', () => {
    const requirements: Requirement[] = [
      { kind: 'key', raw: 'Key: 1', keyId: 1 },
      { kind: 'key', raw: 'Key: 1 [or 30]', keyId: 1, pickDifficulty: 30 },
      { kind: 'level', raw: 'L', minLevel: 12 },
      { kind: 'level', raw: 'L', maxLevel: 3 },
      { kind: 'level', raw: 'L', minLevel: 1, maxLevel: 999 },
      { kind: 'toll', raw: 'Toll' },
      { kind: 'door', raw: 'Door' },
      { kind: 'trap', raw: 'Trap', damage: 5 },
      { kind: 'hidden', raw: 'Hidden', searchable: true },
      { kind: 'text', raw: 'Text: go path' },
      { kind: 'class', raw: 'Class: 3 OK, 0 NO', classOk: 3 },
      { kind: 'class', raw: 'Class: 0 OK, 3 NO', classNo: 3 },
      { kind: 'race', raw: 'Race: 13 OK, 0 NO', raceOk: 13 },
      { kind: 'race', raw: 'Race: 0 OK, 13 NO', raceNo: 13 },
      {
        kind: 'alignment',
        raw: 'Alignment: Saint to Seedy',
        minAlignment: 'Saint',
        maxAlignment: 'Seedy'
      },
      { kind: 'alignment', raw: 'Alignment: ??? to ???' },
      { kind: 'ability', raw: 'Ability: 152 w/value 1 to 1', abilityId: 152 },
      { kind: 'ability', raw: 'Ability: 0 w/value 0 to 0' },
      { kind: 'cast', raw: 'Cast: pre-0, post-1257', castPost: 1257, spellEffect: 'relocates' },
      { kind: 'cast', raw: 'Cast: pre-0, post-702', castPost: 702, spellEffect: 'script' },
      { kind: 'cast', raw: 'Cast: pre-0, post-310', castPost: 310, spellEffect: 'plain' },
      { kind: 'cast', raw: 'Cast: pre-0, post-0' },
      { kind: 'spell', raw: 'Spell Trap: 905', spellId: 905, spellEffect: 'plain', damage: 16 },
      { kind: 'spell', raw: 'Spell Trap: 1', spellId: 1, spellEffect: 'relocates' },
      { kind: 'item', raw: 'Item: 191', keyId: 191 },
      { kind: 'item', raw: 'Item: 0' },
      // A lever that wants an item is the one hidden shape that can be a
      // wall — todo 13 — so both halves are asked about it, with the item
      // among the keys one traveller carries and absent from the other's.
      {
        kind: 'hidden',
        raw: 'Hidden/Needs 1 Actions, any order',
        actionsNeeded: 1,
        actions: [{ say: ['hold up talisman'], item: 191 }]
      },
      {
        kind: 'hidden',
        raw: 'Hidden/Needs 2 Actions, any order',
        actionsNeeded: 2,
        actions: [
          { say: ['pull lever'] },
          { say: ['raise idol'], item: 3544, at: { map: 1, room: 9 } }
        ]
      },
      { kind: 'timed', raw: 'Timed: 0*5 minutes' },
      { kind: 'unknown', raw: '?' }
    ];
    // Every kind the union names has to be exercised, or the agreement below
    // is an agreement about the kinds somebody remembered.
    expect(new Set(requirements.map((entry) => entry.kind))).toEqual(new Set(REQUIREMENT_KINDS));

    const travellers: Traveller[] = [
      {},
      // A pack nobody has listed, and the same pack listed and empty: the two
      // the `packKnown` flag exists to tell apart, and the pair that would
      // silently agree if it were dropped.
      { level: 9, wealth: 0, keys: [] },
      { level: 9, wealth: 0, keys: [], packKnown: true },
      { level: 40, wealth: 500, keys: [1, 191], packKnown: true },
      { level: null, wealth: null, keys: [] },
      { classId: 3, raceId: 13, alignment: 'Good' },
      { classId: 6, raceId: 2, alignment: 'FIEND' },
      { classId: null, raceId: null, alignment: null }
    ];
    for (const requirement of requirements) {
      for (const traveller of travellers) {
        const pruned = edgePenalty(requirement, traveller) === null;
        const blocked = edgeBlock(requirement, traveller) !== null;
        expect(blocked, `${requirement.raw} / ${JSON.stringify(traveller)}`).toBe(pruned);
      }
    }
  });
});

describe('describeBlock', () => {
  /*
   * The union and the runtime list that renders it move together. A kind added
   * to `RouteBlock` and not described here is a route that refuses in silence,
   * which is exactly the failure this pair of halves exists to catch.
   */
  const sample: Record<(typeof ROUTE_BLOCK_KINDS)[number], RouteBlock> = {
    key: { kind: 'key', at: '1/1', to: '1/2', name: 'Vault', keyId: 3 },
    level: { kind: 'level', at: '1/1', to: '1/2', name: 'Vault', level: 9, minLevel: 12 },
    toll: { kind: 'toll', at: '1/1', to: '1/2', name: 'Bridge' },
    carry: {
      kind: 'carry',
      at: '1/1',
      to: '1/2',
      name: 'Cliff Edge',
      itemId: 191,
      itemName: 'rope and grapple'
    },
    born: {
      kind: 'born',
      at: '1/1',
      to: '1/2',
      name: 'Crypt, Shadowed Hall',
      condition: 'class',
      mine: 'Paladin',
      admits: 'Warlock'
    },
    unreachable: { kind: 'unreachable' }
  };

  for (const kind of ROUTE_BLOCK_KINDS) {
    it(`says something about a ${kind} block`, () => {
      expect(describeBlock(sample[kind]).length).toBeGreaterThan(0);
    });
  }

  it('says the lock is shut when the realm does not name a key', () => {
    expect(describeBlock({ kind: 'key', at: '1/1', to: '1/2', name: 'Vault' })).toContain('locked');
  });

  it('does not claim a level the character has not been told yet', () => {
    // Unknown is never the reassuring answer, and it is never a number either.
    const said = describeBlock({
      kind: 'level',
      at: '1/1',
      to: '1/2',
      name: 'Vault',
      level: null,
      minLevel: 12
    });
    expect(said).toContain('not known');
  });
});

/*
 * Room-script teleports — `dive pool`, `go vortex` — given to the router. Only
 * the tranche whose conditions it can genuinely evaluate is linked: a
 * destination in the dataset and guards that are nothing but a level gate.
 * Everything else stays a fact the Room card states, because a route through a
 * condition the client cannot read is how a character is walked somewhere it
 * cannot get back from (mme.md §6).
 */
describe('routing through room-script teleports', () => {
  /** Two islands joined only by the script on Pool Edge. */
  const portalWorld = (cmd: Record<string, unknown>): WorldGraph =>
    makeWorld([
      { m: 1, r: 1, n: 'Shore', x: { e: { m: 1, r: 2 } } },
      { m: 1, r: 2, n: 'Pool Edge', x: { w: { m: 1, r: 1 } }, cmd: [cmd] },
      { m: 2, r: 1, n: 'Far Cavern', x: {} }
    ]);

  it('routes across a teleport no exit records, sending the phrase', () => {
    const graph = portalWorld({ say: ['dive pool', 'enter pool'], to: '2/1' });
    const route = graph.route('1/1', '2/1');
    expect(route.blocked).toBe(false);
    const last = route.steps.at(-1)!;
    expect(last.command).toBe('dive pool');
    expect(last.direction).toBe('portal');
    expect(last.to).toBe('2/1');
  });

  it('prefers a plain corridor over a portal that saves nothing', () => {
    const graph = makeWorld([
      { m: 1, r: 1, n: 'A', x: { e: { m: 1, r: 2 } }, cmd: [{ say: ['go rift'], to: '1/3' }] },
      { m: 1, r: 2, n: 'B', x: { e: { m: 1, r: 3 }, w: { m: 1, r: 1 } } },
      { m: 1, r: 3, n: 'C', x: {} }
    ]);
    const route = graph.route('1/1', '1/3');
    expect(route.blocked).toBe(false);
    expect(route.steps.map((step) => step.command)).toEqual(['e', 'e']);
  });

  it('reads a level gate exactly as an exit level gate, and explains a refusal', () => {
    const gated = { say: ['go vortex'], to: '2/1', need: ['minlevel 20'] };
    expect(portalWorld(gated).route('1/1', '2/1', { level: 25 }).blocked).toBe(false);
    const refused = portalWorld(gated).route('1/1', '2/1', { level: 10 });
    expect(refused.blocked).toBe(true);
    expect(refused.blocks?.some((block) => block.kind === 'level')).toBe(true);
  });

  it('never routes through a script whose conditions it cannot read', () => {
    const graph = portalWorld({ say: ['go vortex'], to: '2/1', need: ['nomonsters'] });
    expect(graph.route('1/1', '2/1').blocked).toBe(true);
  });

  it('ignores a teleport pointing outside the dataset', () => {
    const graph = portalWorld({ say: ['go rift'], to: '9/999' });
    expect(graph.route('1/1', '9/999').blocked).toBe(true);
  });

  it('avoids a portal the server refused this session', () => {
    const graph = portalWorld({ say: ['dive pool'], to: '2/1' });
    const route = graph.route('1/1', '2/1', { refused: new Set(['1/2|portal']) });
    // The wall is a price, not a prune: with no other way at all the portal
    // is still the route, priced so anything else would have won.
    expect(route.blocked).toBe(false);
    expect(route.cost).toBeGreaterThan(100_000);
  });
});

/*
 * The entity builders — the join between what the wire saw and what the realm
 * knows, made in main so the renderer never has to ask.
 *
 * The cases that matter are the *absences*: a realm that has never heard of
 * something must still produce a whole entity, because a derivative realm is
 * ordinary and a client that degraded to nothing there would be worse than one
 * that never looked anything up.
 */
describe('building entities', () => {
  /** A world with one item, one monster and a shop, for the joins. */
  const built = (): WorldGraph => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-world-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = JSON.stringify({
      v: 18,
      source: 'test',
      rooms: 2,
      generatedAt: 'x',
      items: [
        {
          id: 7,
          n: 'padded helm',
          price: 120,
          enc: 4,
          type: 2,
          worn: 5,
          ngt: 1,
          ndr: 1,
          lim: 3
        },
        { id: 9, n: 'rusty key' },
        { id: 11, n: 'shiny bauble', price: 5 }
      ],
      mobs: [
        {
          n: 'giant rat',
          hp: 12,
          hi: 20,
          d: 'h',
          ac: 3,
          fol: 100,
          und: 1,
          drops: ['shiny bauble'],
          ty: [2],
          dmg: 6,
          cast: [41],
          ds: 99
        },
        { n: 'mariana', hp: 40, d: 'p' }
      ],
      shops: [{ id: 202, t: 1, i: [] }]
    });
    const rooms = [
      {
        m: 1,
        r: 1,
        n: "Mariana's Clothing",
        s: 202,
        npc: 500,
        x: { e: { m: 1, r: 2, i: 'Key: 9' } }
      },
      { m: 1, r: 2, n: 'Back Room', li: -50, x: {} }
    ];
    const body = [header, ...rooms.map((r) => JSON.stringify(r))].join('\n') + '\n';
    fs.writeFileSync(file, zlib.gzipSync(body));
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  };

  describe('an item', () => {
    it('joins the realm’s row and keeps what the listing observed', () => {
      const item = built().buildItemEntity('padded helm', {
        slot: 'Head',
        equipped: true,
        charges: 2
      });
      expect(item).toMatchObject({
        name: 'padded helm',
        source: 'hybrid',
        slot: 'Head',
        equipped: true,
        charges: 2,
        id: 7,
        price: 120,
        encumbrance: 4,
        wornSlotCode: 5,
        gettable: false,
        notDroppable: true,
        limit: 3
      });
    });

    /*
     * The dual-source rule. A derivative realm, an uncatalogued item, or a
     * session with no realm file at all: the entity is whole and says the
     * realm contributed nothing.
     */
    it('is whole for a name the realm has never heard of', () => {
      const item = built().buildItemEntity('gnarled widget', { slot: null });
      expect(item).toEqual({
        name: 'gnarled widget',
        source: 'wire',
        slot: null,
        equipped: false,
        charges: null
      });
      expect(item.price).toBeUndefined();
    });

    /* A shelf or a drop table is the realm alone, and says so — which is what
       lets a card distinguish "the realm says this shop stocks it" from "this
       is in your pack". */
    it('is mdb where nothing was observed against it', () => {
      expect(built().buildItemEntity('padded helm').source).toBe('mdb');
    });
  });

  describe('a monster', () => {
    it('joins the realm’s row and resolves its drops to entities', () => {
      const mob = built().buildMobEntity('giant rat', { charmed: true });
      expect(mob).toMatchObject({
        name: 'giant rat',
        rawName: 'giant rat',
        source: 'hybrid',
        charmed: true,
        disposition: 'hostile',
        hp: 20,
        span: [12, 20],
        armour: 3,
        follows: 100,
        undead: true,
        realmType: 2
      });
      // Resolved, not a bare name: choosing a target by what it carries is
      // the question a string could not answer.
      expect(mob.drops?.[0]).toMatchObject({ name: 'shiny bauble', price: 5, source: 'mdb' });
    });

    /* Uncatalogued, and therefore not safe: a null disposition is never read
       as passive, and attacking it is not known to be free. */
    it('is whole and unplaced for a monster the realm cannot name', () => {
      const mob = built().buildMobEntity('thing from the deep');
      expect(mob).toEqual({
        name: 'thing from the deep',
        rawName: 'thing from the deep',
        source: 'wire',
        charmed: false,
        disposition: null,
        uncertain: false,
        costly: 'never'
      });
    });

    /* `MobNameModifierType` hangs a word off either end, so the room's
       spelling and the table's differ — and a command must use the room's. */
    it('keeps the wire’s spelling beside the realm’s', () => {
      const mob = built().buildMobEntity('large giant rat');
      expect(mob.rawName).toBe('large giant rat');
      expect(mob.name).toBe('giant rat');
      expect(mob.source).toBe('hybrid');
    });
  });

  describe('the creature a room holds', () => {
    /* `Rooms.NPC` joined to the room's own shop — the only sound source for a
       role, since `Monsters.Type` was measured and does not say. */
    it('names the shopkeeper from the room’s shop, not from the monster row', () => {
      const graph = built();
      const room = graph.get(1, 1)!;
      expect(room.npcId).toBe(500);
      // The row is not in this fixture's monster index, so nothing is claimed.
      expect(graph.buildNpcEntity(room)).toBeNull();
    });

    it('is null for a room the realm ties nobody to', () => {
      const graph = built();
      expect(graph.buildNpcEntity(graph.get(1, 2)!)).toBeNull();
    });
  });

  describe('the ways out', () => {
    it('joins the destination, its name and the key the passage wants', () => {
      const graph = built();
      const exits = graph.buildExitEntities(
        [{ direction: 'e', note: 'closed gate' }],
        graph.get(1, 1)
      );
      expect(exits[0]).toMatchObject({
        direction: 'e',
        note: 'closed gate',
        targetMap: 1,
        targetRoom: 2,
        targetName: 'Back Room',
        // The realm records the far side as dark; the phrase the server prints
        // on arrival is a different claim and is not this.
        dark: true
      });
      expect(exits[0]?.keyItem).toMatchObject({ name: 'rusty key' });
    });

    /*
     * The wire leads. An exit the server printed is real whatever the realm
     * says, so a direction the realm does not know still produces an entity —
     * with the destination left null rather than invented.
     */
    it('keeps an exit the realm knows nothing about', () => {
      const graph = built();
      const exits = graph.buildExitEntities([{ direction: 'w', note: null }], graph.get(1, 1));
      expect(exits[0]).toEqual({
        direction: 'w',
        note: null,
        targetMap: null,
        targetRoom: null,
        targetName: null,
        requirement: null
      });
    });

    it('works with no realm room at all', () => {
      const exits = built().buildExitEntities([{ direction: 'n', note: null }], null);
      expect(exits).toHaveLength(1);
      expect(exits[0]?.targetRoom).toBeNull();
    });
  });
});

/**
 * The quest book's joins: a step's room named, and its items placed.
 *
 * `indexQuests` names every item a step demands and stops there — a quest item
 * is not in `neededItems`, so `indexItems` gives most of them no `shops` and no
 * `mobs`. `WorldGraph.quests()` joins the two indexes the file already holds,
 * and these hold both halves of that join and the refusal in between.
 */
describe('the quest book’s item and room joins', () => {
  /** A world with one room, one shop, one monster and one quest step. */
  function questWorld(step: Record<string, unknown>): WorldGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-quests-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = JSON.stringify({
      v: 25,
      source: 'test',
      rooms: 1,
      generatedAt: 'x',
      items: [
        { id: 10, n: 'adamant ore' },
        { id: 11, n: 'serpent ring' },
        { id: 12, n: 'quest token' }
      ],
      shops: [{ id: 1, n: 'Stonemill General', items: [10], t: 0 }],
      mobs: [{ n: 'hanging cocoon', hp: 400, drops: ['serpent ring'] }],
      quests: [{ id: 131, name: 'TestQuest', steps: [step] }]
    });
    const body =
      [header, JSON.stringify({ m: 1, r: 5, n: 'Temple of Ashes', x: {} })].join('\n') + '\n';
    fs.writeFileSync(file, zlib.gzipSync(body));
    const graph = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return graph;
  }

  const bare = { block: 1, say: [], needs: [], takes: [], gives: [] };

  it('names the room a step’s NPC stands in', () => {
    const graph = questWorld({ ...bare, who: 'Morukai', room: '1/5' });
    expect(graph.quests()[0]?.steps[0]?.place).toBe('Temple of Ashes');
  });

  it('leaves a room the realm no longer has unnamed, keeping its address', () => {
    const graph = questWorld({ ...bare, who: 'Morukai', room: '9/9999' });
    const step = graph.quests()[0]?.steps[0];
    expect(step?.room).toBe('9/9999');
    expect(step?.place).toBeUndefined();
  });

  it('finds the shop that stocks an item the step demands', () => {
    const graph = questWorld({
      ...bare,
      needs: [{ kind: 'item', id: 10, name: 'adamant ore' }],
      takes: [{ id: 10, name: 'adamant ore' }]
    });
    const sources = graph.quests()[0]?.steps[0]?.sources;
    expect(sources).toEqual([{ id: 10, shops: ['Stonemill General'] }]);
  });

  /*
   * The half that matters most: `serpent ring` is in no shop's stock and has no
   * `mobs` of its own, because `indexItems` was never asked for it. The monster
   * index names it, and the match is on the name the realm gave both.
   */
  it('finds the monster that drops an item the item index does not place', () => {
    const graph = questWorld({
      ...bare,
      takes: [{ id: 11, name: 'serpent ring' }]
    });
    expect(graph.quests()[0]?.steps[0]?.sources).toEqual([{ id: 11, mobs: ['hanging cocoon'] }]);
  });

  it('says nothing at all about an item the realm places nowhere', () => {
    const graph = questWorld({
      ...bare,
      takes: [{ id: 12, name: 'quest token' }]
    });
    // Not an empty record and not a "no known source" string: the name and
    // stop, which is what `localMap` already does for a key with no source.
    expect(graph.quests()[0]?.steps[0]?.sources).toBeUndefined();
  });

  it('states an item once when the step both checks it and takes it', () => {
    const graph = questWorld({
      ...bare,
      needs: [{ kind: 'item', id: 10, name: 'adamant ore' }],
      takes: [{ id: 10, name: 'adamant ore' }],
      gives: []
    });
    expect(graph.quests()[0]?.steps[0]?.sources).toHaveLength(1);
  });

  it('computes the join once and hands back the same book', () => {
    const graph = questWorld({ ...bare, who: 'Morukai', room: '1/5' });
    expect(graph.quests()).toBe(graph.quests());
  });

  describe('on the realm that ships', () => {
    const REALM = path.resolve('resources/world/paradigm.jsonl.gz');
    const realm = fs.existsSync(REALM) ? WorldGraph.load(REALM) : null;
    /*
     * On the realm being *present*, never on it having quests. Gating on the
     * subject means a build that stopped assembling quests altogether skips
     * every assertion below and the suite stays green — which is the shape of
     * a check that can only ever agree with the code.
     */
    const has = realm !== null && realm.size > 0;

    it.runIf(has)('assembles a book at all, which the rest of these assume', () => {
      expect(realm!.quests().length).toBeGreaterThan(20);
    });

    it.runIf(has)('places a real share of what the quests ask for', () => {
      let wanted = 0;
      let placed = 0;
      for (const quest of realm!.quests()) {
        for (const step of quest.steps) {
          const ids = new Set([
            ...step.needs.flatMap((gate) => (gate.kind === 'item' ? [gate.id] : [])),
            ...step.takes.map((item) => item.id)
          ]);
          wanted += ids.size;
          placed += step.sources?.length ?? 0;
        }
      }
      /*
       * A figure, not a ratio: the point is that the join answers a real share
       * of the question and that the rest is silence. It was 32 of 86 before
       * the monsters' own drop lists were read from the other direction.
       */
      expect(wanted).toBeGreaterThan(50);
      expect(placed).toBeGreaterThan(wanted / 4);
      expect(placed).toBeLessThan(wanted);
    });

    /*
     * A block holds one line per class on the long chains, and those lines are
     * alternatives. Unioned into one step they said *be a Warrior and a
     * Witchunter*, *be level 22 and level 20*, and *take all fifteen classes'
     * perks* — which is a wrong answer, not a long one. `shareRoutes` keeps
     * them apart, and nothing but the realm that ships can prove it stayed
     * apart through the conversion.
     */
    it.runIf(has)('never states two classes or two levels as one step’s demands', () => {
      const contradictory = realm!
        .quests()
        .flatMap((quest) => quest.steps)
        .filter(
          (step) =>
            step.needs.filter((gate) => gate.kind === 'class').length > 1 ||
            step.needs.filter((gate) => gate.kind === 'level').length > 1
        );
      expect(contradictory).toEqual([]);
    });

    it.runIf(has)('hands the class routes back whole, each with its own reward', () => {
      const routed = realm!
        .quests()
        .flatMap((quest) => quest.steps)
        .filter((step) => step.ways !== undefined);
      // 23 of the shipped realm's 251 steps, across the three great chains and
      // seven shorter ones. A build that quietly stopped splitting them would
      // otherwise read as the book simply having got longer.
      expect(routed.length).toBeGreaterThan(10);
      // Every route names at most one class, and none is empty — an empty
      // route means "no extra condition", which `shareRoutes` folds away
      // rather than offering as a choice between something and nothing.
      for (const step of routed) {
        for (const way of step.ways ?? []) {
          expect(way.needs.filter((gate) => gate.kind === 'class').length).toBeLessThan(2);
          expect(way.needs.length + way.takes.length + way.gives.length).toBeGreaterThan(0);
        }
      }
    });

    /*
     * The three that state their level on every route and nothing on the line
     * the routes share. Read off `needs` alone they were quests with no level
     * requirement at all, which is the reassuring lie: a level-1 character
     * would have walked to a master assassin on the strength of a blank cell.
     */
    it.runIf(has)('states a level for a quest that gates on it per route', () => {
      for (const name of ['Smash', 'PerfectStealth', 'Meditate']) {
        const quest = realm!.quests().find((entry) => entry.name === name);
        expect(quest === undefined ? name : questLevel(quest)).toBeGreaterThan(0);
      }
    });

    it.runIf(has)('names the room for most of the steps that trace to somebody', () => {
      const sited = realm!
        .quests()
        .flatMap((quest) => quest.steps)
        .filter((step) => step.room !== undefined);
      expect(sited.length).toBeGreaterThan(100);
      expect(sited.every((step) => step.place !== undefined)).toBe(true);
    });
  });
});

/*
 * A lever that wants an item — Paradigm's `hold up talisman` north out of
 * 2/687, `lift up talisman (Item: 815)` in the realm's own cell. The server
 * refuses the phrase without the item in the pack, so for a listed pack
 * lacking it the passage is a wall, and the refusal names the item; with it,
 * the passage costs what a lever costs; unlisted, it is an unevaluated gate
 * like a keyed door nobody has looked in the pack for (todo 13).
 */
describe('a lever that needs an item', () => {
  const passage = (): Array<Record<string, unknown>> => [
    {
      m: 1,
      r: 1,
      n: 'Dragon’s Teeth Hills',
      x: {
        n: {
          m: 1,
          r: 2,
          i: 'Hidden/Needs 1 Actions, any order',
          a: [{ say: ['hold up talisman', 'hold up amber talisman'], item: 815 }]
        }
      }
    },
    { m: 1, r: 2, n: 'Secret Passage', x: { s: { m: 1, r: 1 } } }
  ];

  it('is a wall for a listed pack without the item, and says which item', () => {
    const graph = makeWorld(passage());
    const route = graph.route(roomId(1, 1), roomId(1, 2), { packKnown: true, keys: [] });
    expect(route.blocked).toBe(true);
    expect(route.blocks).toEqual([
      { kind: 'carry', at: '1/1', to: '1/2', name: 'Secret Passage', itemId: 815 }
    ]);
    expect(route.reason).toContain('815');
    expect(route.reason).toContain('Secret Passage');
  });

  it('costs a lever with the item carried, and an unevaluated gate while the pack is unlisted', () => {
    const graph = makeWorld(passage());
    const carrying = graph.route(roomId(1, 1), roomId(1, 2), { packKnown: true, keys: [815] });
    expect(carrying.blocked).toBe(false);
    expect(carrying.cost).toBe(1 + 25 + 5);
    expect(carrying.steps[0]?.requirement?.actions?.[0]?.item).toBe(815);

    const unlisted = graph.route(roomId(1, 1), roomId(1, 2), { keys: [] });
    expect(unlisted.blocked).toBe(false);
    expect(unlisted.cost).toBe(1 + 60);
  });

  it('drops a lever list naming an item that is not one, keeping the exit expensive', () => {
    const graph = makeWorld([
      {
        m: 1,
        r: 1,
        n: 'Here',
        x: {
          n: {
            m: 1,
            r: 2,
            i: 'Hidden/Needs 1 Actions, any order',
            a: [{ say: ['pull lever'], item: -5 }]
          }
        }
      },
      { m: 1, r: 2, n: 'There', x: {} }
    ]);
    const route = graph.route(roomId(1, 1), roomId(1, 2), { packKnown: true, keys: [] });
    // No levers read, so the exit is priced as one whose levers are elsewhere.
    expect(route.blocked).toBe(false);
    expect(route.cost).toBe(1 + 200);
    expect(route.steps[0]?.requirement?.actions).toBeUndefined();
  });
});

/*
 * What waits in a room is part of the way through it. `Traveller.danger`
 * says what a room's lair is expected to cost as a share of the health bar,
 * the router prices it (`dangerPenalty`), and past `deadlyShare` the room is
 * a wall — walked only when there is no other way, and said to be.
 */
describe('what waits in a room prices the way through it', () => {
  /* Gate → Lair → Keep is two steps; Gate → Long Way → Longer Way → Keep is three. */
  const twoWays = (): Array<Record<string, unknown>> => [
    { m: 1, r: 1, n: 'Gate', x: { n: { m: 1, r: 2 }, e: { m: 1, r: 3 } } },
    { m: 1, r: 2, n: 'Lair', lair: '(Max 1): 7,', x: { s: { m: 1, r: 1 }, n: { m: 1, r: 4 } } },
    { m: 1, r: 3, n: 'Long Way', x: { w: { m: 1, r: 1 }, n: { m: 1, r: 5 } } },
    { m: 1, r: 5, n: 'Longer Way', x: { s: { m: 1, r: 3 }, w: { m: 1, r: 4 } } },
    { m: 1, r: 4, n: 'Keep', x: { s: { m: 1, r: 2 }, e: { m: 1, r: 5 } } }
  ];
  const lairs = (share: number) => (room: { name: string }) =>
    room.name === 'Lair' ? share : null;

  it('walks straight through when nothing is weighed', () => {
    const route = makeWorld(twoWays()).route(roomId(1, 1), roomId(1, 4), {});
    expect(route.steps.map((step) => step.name)).toEqual(['Lair', 'Keep']);
    expect(route.steps.every((step) => step.danger === undefined)).toBe(true);
  });

  it('goes round a lair that would cost more than the detour', () => {
    // Half the bar is 200 on the step; the detour is one more room.
    const route = makeWorld(twoWays()).route(roomId(1, 1), roomId(1, 4), { danger: lairs(0.5) });
    expect(route.steps.map((step) => step.name)).toEqual(['Long Way', 'Longer Way', 'Keep']);
    expect(route.cost).toBe(3);
  });

  it('walks through a lair cheaper than the detour, and says what it costs', () => {
    // A fifth of a percent of the bar rounds to nothing on the step, and the
    // step still says what waits there.
    const route = makeWorld(twoWays()).route(roomId(1, 1), roomId(1, 4), { danger: lairs(0.002) });
    expect(route.steps.map((step) => step.name)).toEqual(['Lair', 'Keep']);
    expect(route.steps[0]?.danger).toBe(0.002);
    expect(route.steps[0]?.deadly).toBeUndefined();
    expect(route.cost).toBe(2 + Math.round((0.002 * 200) / 0.998));
    // Two percent is already dearer than the one-room detour.
    const round = makeWorld(twoWays()).route(roomId(1, 1), roomId(1, 4), { danger: lairs(0.02) });
    expect(round.steps.map((step) => step.name)).toEqual(['Long Way', 'Longer Way', 'Keep']);
  });

  /*
   * A slope and not a cliff. The old price was forty a bar, linear, with the
   * wall at one: a pass expected to take 99% of the bar cost thirty-nine
   * steps and one expected to take all of it a hundred thousand.
   */
  it('prices a pass ever more steeply as it approaches the whole bar', () => {
    expect(dangerPenalty(0.1)).toBe(22);
    expect(dangerPenalty(0.5)).toBe(200);
    expect(dangerPenalty(0.9)).toBe(1800);
    expect(dangerPenalty(0.99)).toBe(19_800);
    // Just short of deadly is dear and still not a wall; deadly is the wall.
    expect(dangerPenalty(0.999_999_9)).toBe(100_000);
    expect(dangerPenalty(1)).toBe(100_000);
    expect(dangerPenalty(31)).toBe(100_000);
    expect(dangerPenalty(0)).toBe(0);
    expect(dangerPenalty(null)).toBe(0);
  });

  it('walls a deadly lair, walks it when there is no other way, and marks the step', () => {
    const graph = makeWorld(twoWays());
    const round = graph.route(roomId(1, 1), roomId(1, 4), { danger: lairs(1.2) });
    expect(round.steps.map((step) => step.name)).toEqual(['Long Way', 'Longer Way', 'Keep']);

    // Only the lair leads on: still offered, priced as a wall, and said.
    const onlyWay = makeWorld(twoWays().filter((room) => room['r'] !== 3 && room['r'] !== 5));
    const through = onlyWay.route(roomId(1, 1), roomId(1, 4), { danger: lairs(1.2) });
    expect(through.blocked).toBe(false);
    expect(through.steps.map((step) => step.name)).toEqual(['Lair', 'Keep']);
    expect(through.cost).toBeGreaterThanOrEqual(100_000);
    expect(through.steps[0]).toMatchObject({ danger: 1.2, deadly: true });
    // Nothing gated stood on a shorter way, so nothing is claimed to be needed.
    expect(through.blocks).toBeUndefined();
  });

  it('prices an unknown lair as nothing, never as a wall', () => {
    const route = makeWorld(twoWays()).route(roomId(1, 1), roomId(1, 4), { danger: () => null });
    expect(route.steps.map((step) => step.name)).toEqual(['Lair', 'Keep']);
    expect(route.cost).toBe(2);
  });
});

/*
 * A route offered through a wall is not the way anybody would choose, so it
 * carries what the shorter way needed: the reader is told *needs the key*
 * rather than handed a walk through a door that will not open (todo 13).
 */
describe('what a room does to whoever stands in it prices the way through it', () => {
  /*
   * The Silver River in miniature. Pier → River → River → Landing is the short
   * way and every river room casts something; Pier → Street → Road → Gate →
   * Landing is the long way and casts nothing.
   */
  /**
   * `dry` rooms of dry land against two of river, so which way is cheaper
   * turns on what the river costs rather than on the shape of the fixture.
   */
  const bothWays = (dry: number): Array<Record<string, unknown>> => [
    { m: 1, r: 1, n: 'Pier', x: { n: { m: 1, r: 2 }, e: { m: 1, r: 10 } } },
    { m: 1, r: 2, n: 'River', sp: 753, x: { s: { m: 1, r: 1 }, n: { m: 1, r: 3 } } },
    { m: 1, r: 3, n: 'River', sp: 753, x: { s: { m: 1, r: 2 }, n: { m: 1, r: 4 } } },
    ...Array.from({ length: dry }, (_, index) => ({
      m: 1,
      r: 10 + index,
      n: 'Street',
      x: {
        [index === 0 ? 'w' : 's']: { m: 1, r: index === 0 ? 1 : 9 + index },
        [index + 1 === dry ? 'w' : 'n']: { m: 1, r: index + 1 === dry ? 4 : 11 + index }
      }
    })),
    { m: 1, r: 4, n: 'Landing', x: { s: { m: 1, r: 3 }, e: { m: 1, r: 10 + dry - 1 } } }
  ];
  const header = {
    items: [{ id: 690, n: 'log raft' }],
    spells: [{ id: 753, n: 'river damage', hz: { d: 15, av: [690] } }]
  };
  const world = (dry = 3) => makeWorld(bothWays(dry), header, 30);
  /** The session's own arithmetic, in miniature: damage over the bar, unless carried. */
  const hazardFor = (graph: WorldGraph, hp: number, keys: number[]) => (room: WorldRoom) => {
    const hazard = graph.hazardOf(room);
    if (hazard === null || hazardAvoided(hazard, keys)) return null;
    return (hazard.damage ?? 0) / hp;
  };

  /*
   * The bug this is all for. `Rooms.Spell` had been in the realm file since
   * format 13 and nothing read it, so the whole Silver River was priced at one
   * step a room and a route from the Pier to the Gnoll Encampment went eighty-
   * eight rooms down it rather than a hundred and four through the slums.
   */
  it('walked the short way for free while nothing read the room’s spell', () => {
    const route = world().route(roomId(1, 1), roomId(1, 4), {});
    expect(route.steps.map((step) => step.name)).toEqual(['River', 'River', 'Landing']);
  });

  it('goes the long way round rooms that hurt', () => {
    const graph = world();
    const route = graph.route(roomId(1, 1), roomId(1, 4), { hazard: hazardFor(graph, 100, []) });
    expect(route.steps.map((step) => step.name)).toEqual(['Street', 'Street', 'Street', 'Landing']);
  });

  /* And the item the realm names turns it back into a corridor. */
  it('takes the short way again for a pack holding what stops it', () => {
    const graph = world();
    const route = graph.route(roomId(1, 1), roomId(1, 4), {
      keys: [690],
      packKnown: true,
      hazard: hazardFor(graph, 100, [690])
    });
    expect(route.steps.map((step) => step.name)).toEqual(['River', 'River', 'Landing']);
    expect(route.hazards).toBeUndefined();
  });

  it('says on the step what the room took, and names what would stop it', () => {
    const graph = world();
    const route = graph.route(roomId(1, 1), roomId(1, 4), {
      // A bar so large that the river is still the cheap way, so the route is
      // walked and the panel has something to explain.
      hazard: hazardFor(graph, 100_000, [])
    });
    expect(route.steps.map((step) => step.name)).toEqual(['River', 'River', 'Landing']);
    expect(route.steps[0]?.hazard).toBeCloseTo(15 / 100_000);
    expect(route.hazards).toEqual([
      {
        spell: 'river damage',
        rooms: 2,
        share: 15 / 100_000,
        unread: false,
        summons: false,
        needs: [{ id: 690, name: 'log raft' }],
        needsSpell: []
      }
    ]);
  });

  /*
   * *There is no other way* used to be asserted off the price of a single
   * search: the router walls a deadly room rather than pruning it, so such a
   * room is an expensive option the cheapest route happened to include. This
   * is the search that makes the sentence checkable.
   */
  it('offers the way round the rooms that hurt, where there is one', () => {
    // A bar of 300 puts the river at a twentieth each -- `otherWayShare`, so
    // worth asking about -- and thirty rooms of dry land is dearer than that,
    // so the router walks the river. Which is exactly the case the reader has
    // to be told about: it chose to hurt them and used to say nothing.
    const graph = world(30);
    const cheap = graph.route(
      roomId(1, 1),
      roomId(1, 4),
      { hazard: hazardFor(graph, 300, []) },
      { alternatives: true }
    );
    expect(cheap.steps.map((step) => step.name)).toEqual(['River', 'River', 'Landing']);
    expect(cheap.otherWay?.steps).toHaveLength(31);
    expect(cheap.otherWay?.steps.every((step) => step.hazard === undefined)).toBe(true);
    // Read and chosen, never used to plan a third.
    expect(cheap.otherWay?.otherWay).toBeUndefined();
  });

  it('offers nothing where the plan already is the way round', () => {
    const graph = world();
    const route = graph.route(
      roomId(1, 1),
      roomId(1, 4),
      { hazard: hazardFor(graph, 100, []) },
      { alternatives: true }
    );
    expect(route.steps.every((step) => step.hazard === undefined)).toBe(true);
    expect(route.otherWay).toBeUndefined();
  });

  /*
   * The second alternative, the one asked for by name (todo 01, 2026-09-10):
   * *I know there is another way, through the Silvermere River, but it needs
   * a log raft.* The way round avoids the rooms the plan priced badly and so
   * can never find the river; this asks where the search would go with every
   * item-stopped hazard switched off, and offers it where that is materially
   * shorter, priced as the premise says and naming what the pack lacks.
   */
  describe('the way with the right items', () => {
    const asked = (graph: WorldGraph, hp: number, keys: number[]) =>
      graph.route(
        roomId(1, 1),
        roomId(1, 4),
        { hazard: hazardFor(graph, hp, keys), keys, packKnown: true },
        { alternatives: true }
      );

    it('offers it where it is materially shorter, priced as carried, naming the item', () => {
      // Thirty rooms of dry land against two of river at 15 of a 100-point bar:
      // the plan goes round, and the river is the way for a character with a raft.
      const graph = world(30);
      const route = asked(graph, 100, []);
      expect(route.steps).toHaveLength(31);
      expect(route.carrying?.steps.map((step) => step.name)).toEqual(['River', 'River', 'Landing']);
      expect(route.carrying?.steps.every((step) => step.hazard === undefined)).toBe(true);
      expect(route.carrying?.hazards?.[0]?.needs).toEqual([{ id: 690, name: 'log raft' }]);
      // Read and chosen, never used to plan a third.
      expect(route.carrying?.carrying).toBeUndefined();
    });

    it('withholds a way that is shorter by a corner cut', () => {
      // Eight rooms of dry land: the river saves six steps, under the floor.
      expect(asked(world(8), 100, []).carrying).toBeUndefined();
    });

    it('offers nothing where the plan already carries what it needs', () => {
      const route = asked(world(30), 100, [690]);
      expect(route.steps).toHaveLength(3);
      expect(route.carrying).toBeUndefined();
    });

    it('is not planned for a walk that is not read, and nor is the way round', () => {
      const graph = world(30);
      const route = graph.route(roomId(1, 1), roomId(1, 4), { hazard: hazardFor(graph, 100, []) });
      expect(route.carrying).toBeUndefined();
      const river = graph.route(roomId(1, 1), roomId(1, 4), { hazard: hazardFor(graph, 300, []) });
      expect(river.steps).toHaveLength(3);
      expect(river.otherWay).toBeUndefined();
    });
  });

  /*
   * A room whose own spell takes the whole bar is walled exactly as a lair
   * expected to kill is, and has to *say so* by the same word: the head of the
   * plan reads `deadly` off the step, and it was set from the lair alone. Down
   * a corridor with no dry way at all, so the router has to walk it.
   */
  it('calls a step deadly when the room’s own spell takes the whole bar', () => {
    const oneWay = [
      { m: 1, r: 1, n: 'Pier', x: { n: { m: 1, r: 2 } } },
      { m: 1, r: 2, n: 'River', sp: 753, x: { s: { m: 1, r: 1 }, n: { m: 1, r: 4 } } },
      { m: 1, r: 4, n: 'Landing', x: { s: { m: 1, r: 2 } } }
    ];
    const graph = makeWorld(oneWay, header, 30);
    // 15 damage against a 10-point bar: expected to die there.
    const route = graph.route(roomId(1, 1), roomId(1, 4), { hazard: hazardFor(graph, 10, []) });
    const river = route.steps.find((step) => step.name === 'River');
    expect(river?.hazard).toBeCloseTo(1.5);
    expect(river?.deadly).toBe(true);
  });

  /*
   * **A way round is expected to be dearer, and cost was briefly the test.**
   * Pruning can only remove options, so a way round always costs at least what
   * the plan costs — and a plan holding a deadly room costs `wallCost`, so
   * every alternative was refused on the one route whose panel says *and there
   * is no other way*. What is offered instead is a way that is not deadly,
   * whatever it costs, carrying what it needs: trading a certain death for a
   * door somebody can go and find the key to is the choice worth putting in
   * front of them, and it is only a choice if the door is named.
   */
  it('offers a walled way round a deadly one, and names what it needs', () => {
    const graph = makeWorld(
      [
        { m: 1, r: 1, n: 'Gate', x: { n: { m: 1, r: 2 }, e: { m: 1, r: 3 } } },
        { m: 1, r: 2, n: 'Lair', lair: '(Max 1): 7,', x: { n: { m: 1, r: 4 } } },
        // The dry way, behind a door this character has no key for and no
        // skill the realm accepts instead.
        { m: 1, r: 3, n: 'Locked Way', x: { n: { m: 1, r: 5, i: 'Key: 12' } } },
        { m: 1, r: 5, n: 'Beyond', x: { w: { m: 1, r: 4 } } },
        { m: 1, r: 4, n: 'Keep', x: {} }
      ],
      { items: [{ id: 12, n: 'brass key' }], mobs: [{ i: [7], n: 'ogre', hp: 90 }] },
      30
    );
    const route = graph.route(
      roomId(1, 1),
      roomId(1, 4),
      {
        danger: (room) => (room.name === 'Lair' ? 1.4 : null),
        packKnown: true,
        keys: []
      },
      { alternatives: true }
    );
    expect(route.steps.map((step) => step.name)).toEqual(['Lair', 'Keep']);
    expect(lairsAlong(route.steps).deadly).toEqual({ room: '1/2', name: 'Lair' });
    // And the client actually looked, rather than asserting the absolute.
    expect(route.otherWay?.steps.map((step) => step.name)).toEqual([
      'Locked Way',
      'Beyond',
      'Keep'
    ]);
    expect(route.otherWay?.blocks?.map((block) => block.kind)).toEqual(['key']);
    expect(route.otherWay?.steps.some((step) => step.deadly === true)).toBe(false);
  });

  it('refuses a way round that is expected to kill you as well', () => {
    const graph = makeWorld(
      [
        { m: 1, r: 1, n: 'Gate', x: { n: { m: 1, r: 2 }, e: { m: 1, r: 3 } } },
        { m: 1, r: 2, n: 'Lair', lair: '(Max 1): 7,', x: { n: { m: 1, r: 4 } } },
        { m: 1, r: 3, n: 'Den', lair: '(Max 1): 7,', x: { n: { m: 1, r: 4 } } },
        { m: 1, r: 4, n: 'Keep', x: {} }
      ],
      { mobs: [{ i: [7], n: 'ogre', hp: 90 }] },
      30
    );
    const route = graph.route(
      roomId(1, 1),
      roomId(1, 4),
      { danger: () => 1.4 },
      { alternatives: true }
    );
    expect(lairsAlong(route.steps).deadly).not.toBeNull();
    expect(route.otherWay).toBeUndefined();
  });

  it('offers nothing where the only way is the one that hurts', () => {
    const oneWay = [
      { m: 1, r: 1, n: 'Pier', x: { n: { m: 1, r: 2 } } },
      { m: 1, r: 2, n: 'River', sp: 753, x: { s: { m: 1, r: 1 }, n: { m: 1, r: 4 } } },
      { m: 1, r: 4, n: 'Landing', x: { s: { m: 1, r: 2 } } }
    ];
    const graph = makeWorld(oneWay, header, 30);
    const route = graph.route(
      roomId(1, 1),
      roomId(1, 4),
      { hazard: hazardFor(graph, 150, []) },
      { alternatives: true }
    );
    expect(route.steps.map((step) => step.name)).toEqual(['River', 'Landing']);
    expect(route.otherWay).toBeUndefined();
  });
});

describe('a walkable route that crosses a wall names what the shorter way needs', () => {
  const world = (): Array<Record<string, unknown>> => [
    { m: 1, r: 1, n: 'Gate', x: { n: { m: 1, r: 2, i: 'Key: 1124' }, e: { m: 1, r: 3 } } },
    {
      m: 1,
      r: 3,
      n: 'Yard',
      x: { w: { m: 1, r: 1 }, n: { m: 1, r: 4, i: 'Door [999 picklocks/strength]' } }
    },
    { m: 1, r: 4, n: 'Hall', x: { s: { m: 1, r: 3 }, w: { m: 1, r: 2 } } },
    { m: 1, r: 2, n: 'Vault', x: { s: { m: 1, r: 1 }, e: { m: 1, r: 4 } } }
  ];

  it('carries the key the direct way wanted, beside the walk through the wall', () => {
    const route = makeWorld(world()).route(roomId(1, 1), roomId(1, 2), {
      packKnown: true,
      keys: [],
      strength: 10,
      pickSkill: 0
    });
    expect(route.blocked).toBe(false);
    expect(route.steps.map((step) => step.name)).toEqual(['Yard', 'Hall', 'Vault']);
    expect(route.cost).toBeGreaterThanOrEqual(100_000);
    expect(route.blocks).toEqual([
      { kind: 'key', at: '1/1', to: '1/2', name: 'Vault', keyId: 1124 }
    ]);
  });

  it('says nothing about a way that crosses no wall', () => {
    const route = makeWorld(world()).route(roomId(1, 1), roomId(1, 2), {
      packKnown: true,
      keys: [1124]
    });
    expect(route.steps.map((step) => step.name)).toEqual(['Vault']);
    expect(route.blocks).toBeUndefined();
  });
});
