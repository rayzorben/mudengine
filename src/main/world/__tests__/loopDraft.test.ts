import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { WorldGraph } from '../WorldGraph';
import { draftLoop, LoopDraftCache, preferredEdges, reduceWaypoints } from '../loopDraft';

function makeWorld(rooms: Array<Record<string, unknown>>): WorldGraph {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-draft-'));
  const file = path.join(dir, 'rooms.jsonl.gz');
  const header = JSON.stringify({ v: 1, source: 'test', rooms: rooms.length, generatedAt: 'x' });
  fs.writeFileSync(
    file,
    zlib.gzipSync([header, ...rooms.map((r) => JSON.stringify(r))].join('\n') + '\n')
  );
  const graph = WorldGraph.load(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return graph;
}

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

/*
 * A square: 1 — 2
 *           |   |
 *           3 — 4
 * Two equally short ways from 1 to 4, so a pick on one of them is a choice.
 */
function square(): Array<Record<string, unknown>> {
  return [
    { m: 1, r: 1, n: 'NW', x: { e: { m: 1, r: 2 }, s: { m: 1, r: 3 } } },
    { m: 1, r: 2, n: 'NE', x: { w: { m: 1, r: 1 }, s: { m: 1, r: 4 } } },
    { m: 1, r: 3, n: 'SW', x: { n: { m: 1, r: 1 }, e: { m: 1, r: 4 } } },
    { m: 1, r: 4, n: 'SE', x: { n: { m: 1, r: 2 }, w: { m: 1, r: 3 } } }
  ];
}

describe('planning a hand-built loop', () => {
  it('is empty for no picks', () => {
    expect(draftLoop(makeWorld(corridor(3)), [])).toEqual({ legs: [], path: [], waypoints: [] });
  });

  it('is one waypoint and no legs for a single pick', () => {
    const draft = draftLoop(makeWorld(corridor(3)), ['1/2']);
    expect(draft.legs).toEqual([]);
    expect(draft.path).toEqual(['1/2']);
    expect(draft.waypoints).toEqual([{ id: '1/2', name: 'Room 2' }]);
  });

  it('routes each pair of picks in order and joins the path', () => {
    const draft = draftLoop(makeWorld(corridor(5)), ['1/1', '1/3', '1/5']);
    expect(draft.legs.map((leg) => [leg.from, leg.to])).toEqual([
      ['1/1', '1/3'],
      ['1/3', '1/5']
    ]);
    expect(draft.path).toEqual(['1/1', '1/2', '1/3', '1/4', '1/5']);
  });

  /* The reduction: a pick the planner would walk through anyway is a click
     made on the way to somewhere, not a place. */
  it('drops a pick in the middle of a corridor the planner walks anyway', () => {
    const draft = draftLoop(makeWorld(corridor(5)), ['1/1', '1/3', '1/5']);
    expect(draft.waypoints.map((stop) => stop.id)).toEqual(['1/1', '1/5']);
  });

  /**
   * The contract, stated as the property it is: routing between consecutive
   * waypoints reproduces the path exactly. Which rooms are chosen when two
   * ways are equally short depends on the planner's tie-break, and a test
   * that named them would be asserting the tie-break rather than the rule.
   */
  const replays = (graph: WorldGraph, draft: ReturnType<typeof draftLoop>): boolean => {
    const walked = [draft.waypoints[0]!.id];
    for (let index = 1; index < draft.waypoints.length; index += 1) {
      const route = graph.route(draft.waypoints[index - 1]!.id, draft.waypoints[index]!.id);
      if (route.blocked) return false;
      walked.push(...route.steps.map((step) => step.to));
    }
    return walked.length === draft.path.length && walked.every((id, at) => id === draft.path[at]);
  };

  it('keeps a pick where the walk is a choice', () => {
    // Round the square the long way: 1 → 2 → 4 → 3. From 1 the planner
    // reaches 3 in one step south, so a waypoint has to hold the detour.
    const graph = makeWorld(square());
    const draft = draftLoop(graph, ['1/1', '1/2', '1/4', '1/3']);
    expect(draft.path).toEqual(['1/1', '1/2', '1/4', '1/3']);
    expect(draft.waypoints.length).toBeGreaterThan(2);
    expect(draft.waypoints[0]?.id).toBe('1/1');
    expect(draft.waypoints[draft.waypoints.length - 1]?.id).toBe('1/3');
    expect(replays(graph, draft)).toBe(true);
  });

  it('closes a loop back to its first pick and keeps the closing waypoint', () => {
    const graph = makeWorld(square());
    const draft = draftLoop(graph, ['1/1', '1/2', '1/4', '1/3', '1/1']);
    expect(draft.path).toEqual(['1/1', '1/2', '1/4', '1/3', '1/1']);
    const ids = draft.waypoints.map((stop) => stop.id);
    expect(ids[0]).toBe('1/1');
    expect(ids[ids.length - 1]).toBe('1/1');
    expect(replays(graph, draft)).toBe(true);
  });

  it('stops planning at the first blocked leg and keeps the path up to it', () => {
    const rooms = [
      { m: 1, r: 1, n: 'A', x: { e: { m: 1, r: 2 } } },
      { m: 1, r: 2, n: 'B', x: { w: { m: 1, r: 1 } } },
      // An island nothing reaches.
      { m: 1, r: 3, n: 'C', x: { e: { m: 1, r: 4 } } },
      { m: 1, r: 4, n: 'D', x: { w: { m: 1, r: 3 } } }
    ];
    const draft = draftLoop(makeWorld(rooms), ['1/1', '1/2', '1/3', '1/4']);
    expect(draft.legs).toHaveLength(2);
    expect(draft.legs[1]?.route.blocked).toBe(true);
    expect(draft.path).toEqual(['1/1', '1/2']);
    expect(draft.waypoints.map((stop) => stop.id)).toEqual(['1/1', '1/2']);
  });

  it('names a waypoint the realm knows, and falls back to its id', () => {
    const draft = draftLoop(makeWorld(corridor(2)), ['1/1', '1/2']);
    expect(draft.waypoints).toEqual([
      { id: '1/1', name: 'Room 1' },
      { id: '1/2', name: 'Room 2' }
    ]);
  });
});

describe('reducing a path to waypoints', () => {
  it('is nothing for nothing', () => {
    expect(reduceWaypoints(makeWorld(corridor(2)), [])).toEqual([]);
  });

  it('keeps both ends of a two-room path', () => {
    expect(reduceWaypoints(makeWorld(corridor(2)), ['1/1', '1/2'])).toEqual(['1/1', '1/2']);
  });

  it('reduces a straight corridor to its ends', () => {
    const graph = makeWorld(corridor(6));
    expect(reduceWaypoints(graph, ['1/1', '1/2', '1/3', '1/4', '1/5', '1/6'])).toEqual([
      '1/1',
      '1/6'
    ]);
  });

  it('is a single room for a single room', () => {
    expect(reduceWaypoints(makeWorld(corridor(2)), ['1/1'])).toEqual(['1/1']);
  });
});

describe('the corridors a character prefers', () => {
  const byId =
    (graph: WorldGraph) => (stop: { name: string; at: { map: number; room: number } | null }) =>
      stop.at === null
        ? null
        : graph.byId(`${stop.at.map}/${stop.at.room}`)
          ? `${stop.at.map}/${stop.at.room}`
          : null;

  it('is nothing for loops that do not prefer', () => {
    const graph = makeWorld(corridor(3));
    const found = preferredEdges(
      graph,
      [{ name: 'plain', stops: [{ room: 'Room 1 1/1' }, { room: 'Room 3 1/3' }] }],
      byId(graph),
      {}
    );
    expect(found.edges.size).toBe(0);
    expect(found.unresolved).toEqual([]);
  });

  it('keeps every step of a preferred route, both ways', () => {
    const graph = makeWorld(corridor(3));
    const found = preferredEdges(
      graph,
      [
        {
          name: 'along',
          stops: [{ room: 'Room 1 1/1' }, { room: 'Room 3 1/3' }],
          bounce: true,
          prefer: true
        }
      ],
      byId(graph),
      {}
    );
    expect([...found.edges].sort()).toEqual(['1/1|1/2', '1/2|1/1', '1/2|1/3', '1/3|1/2']);
  });

  it('closes a ring with the leg from its last stop to its first', () => {
    const graph = makeWorld(square());
    const found = preferredEdges(
      graph,
      [
        {
          name: 'ring',
          stops: [{ room: 'NW 1/1' }, { room: 'NE 1/2' }, { room: 'SE 1/4' }],
          prefer: true
        }
      ],
      byId(graph),
      {}
    );
    // 4 back to 1 goes through 2 or 3; either way the closing leg's edges are in.
    expect(found.edges.has('1/1|1/2')).toBe(true);
    expect(found.edges.has('1/2|1/4')).toBe(true);
    expect(found.edges.has('1/4|1/3') || found.edges.has('1/4|1/2')).toBe(true);
  });

  /* A stop the realm cannot settle leaves the whole route out, and names it. */
  it('leaves a route with an unsettled stop out, and says which', () => {
    const graph = makeWorld(corridor(3));
    const found = preferredEdges(
      graph,
      [{ name: 'lost', stops: [{ room: 'Room 1 1/1' }, { room: 'Nowhere' }], prefer: true }],
      byId(graph),
      {}
    );
    expect(found.edges.size).toBe(0);
    expect(found.unresolved).toEqual(['lost']);
  });

  /* Derived plainly: a preference handed in must not shape the route it derives. */
  it('derives each route without any preference in force', () => {
    const graph = makeWorld(square());
    const found = preferredEdges(
      graph,
      [
        {
          name: 'across',
          stops: [{ room: 'NW 1/1' }, { room: 'SE 1/4' }],
          bounce: true,
          prefer: true
        }
      ],
      byId(graph),
      { preferred: new Set(['1/1|1/3', '1/3|1/4']) }
    );
    // Two equally short ways; whichever the plain planner takes, exactly one
    // of them is in the set, and the preference handed in did not decide it.
    const viaNorth = found.edges.has('1/1|1/2') && found.edges.has('1/2|1/4');
    const viaSouth = found.edges.has('1/1|1/3') && found.edges.has('1/3|1/4');
    expect(viaNorth !== viaSouth).toBe(true);
    expect(found.edges.size).toBe(4);
  });
});

describe('drafts remembered between picks', () => {
  /* The property: a draft carried forward from a shorter one is the draft
     from scratch, pick for pick. */
  it('answers an extended list exactly as a fresh draft would', () => {
    const graph = makeWorld(square());
    const cache = new LoopDraftCache();
    const picks = ['1/1', '1/2', '1/4', '1/3', '1/1'];
    for (let length = 1; length <= picks.length; length += 1) {
      const list = picks.slice(0, length);
      expect(cache.draft(graph, list)).toEqual(draftLoop(graph, list));
    }
  });

  it('answers a list it has seen from memory, which is what an undo is', () => {
    const graph = makeWorld(corridor(6));
    const cache = new LoopDraftCache();
    const longer = cache.draft(graph, ['1/1', '1/3', '1/6']);
    const shorter = cache.draft(graph, ['1/1', '1/3']);
    // The same object back: nothing was planned again.
    expect(cache.draft(graph, ['1/1', '1/3'])).toBe(shorter);
    expect(cache.draft(graph, ['1/1', '1/3', '1/6'])).toBe(longer);
  });

  it('does not extend a draft that ended at a blocked leg', () => {
    const rooms = [
      { m: 1, r: 1, n: 'A', x: { e: { m: 1, r: 2 } } },
      { m: 1, r: 2, n: 'B', x: { w: { m: 1, r: 1 } } },
      { m: 1, r: 3, n: 'C', x: {} }
    ];
    const graph = makeWorld(rooms);
    const cache = new LoopDraftCache();
    const blocked = cache.draft(graph, ['1/1', '1/3']);
    expect(blocked.legs[0]?.route.blocked).toBe(true);
    const onward = cache.draft(graph, ['1/1', '1/3', '1/2']);
    expect(onward).toEqual(draftLoop(graph, ['1/1', '1/3', '1/2']));
    expect(onward.legs).toHaveLength(1);
  });

  it('forgets a draft when the realm underneath it changes', () => {
    const cache = new LoopDraftCache();
    const first = cache.draft(makeWorld(corridor(3)), ['1/1', '1/3']);
    const other = makeWorld([
      { m: 1, r: 1, n: 'A', x: { s: { m: 1, r: 3 } } },
      { m: 1, r: 3, n: 'C', x: { n: { m: 1, r: 1 } } }
    ]);
    const second = cache.draft(other, ['1/1', '1/3']);
    expect(first.path).toEqual(['1/1', '1/2', '1/3']);
    expect(second.path).toEqual(['1/1', '1/3']);
  });

  it('is bounded', () => {
    const graph = makeWorld(corridor(3));
    const cache = new LoopDraftCache(2);
    const a = cache.draft(graph, ['1/1']);
    cache.draft(graph, ['1/2']);
    cache.draft(graph, ['1/3']);
    // The oldest went; asking again plans afresh and answers a new object.
    expect(cache.draft(graph, ['1/1'])).not.toBe(a);
    expect(cache.draft(graph, ['1/1'])).toEqual(a);
  });
});
