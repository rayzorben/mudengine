import { describe, expect, it } from 'vitest';

import { layoutSheet } from '../routeSheet';
import type { LocalMap, MapCell } from '@shared/map';
import type { JoinKind, RouteSheet } from '@shared/routeLegs';
import type { RouteStep } from '@shared/world';

const cell = (id: string, gx: number, gy = 0): MapCell => ({
  id,
  name: id,
  gx,
  gy,
  exits: ['e', 'w'],
  vertical: null,
  shop: false,
  lair: false
});

const floor = (level: number, ...cells: MapCell[]): { map: LocalMap; level: number } => ({
  map: { centre: null, cells, dropped: 0 },
  level
});

const step = (
  from: string,
  to: string,
  direction: RouteStep['direction'],
  command: string = direction
): RouteStep => ({
  from,
  to,
  direction,
  command,
  name: to,
  requirement: null,
  dark: false
});

const joined = (
  kind: JoinKind,
  from: string,
  to: string,
  direction: RouteStep['direction'],
  command?: string
) => ({
  kind,
  step: step(from, to, direction, command)
});

const extentOf = (xs: number[]): number => Math.max(...xs) - Math.min(...xs);

describe('laying out a page of several stretches', () => {
  it('stacks a way down taken three times, each floor under the room it left', () => {
    const sheet: RouteSheet = {
      floors: [floor(0, cell('1/1', 0)), floor(-1, cell('1/2', 0)), floor(-2, cell('1/3', 0))],
      stretches: [
        { floor: 0, rooms: ['1/1'], join: null },
        { floor: 1, rooms: ['1/2'], join: joined('down', '1/1', '1/2', 'd') },
        { floor: 2, rooms: ['1/3'], join: joined('down', '1/2', '1/3', 'd') }
      ]
    };
    const layout = layoutSheet(sheet, [], 1);
    expect(layout.joins.map((join) => join.kind)).toEqual(['down', 'down']);
    for (const join of layout.joins) {
      expect(join.y2).toBeGreaterThan(join.y1);
      expect(join.x2).toBeCloseTo(join.x1);
    }
    expect(layout.floors.every((placed) => placed.transform.startsWith('matrix('))).toBe(true);
    // Bottom first, so the floor above paints over the one below.
    expect(layout.floors.map((placed) => placed.level)).toEqual([-2, -1, 0]);
  });

  it('puts a floor reached by a typed exit beside the last, level with it and flat', () => {
    const sheet: RouteSheet = {
      floors: [
        floor(0, cell('1/1', 0), cell('1/2', 1)),
        floor(0, cell('1/40', 0), cell('1/41', 1))
      ],
      stretches: [
        { floor: 0, rooms: ['1/1', '1/2'], join: null },
        {
          floor: 1,
          rooms: ['1/40', '1/41'],
          join: joined('jump', '1/2', '1/40', 'e', 'go manhole')
        }
      ]
    };
    const layout = layoutSheet(sheet, [], 1);
    const [join] = layout.joins;
    expect(join?.y2).toBe(join?.y1);
    expect(join!.x2).toBeGreaterThan(join!.x1);
    expect(layout.floors.every((placed) => placed.transform.startsWith('translate('))).toBe(true);
    expect(layout.box.width).toBeGreaterThan(extentOf([join!.x1, join!.x2]));
  });

  it('moves a floor on past one already where it would land', () => {
    // Up to a wide floor, then down to a second one level with the first:
    // straight under the room it left would put it on the first floor.
    const sheet: RouteSheet = {
      floors: [
        floor(0, cell('1/1', 0), cell('1/2', 1), cell('1/3', 2)),
        floor(1, cell('2/1', 0)),
        floor(0, cell('3/1', 0))
      ],
      stretches: [
        { floor: 0, rooms: ['1/1', '1/2', '1/3'], join: null },
        { floor: 1, rooms: ['2/1'], join: joined('up', '1/3', '2/1', 'u') },
        { floor: 2, rooms: ['3/1'], join: joined('down', '2/1', '3/1', 'd') }
      ]
    };
    const layout = layoutSheet(sheet, [], 1);
    const [up, down] = layout.joins;
    expect(up!.y2).toBeLessThan(up!.y1);
    expect(down!.y2).toBeGreaterThan(up!.y1);
  });

  it("joins a line cut at the map's edge to the same room on the next floor", () => {
    const sheet: RouteSheet = {
      floors: [floor(0, cell('1/1', 0), cell('1/2', 1)), floor(0, cell('1/2', 0), cell('1/3', 1))],
      stretches: [
        { floor: 0, rooms: ['1/1', '1/2'], join: null },
        { floor: 1, rooms: ['1/2', '1/3'], join: { kind: 'onward', step: null } }
      ]
    };
    const [join] = layoutSheet(sheet, [], 1).joins;
    expect(join?.kind).toBe('onward');
    expect(join?.name).toBe('1/2');
    expect(join!.x2).toBeGreaterThan(join!.x1);
  });

  it('draws nothing between two stretches that meet in a room on one floor', () => {
    const sheet: RouteSheet = {
      floors: [floor(0, cell('1/1', 0), cell('1/2', 1), cell('1/3', 2))],
      stretches: [
        { floor: 0, rooms: ['1/1', '1/2'], join: null },
        { floor: 0, rooms: ['1/2', '1/3'], join: { kind: 'onward', step: null } }
      ]
    };
    expect(layoutSheet(sheet, [], 1).joins).toEqual([]);
  });
});
