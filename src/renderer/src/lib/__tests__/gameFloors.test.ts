import { describe, expect, it } from 'vitest';

import { EMPTY_GAME_MAP, type GameCell, type GameStair } from '@shared/gameMap';
import { floorsReached, placePeek } from '../gameFloors';

const stair = (direction: 'u' | 'd', to: string, floor: number | null): GameStair => ({
  direction,
  to,
  name: to,
  floor,
  floors: 1
});

const cell = (id: string, gx: number, stairs: GameStair[]): GameCell =>
  ({ id, gx, gy: 0, to: {}, area: 0, stairs }) as unknown as GameCell;

describe('the floor strip', () => {
  const win = {
    ...EMPTY_GAME_MAP,
    map: 1,
    floor: 0,
    cells: [
      cell('1/1', 0, [stair('u', '1/10', 1)]),
      cell('1/2', 5, [stair('u', '1/20', 1), stair('d', '1/30', -2)]),
      cell('1/3', 9, [stair('d', '1/40', null)])
    ]
  };

  it('lists the floor shown and each floor a stair reaches, highest first, by the nearest stair', () => {
    expect(floorsReached(win, { gx: 4, gy: 0 })).toEqual([
      { floor: 1, to: '1/20' },
      { floor: 0, to: null },
      { floor: -2, to: '1/30' }
    ]);
    expect(floorsReached(win, { gx: 0, gy: 0 })[0]).toEqual({ floor: 1, to: '1/10' });
  });

  it('is empty where no stair reaches another floor of the map', () => {
    expect(floorsReached({ ...win, cells: [win.cells[2]!] }, { gx: 0, gy: 0 })).toEqual([]);
  });
});

describe("a stair's peek window", () => {
  const size = { w: 100, h: 80 };
  const canvas = { width: 1000, height: 800 };
  const far = { x: -500, y: -500, r: 10 };

  it('goes up and right for a way up, down and left for a way down', () => {
    expect(placePeek({ x: 500, y: 400 }, 'u', size, 10, canvas, far)).toEqual({
      x: 510,
      y: 310,
      w: 100,
      h: 80
    });
    expect(placePeek({ x: 500, y: 400 }, 'd', size, 10, canvas, far)).toEqual({
      x: 390,
      y: 410,
      w: 100,
      h: 80
    });
  });

  it('moves off the arena and the canvas edge', () => {
    // Up and right would cover the arena: up and left is next.
    const arena = { x: 560, y: 350, r: 30 };
    expect(placePeek({ x: 500, y: 400 }, 'u', size, 10, canvas, arena)).toMatchObject({
      x: 390,
      y: 310
    });
    // At the top edge, up is off the canvas: down and right.
    expect(placePeek({ x: 500, y: 40 }, 'u', size, 10, canvas, far)).toMatchObject({
      x: 510,
      y: 50
    });
  });
});
