import { createElement } from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import RoutePanel from '../RoutePanel';
import { mount } from '../../hooks/__tests__/mount';
import type { Route, RouteStep, WorldRoom } from '@shared/world';

/* Todo 145: the most direct way is offered beside a plan more than a fifth longer. */
describe('the route panel offering the most direct way', () => {
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

  const swamp = { map: 3, room: 782, name: 'Hazy Swamp', exits: [] } as unknown as WorldRoom;
  const step = (map: number, room: number, name: string): RouteStep =>
    ({
      from: `${map}/${room - 1}`,
      to: `${map}/${room}`,
      direction: 'e',
      command: 'e',
      name,
      requirement: null,
      dark: false
    }) as RouteStep;
  const direct: Route = {
    steps: [step(3, 781, 'Black Wasteland'), step(3, 782, 'Hazy Swamp')],
    cost: 2,
    blocked: false
  };
  const plan: Route = {
    steps: [1, 2, 3, 4, 5].map((i) => step(1, 1800 + i, 'Pier')),
    cost: 5,
    blocked: false,
    direct
  };

  async function drawn(): Promise<Route[]> {
    const walked: Route[] = [];
    const answer = Promise.resolve(plan);
    panel.render(
      createElement(RoutePanel, {
        open: true,
        onClose: () => undefined,
        onSearch: () => Promise.resolve([]),
        onRoute: () => answer,
        onWalk: (route: Route) => {
          walked.push(route);
          return new Promise(() => undefined);
        },
        onCollectThenWalk: () => Promise.resolve(null),
        destination: swamp,
        onLoadMap: () => new Promise(() => undefined),
        finds: [],
        onPeek: null,
        onPeekEnd: null
      } as unknown as Parameters<typeof RoutePanel>[0])
    );
    await act(async () => {
      await answer;
    });
    return walked;
  }

  const button = (where: (node: ReactTestInstance) => boolean): ReactTestInstance =>
    panel.root().find((node) => node.type === 'button' && where(node));

  it('shows it outside the fold, and walking it walks its steps', async () => {
    const walked = await drawn();
    // No disclosure is opened: the row is on screen as drawn.
    const row = panel
      .root()
      .find(
        (node) => node.props.className === 'route-direct' && node.props['data-way'] === 'direct'
      );
    act(() => row.find((node) => node.type === 'button').props.onClick());
    act(() => button((node) => node.props.className === 'route-run').props.onClick());
    expect(walked.map((route) => route.steps.map((each) => each.to))).toEqual([['3/781', '3/782']]);
  });
});
