import { createElement } from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import RoutePanel from '../RoutePanel';
import { mount } from '../../hooks/__tests__/mount';
import type { RoomNickname } from '@shared/roomNicknames';
import type { Route, RouteStep, WorldRoom } from '@shared/world';

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

  async function drawn(arrival: RoomNickname | null, destination = lair): Promise<void> {
    const answer = Promise.resolve(plan(arrival));
    panel.render(
      createElement(RoutePanel, {
        open: true,
        onClose: () => undefined,
        onSearch: () => Promise.resolve([]),
        onRoute: () => answer,
        onWalk: () => Promise.resolve({ started: true }),
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
