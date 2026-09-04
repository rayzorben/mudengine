import { describe, expect, it, vi } from 'vitest';

import { ALREADY_RUNNING, ownTheProfile } from '../instance';

function harness(options: { claimed?: boolean } = {}) {
  const said: string[] = [];
  const raise = vi.fn();
  const leave = vi.fn();
  let bounce: (() => void) | null = null;
  const owns = ownTheProfile({
    claim: () => options.claimed ?? true,
    onAnotherLaunch: (handler) => {
      bounce = handler;
    },
    raise,
    say: (message) => said.push(message),
    leave
  });
  return { owns, said, raise, leave, launchAnother: (): void => bounce?.() };
}

describe('ownTheProfile', () => {
  it('starts, and raises the window when a second launch bounces off it', () => {
    const app = harness();
    expect(app.owns).toBe(true);
    expect(app.said).toEqual([]);
    expect(app.leave).not.toHaveBeenCalled();

    app.launchAnother();
    expect(app.raise).toHaveBeenCalledTimes(1);
  });

  /*
   * The failure this exists for is silent, so the refusal must not be. A
   * second launch that simply exits is indistinguishable from one that crashed
   * — and somebody who has just double-clicked the client is owed the reason
   * in the terminal it was launched from, because it has no window to use.
   */
  it('says why it is leaving, and leaves, when somebody already has the profile', () => {
    const app = harness({ claimed: false });
    expect(app.owns).toBe(false);
    expect(app.said).toEqual([ALREADY_RUNNING]);
    expect(app.leave).toHaveBeenCalledTimes(1);
  });

  /*
   * The bounced launch must not subscribe to anything: it is on its way out,
   * and a handler that raises a window this process never opened would fire in
   * a client that has no windows at all.
   */
  it('subscribes to nothing when it does not own the profile', () => {
    const app = harness({ claimed: false });
    app.launchAnother();
    expect(app.raise).not.toHaveBeenCalled();
  });
});
