import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import RoutePanel from '../RoutePanel';
import { t } from '../../lib/i18n';
import { mount } from '../../hooks/__tests__/mount';
import type { Route, WorldRoom } from '@shared/world';

/* Todo 838: the panel says a route is being planned until it lands. */
describe('the route panel while a route is planned', () => {
  beforeAll(() => {
    // The panel asks `window` for a frame and for key listeners, nothing else.
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

  const forest = { map: 7, room: 157, name: 'Fungus Forest', exits: [] } as unknown as WorldRoom;
  const stair = { map: 7, room: 150, name: 'Grand Stair', exits: [] } as unknown as WorldRoom;

  /** Each plan asked for, with its promise in the test's hands. */
  const asked: Array<{ room: WorldRoom; settle: (ok: boolean) => Promise<void> }> = [];
  const onRoute = (room: WorldRoom): Promise<Route> => {
    let resolve: (route: Route) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const pending = new Promise<Route>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    asked.push({
      room,
      settle: async (ok) => {
        await act(async () => {
          if (ok) resolve({ steps: [], cost: 0, blocked: false } as unknown as Route);
          else reject(new Error('no way'));
          await pending.catch(() => undefined);
        });
      }
    });
    return pending;
  };

  const props = (destination: WorldRoom | null): Parameters<typeof RoutePanel>[0] =>
    ({
      open: true,
      onClose: () => undefined,
      onSearch: () => Promise.resolve([]),
      onRoute,
      onWalk: () => Promise.resolve(null),
      onCollectThenWalk: () => Promise.resolve(null),
      destination,
      onLoadMap: () => new Promise(() => undefined),
      finds: [],
      onPeek: null,
      onPeekEnd: null
    }) as unknown as Parameters<typeof RoutePanel>[0];

  const draw = (destination: WorldRoom | null): void =>
    panel.render(createElement(RoutePanel, props(destination)));

  /** The planning line's text, once per line on screen. */
  const shown = (): string[] =>
    panel
      .root()
      .findAll((node) => node.props.className === 'route-planning')
      .map((node) => {
        expect(node.props.role).toBe('status');
        return node.children.filter((child) => typeof child === 'string').join('');
      });
  const planningTo = (room: WorldRoom): string =>
    t('cards.route.planning', { roomName: room.name });

  afterEach(() => {
    asked.length = 0;
  });

  it('says so until the plan lands', async () => {
    draw(forest);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain(planningTo(forest));
    await asked[0]!.settle(true);
    expect(shown()).toEqual([]);
  });

  it('and until it fails', async () => {
    draw(forest);
    expect(shown()).toHaveLength(1);
    await asked[0]!.settle(false);
    expect(shown()).toEqual([]);
  });

  it('stops saying so when the destination is withdrawn, and the old plan does not land', async () => {
    draw(forest);
    expect(shown()).toHaveLength(1);
    draw(null);
    expect(shown()).toEqual([]);
    await asked[0]!.settle(true);
    expect(shown()).toEqual([]);
  });

  it('keeps saying so for the newer plan when an older one lands first', async () => {
    draw(forest);
    draw(stair);
    expect(asked.map((each) => each.room.name)).toEqual(['Fungus Forest', 'Grand Stair']);
    await asked[0]!.settle(true);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain(planningTo(stair));
    await asked[1]!.settle(true);
    expect(shown()).toEqual([]);
  });
});
