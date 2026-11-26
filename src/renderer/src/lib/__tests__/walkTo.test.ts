import { describe, expect, it, vi } from 'vitest';

import { walkTo } from '../walkTo';
import type { SessionId } from '@shared/ipc';
import { roomId, type Route } from '@shared/world';

const HERO = 'hero' as SessionId;
const BANK = { map: 1, room: 2, name: 'Bank of Godfrey', exits: [] };

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

function deps() {
  const walkRoute = vi.fn(async () => ({ started: true as const }));
  const openRouteOn = vi.fn();
  return {
    walkRoute,
    openRouteOn,
    deps: { api: { routeTo: vi.fn(async () => ROUTE), walkRoute }, session: HERO, openRouteOn }
  };
}

describe('walkTo', () => {
  it('walks a plan with auto-combat left as it is', async () => {
    const made = deps();
    walkTo(BANK, made.deps);
    await vi.waitFor(() => expect(made.walkRoute).toHaveBeenCalledWith(HERO, ROUTE));
    expect(made.openRouteOn).not.toHaveBeenCalled();
  });

  it('runs a plan when asked to', async () => {
    const made = deps();
    walkTo(BANK, made.deps, true);
    await vi.waitFor(() => expect(made.walkRoute).toHaveBeenCalledWith(HERO, ROUTE, true));
    expect(made.openRouteOn).not.toHaveBeenCalled();
  });
});
