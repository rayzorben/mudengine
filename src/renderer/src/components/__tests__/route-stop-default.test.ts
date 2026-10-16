import { createElement } from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { WalkStart } from '@shared/movement';

import RoutePanel from '../RoutePanel';
import { mount } from '../../hooks/__tests__/mount';
import type { RoomNickname } from '@shared/roomNicknames';
import type { RoomId, Route, RouteStep, WorldRoom } from '@shared/world';

/* Todo 144: MegaMUD's *Stop before entering room* is where the toggle starts. */
describe('the route panel stopping before a boss room', () => {
  beforeAll(() => {
    const g = globalThis as unknown as { window?: object };
    g.window ??= {
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      setTimeout,
      clearTimeout
    };
  });

  const panel = mount();
  afterEach(() => panel.unmount());

  const lair = { map: 7, room: 1524, name: 'Cave', exits: [] } as unknown as WorldRoom;
  const step = (to: number, name: string): RouteStep =>
    ({
      from: `7/${to - 1}`,
      to: `7/${to}`,
      direction: 'n',
      command: 'n',
      name,
      requirement: null,
      dark: false
    }) as RouteStep;
  const worm: RoomNickname = {
    code: 'CTMB',
    name: 'Massive Black Worm',
    room: { name: 'Cave', at: { map: 7, room: 1524 } },
    stopBefore: true,
    avoid: false,
    hidden: false,
    minLevel: null,
    maxLevel: null
  };
  const plan = (arrival: RoomNickname | null): Route => ({
    steps: [step(1523, 'Tunnel'), step(1524, 'Cave')],
    cost: 2,
    blocked: false,
    ...(arrival === null ? {} : { arrival })
  });

  type Walk = (route: Route, run: boolean, stopBefore: RoomId | null) => Promise<WalkStart>;

  async function drawn(
    arrival: RoomNickname | null,
    destination = lair,
    onWalk: Walk = () => Promise.resolve({ started: true })
  ): Promise<void> {
    const answer = Promise.resolve(plan(arrival));
    panel.render(
      createElement(RoutePanel, {
        open: true,
        onClose: () => undefined,
        onSearch: () => Promise.resolve([]),
        onRoute: () => answer,
        onWalk,
        onCollectThenWalk: () => Promise.resolve(null),
        destination,
        onLoadMap: () => new Promise(() => undefined),
        finds: [],
        onPeek: null,
        onPeekEnd: null
      } as unknown as Parameters<typeof RoutePanel>[0])
    );
    await act(async () => {
      await answer;
    });
  }

  const toggle = (): ReactTestInstance =>
    panel
      .root()
      .find((node) => node.type === 'button' && node.props.className === 'chip pick route-stop');

  it('starts off for a room MegaMUD walks into', async () => {
    await drawn(null);
    expect(toggle().props['aria-pressed']).toBe(false);
  });

  it('starts on for a room MegaMUD stops before, and the reader can turn it off', async () => {
    await drawn(worm);
    expect(toggle().props['aria-pressed']).toBe(true);
    act(() => toggle().props.onClick());
    expect(toggle().props['aria-pressed']).toBe(false);
  });

  it("starts again at MegaMUD's word for each destination the reader picks", async () => {
    await drawn(worm);
    act(() => toggle().props.onClick());
    expect(toggle().props['aria-pressed']).toBe(false);
    await drawn(null, { ...lair, room: 1500, name: 'Tunnel' } as WorldRoom);
    expect(toggle().props['aria-pressed']).toBe(false);
    await drawn(worm, { ...lair });
    expect(toggle().props['aria-pressed']).toBe(true);
  });
});

/*
 * Todo 157: a press main answers with a plan redrawn from where the character
 * wandered to. The toggle stays on, so the panel must have sent the room it
 * stops before, and the next press trims the redrawn plan once.
 */
describe('the route panel stopping before a room on a redrawn plan', () => {
  const panel = mount();
  afterEach(() => panel.unmount());

  const step = (to: number): RouteStep =>
    ({
      from: `7/${to - 1}`,
      to: `7/${to}`,
      direction: 'n',
      command: 'n',
      name: `Tunnel ${to}`,
      requirement: null,
      dark: false
    }) as RouteStep;
  const way = (from: number): Route => {
    const steps: RouteStep[] = [];
    for (let room = from + 1; room <= 1524; room += 1) steps.push(step(room));
    return { steps, cost: steps.length, blocked: false };
  };
  const lair = { map: 7, room: 1524, name: 'Cave', exits: [] } as unknown as WorldRoom;

  it('walks the redrawn plan to the room before the destination, not two short', async () => {
    const presses: Array<{ steps: number; to?: RoomId; stopBefore: RoomId | null }> = [];
    const answers: WalkStart[] = [
      { replanned: { route: way(1520), wandered: 20, demands: [] } },
      { started: true }
    ];
    const planned = Promise.resolve(way(1522));
    panel.render(
      createElement(RoutePanel, {
        open: true,
        onClose: () => undefined,
        onSearch: () => Promise.resolve([]),
        onRoute: () => planned,
        onWalk: (route: Route, _run: boolean, stopBefore: RoomId | null) => {
          presses.push({ steps: route.steps.length, to: route.steps.at(-1)?.to, stopBefore });
          return Promise.resolve(answers[presses.length - 1]!);
        },
        onCollectThenWalk: () => Promise.resolve(null),
        destination: lair,
        onLoadMap: () => new Promise(() => undefined),
        finds: [],
        onPeek: null,
        onPeekEnd: null
      } as unknown as Parameters<typeof RoutePanel>[0])
    );
    await act(async () => {
      await planned;
    });
    const toggle = (): ReactTestInstance =>
      panel
        .root()
        .find((node) => node.type === 'button' && node.props.className === 'chip pick route-stop');
    act(() => toggle().props.onClick());
    expect(toggle().props['aria-pressed']).toBe(true);
    const press = async (): Promise<void> => {
      await act(async () => {
        panel
          .root()
          .find((node) => node.type === 'form')
          .props.onSubmit({ preventDefault: () => undefined });
        await Promise.resolve();
      });
    };

    // The first press: one short, and the destination sent with it.
    await press();
    expect(presses).toEqual([{ steps: 1, to: '7/1523', stopBefore: '7/1524' }]);
    // The redrawn plan is on screen with the toggle still on; pressed, it is
    // trimmed once.
    expect(toggle().props['aria-pressed']).toBe(true);
    await press();
    expect(presses[1]).toEqual({ steps: 3, to: '7/1523', stopBefore: '7/1524' });
  });
});
