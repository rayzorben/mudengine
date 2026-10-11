import { describe, expect, it, vi } from 'vitest';

import { recentMenuItems, type RecentMenuDeps } from '../recentMenu';
import type { SessionId } from '@shared/ipc';
import { roomId, type Route } from '@shared/world';

const HERO = 'hero' as SessionId;

const ROUTE: Route = {
  steps: [
    {
      from: roomId(1, 1),
      to: roomId(1, 2),
      direction: 'n' as const,
      command: 'n',
      name: 'Bank of Godfrey',
      requirement: null,
      dark: false
    }
  ],
  cost: 1,
  blocked: false
};

function deps(): RecentMenuDeps & { walked: ReturnType<typeof vi.fn> } {
  const walked = vi.fn(async () => ({ started: true as const }));
  return {
    api: { routeTo: vi.fn(async () => ROUTE), walkRoute: walked },
    session: HERO,
    openRouteOn: vi.fn(),
    startLoop: vi.fn(),
    walked
  };
}

const BANK = { map: 1, room: 2, name: 'Bank of Godfrey', exits: [], visitedAt: 1_000 };

describe('the recent rows on the console menu', () => {
  it('offers nothing when nothing is recent', () => {
    expect(recentMenuItems([], [], deps(), 2_000)).toEqual([]);
  });

  it('puts the rooms before the loops, the first row divided from Copy and Paste', () => {
    const items = recentMenuItems([BANK], ['Darkwood'], deps(), 2_000);
    expect(items.map((item) => [item.icon, item.divided === true])).toEqual([
      ['route', true],
      ['loop', false]
    ]);
  });

  it('walks a room in one click, through the route it plans', async () => {
    const made = deps();
    recentMenuItems([BANK], [], made, 2_000)[0]!.run();
    await vi.waitFor(() => expect(made.walked).toHaveBeenCalledWith(HERO, ROUTE));
    expect(made.openRouteOn).not.toHaveBeenCalled();
  });

  it('starts a loop by name', () => {
    const made = deps();
    recentMenuItems([], ['Darkwood'], made, 2_000)[0]!.run();
    expect(made.startLoop).toHaveBeenCalledWith('Darkwood');
  });
});
