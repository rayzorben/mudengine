import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import type { GameCell, GameMapAsk, GameMapWindow } from '@shared/gameMap';
import { EMPTY_GAME_MAP } from '@shared/gameMap';
import { useGameMap, type GameMap } from '../useGameMap';
import { mount } from './mount';

/*
 * Todo 151: ◎ after a long drag left the map where the drag put it and the
 * arena in the middle of the screen, because the room's square was asked for
 * only when the room changed. Brought back, the map asks again.
 */

const cell = (room: number, gx: number): GameCell =>
  ({ id: `1/${room}`, gx, gy: 0, to: {}, area: 0 }) as unknown as GameCell;

function windowAround(gx: number, rooms: GameCell[]): GameMapWindow {
  return {
    ...EMPTY_GAME_MAP,
    map: 1,
    floor: 0,
    box: { x0: gx - 40, y0: -40, x1: gx + 40, y1: 40 },
    cells: rooms
  };
}

let shown: GameMap | null = null;
const asks: GameMapAsk[] = [];
const api = {
  gameMap: (_session: string, ask: GameMapAsk) => {
    asks.push(ask);
    return Promise.resolve(
      ask.kind === 'room' ? windowAround(0, [cell(1, 0)]) : windowAround(ask.gx, [cell(9, ask.gx)])
    );
  }
};

function Probe({ detached }: { detached: boolean }): null {
  shown = useGameMap(api, 's1', 1, 1, detached);
  return null;
}

const probe = mount();

afterEach(() => {
  probe.unmount();
  shown = null;
  asks.length = 0;
});

const settle = () => act(async () => {});

describe('useGameMap', () => {
  it("asks for the room's square again when a dragged map is brought back", async () => {
    probe.render(createElement(Probe, { detached: false }));
    await settle();
    expect(asks.map((ask) => ask.kind)).toEqual(['room']);

    probe.render(createElement(Probe, { detached: true }));
    act(() => shown!.lookAt(200, 0));
    await settle();
    // Positive control: the drag asked for the square it reached, and the room is not in it.
    expect(asks.map((ask) => ask.kind)).toEqual(['room', 'point']);
    expect(shown!.byId.has('1/1')).toBe(false);

    probe.render(createElement(Probe, { detached: false }));
    await settle();
    expect(asks.map((ask) => ask.kind)).toEqual(['room', 'point', 'room']);
    expect(shown!.byId.has('1/1')).toBe(true);
  });

  it('keeps the floor the character was last seen on while another is shown', async () => {
    probe.render(createElement(Probe, { detached: false }));
    await settle();
    expect(shown!.homeFloor).toBe(0);
    probe.render(createElement(Probe, { detached: true }));
    act(() => shown!.lookAt(200, 0));
    await settle();
    expect(shown!.homeFloor).toBe(0);
  });
});
