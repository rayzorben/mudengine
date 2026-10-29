import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import RoutePanel from '../RoutePanel';
import { mount } from '../../hooks/__tests__/mount';
import type { Route, RouteStep, WorldRoom } from '@shared/world';

/* The picture of where a route ends draws the whole way and fits the way in, back to the last jump. */
describe('the route panel drawing the way in', () => {
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

  const step = (from: string, to: string, direction: string): RouteStep =>
    ({
      from,
      to,
      direction,
      command: direction,
      name: 'Hallway',
      requirement: null,
      dark: false
    }) as RouteStep;
  const hall = { map: 2, room: 7, name: 'Hallway', exits: [] } as unknown as WorldRoom;

  async function drawn(route: Route, stopShort = false): Promise<{ path: unknown; fit: unknown }> {
    const answer = Promise.resolve(route);
    panel.render(
      createElement(RoutePanel, {
        open: true,
        onClose: () => undefined,
        onSearch: () => Promise.resolve([]),
        onRoute: () => answer,
        onWalk: () => new Promise(() => undefined),
        onCollectThenWalk: () => Promise.resolve(null),
        destination: hall,
        onLoadMap: () => new Promise(() => undefined),
        finds: [],
        onPeek: null,
        onPeekEnd: null
      } as unknown as Parameters<typeof RoutePanel>[0])
    );
    await act(async () => {
      await answer;
    });
    if (stopShort) {
      const chip = panel.root().find((node) => node.props.className === 'chip pick route-stop');
      act(() => chip.props.onClick());
    }
    // MapView is memoised, so it is found by the name it is handed.
    const view = panel.root().find((node) => node.props.name === 'route' && 'load' in node.props);
    expect(view.props.fitKeep).toBe('end');
    return { path: view.props.path, fit: view.props.fit };
  }

  it('draws the whole way and fits the way from the last way up to the destination', async () => {
    const { path, fit } = await drawn({
      steps: [
        step('1/10', '1/11', 'e'),
        step('1/11', '2/5', 'u'),
        step('2/5', '2/6', 'e'),
        step('2/6', '2/7', 'e')
      ],
      cost: 4,
      blocked: false
    });
    expect(path).toEqual(['1/10', '1/11', '2/5', '2/6', '2/7']);
    expect([...(fit as Set<string>)]).toEqual(['2/5', '2/6', '2/7']);
  });

  it('fits nothing when the way arrives by a way up', async () => {
    const { path, fit } = await drawn({
      steps: [step('1/10', '1/11', 'e'), step('1/11', '2/7', 'u')],
      cost: 2,
      blocked: false
    });
    expect(path).toEqual(['1/10', '1/11', '2/7']);
    expect(fit).toBeNull();
  });

  it('ends a room short with Stop before entering on, where the walk ends', async () => {
    const steps = [step('2/5', '2/6', 'e'), step('2/6', '2/7', 'e')];
    expect((await drawn({ steps, cost: 2, blocked: false })).path).toEqual(['2/5', '2/6', '2/7']);
    panel.unmount();
    const { path, fit } = await drawn({ steps, cost: 2, blocked: false }, true);
    expect(path).toEqual(['2/5', '2/6']);
    expect([...(fit as Set<string>)]).toEqual(['2/5', '2/6']);
  });

  it('is the room before alone when one step is all there is to stop short of', async () => {
    const { path, fit } = await drawn(
      { steps: [step('2/6', '2/7', 'e')], cost: 1, blocked: false },
      true
    );
    expect(path).toEqual([]);
    expect(fit).toBeNull();
  });
});
