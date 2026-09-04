import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { WorldGraph } from '../WorldGraph';
import { resolveFromCoordinates, resolveRoom } from '../resolve';
import { roomId, type WorldRoom } from '../../../shared/world';

const file = path.resolve('resources/world/rooms.jsonl.gz');
const available = fs.existsSync(file);
const graph = available ? WorldGraph.load(file) : null;

/**
 * These run against the real realm data rather than a fixture. Room resolution
 * is entirely about how *ambiguous* real names are, and a hand-made world with
 * three rooms cannot express that.
 */
/** The room itself and everywhere one step from it, as the ladder sees them. */
function neighbourhood(room: WorldRoom): WorldRoom[] {
  const found = [room];
  for (const exit of room.exits) {
    const next = graph!.get(exit.map, exit.room);
    if (next && !found.some((seen) => seen.map === next.map && seen.room === next.room)) {
      found.push(next);
    }
  }
  return found;
}

describe.runIf(available)('resolveRoom', () => {
  it('resolves a unique name outright', () => {
    const result = resolveRoom(graph!, { name: 'Bank of Godfrey', exits: ['n', 'e', 'w'] });
    expect(result.method).toBe('unique-name');
    expect(result.room?.map).toBe(1);
    expect(result.room?.room).toBe(297);
  });

  it('is not fooled by an unknown name', () => {
    const result = resolveRoom(graph!, { name: 'Nowhere At All', exits: [] });
    expect(result.room).toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it('resolves by movement from a known room', () => {
    // The strongest signal: the realm data already says where that exit goes.
    const bank = graph!.get(1, 297)!;
    const north = bank.exits.find((e) => e.direction === 'n')!;
    const destination = graph!.get(north.map, north.room)!;

    const result = resolveRoom(graph!, {
      name: destination.name,
      exits: destination.exits.map((e) => e.direction),
      previous: '1/297',
      moved: 'n'
    });

    expect(result.method).toBe('movement');
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.room?.room).toBe(destination.room);
  });

  it('falls through when movement contradicts the name', () => {
    // A mismatch means the previous belief was wrong. Trusting it anyway would
    // compound the error room after room.
    const result = resolveRoom(graph!, {
      name: 'Bank of Godfrey',
      exits: ['n', 'e', 'w'],
      previous: '1/297',
      moved: 'n'
    });
    expect(result.method).not.toBe('movement');
    expect(result.room?.room).toBe(297);
  });

  it('narrows a repeated name by its exit signature', () => {
    // Find a name shared by several rooms whose exit sets differ.
    let target: { name: string; exits: string[]; room: number } | null = null;
    for (let map = 1; map <= 30 && !target; map += 1) {
      for (let room = 1; room <= 400; room += 1) {
        const candidate = graph!.get(map, room);
        if (!candidate) continue;
        const sharing = graph!.findByName(candidate.name);
        if (sharing.length < 2) continue;
        const signature = candidate.exits
          .map((e) => e.direction)
          .sort()
          .join();
        const unique = sharing.filter(
          (other) =>
            other.exits
              .map((e) => e.direction)
              .sort()
              .join() === signature
        );
        if (unique.length === 1) {
          target = {
            name: candidate.name,
            exits: candidate.exits.map((e) => e.direction),
            room: candidate.room
          };
          break;
        }
      }
    }

    expect(target, 'expected a repeated name with a distinguishing exit set').not.toBeNull();
    const result = resolveRoom(graph!, { name: target!.name, exits: target!.exits as never });
    expect(result.method).toBe('exit-signature');
    expect(result.room?.room).toBe(target!.room);
  });

  /*
   * The rung between movement and the global ladder: something moved the
   * character and it was not this client, so the answer is one step away.
   * Without it the client searched 55,806 rooms for a room next door, and a
   * name alone settles only 3.07% of them.
   */
  describe('a step nobody sent — a retreat, a drag, a follow', () => {
    it('resolves from the neighbourhood when the name is unique there', () => {
      // A neighbour whose name no other neighbour shares, and which is not
      // unique in the realm — so only the neighbourhood can settle it.
      let previous: WorldRoom | null = null;
      let landed: WorldRoom | null = null;
      for (let map = 1; map <= 30 && !previous; map += 1) {
        for (let number = 1; number <= 400; number += 1) {
          const room = graph!.get(map, number);
          if (!room) continue;
          const near = neighbourhood(room);
          const found = near.find(
            (candidate) =>
              graph!.findByName(candidate.name).length > 1 &&
              near.filter((other) => other.name === candidate.name).length === 1
          );
          if (found) {
            previous = room;
            landed = found;
            break;
          }
        }
      }

      expect(previous, 'expected a namesake resolvable only next door').not.toBeNull();
      const result = resolveRoom(graph!, {
        name: landed!.name,
        exits: landed!.exits.map((e) => e.direction) as never,
        previous: roomId(previous!.map, previous!.room),
        moved: null
      });

      expect(result.method).toBe('neighbour');
      expect(result.room?.map).toBe(landed!.map);
      expect(result.room?.room).toBe(landed!.room);
    });

    it('refuses rather than picking when the neighbourhood holds several', () => {
      // A corridor of clones is genuinely unresolvable without a direction,
      // and saying so beats sending the pathfinder to the wrong end of it.
      let previous: WorldRoom | null = null;
      let name: string | null = null;
      for (let map = 1; map <= 30 && !previous; map += 1) {
        for (let number = 1; number <= 400; number += 1) {
          const room = graph!.get(map, number);
          if (!room) continue;
          const near = neighbourhood(room);
          const twin = near.find(
            (candidate) => near.filter((other) => other.name === candidate.name).length > 1
          );
          if (twin) {
            previous = room;
            name = twin.name;
            break;
          }
        }
      }

      expect(previous, 'expected a corridor of clones').not.toBeNull();
      const result = resolveRoom(graph!, {
        name: name!,
        exits: [],
        previous: roomId(previous!.map, previous!.room),
        moved: null
      });

      expect(result.method).toBe('neighbour');
      expect(result.room).toBeNull();
      expect(result.candidates.length).toBeGreaterThan(1);
    });

    it('falls through to the realm when the name is nowhere near', () => {
      // A recall or a teleport is not a step, so the neighbourhood has nothing
      // to say and the global ladder is the right place to look.
      const result = resolveRoom(graph!, {
        name: 'Bank of Godfrey',
        exits: ['n', 'e', 'w'],
        previous: '1/1',
        moved: null
      });
      expect(result.method).toBe('unique-name');
      expect(result.room?.room).toBe(297);
    });
  });

  it('refuses to guess when several rooms still match', () => {
    // A confidently wrong location sends the pathfinder somewhere else
    // entirely, which is worse than admitting the ambiguity.
    let name: string | null = null;
    let exits: string[] = [];
    for (let map = 1; map <= 30 && !name; map += 1) {
      for (let room = 1; room <= 400; room += 1) {
        const candidate = graph!.get(map, room);
        if (!candidate) continue;
        const sharing = graph!.findByName(candidate.name);
        if (sharing.length < 2) continue;
        const signature = candidate.exits
          .map((e) => e.direction)
          .sort()
          .join();
        const same = sharing.filter(
          (other) =>
            other.exits
              .map((e) => e.direction)
              .sort()
              .join() === signature
        );
        if (same.length > 1) {
          name = candidate.name;
          exits = candidate.exits.map((e) => e.direction);
          break;
        }
      }
    }

    expect(name, 'expected an irreducibly ambiguous room').not.toBeNull();
    const result = resolveRoom(graph!, { name: name!, exits: exits as never });
    expect(result.room).toBeNull();
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.confidence).toBeLessThan(1);
  });
});

describe.runIf(available)('resolveFromCoordinates', () => {
  it('is certain, because the game said so', () => {
    const result = resolveFromCoordinates(graph!, 1, 297);
    expect(result.method).toBe('coordinates');
    expect(result.confidence).toBe(1);
    expect(result.room?.name).toBe('Bank of Godfrey');
  });

  it('reports nothing for coordinates outside the realm data', () => {
    expect(resolveFromCoordinates(graph!, 999, 999).room).toBeNull();
  });
});
