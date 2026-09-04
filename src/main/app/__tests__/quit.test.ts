import { describe, expect, it, vi } from 'vitest';

import { quitGuard, type QuitAnswer } from '../quit';
import type { SessionId } from '../../../shared/ipc';

function harness(options: { connected?: SessionId[]; answer?: QuitAnswer } = {}) {
  const state = {
    connected: options.connected ?? ([] as SessionId[]),
    answer: options.answer ?? ('quit' as QuitAnswer)
  };
  const asked: SessionId[][] = [];
  const ensureWindow = vi.fn();
  const teardown = vi.fn();
  const guard = quitGuard({
    connected: () => state.connected,
    ask: (connected) => {
      asked.push(connected);
      return state.answer;
    },
    ensureWindow,
    teardown
  });
  const quit = () => {
    const prevented = vi.fn();
    guard.beforeQuit({ preventDefault: prevented });
    return prevented.mock.calls.length > 0;
  };
  /** What a window's own `close` handler asks before it lets the window go. */
  const closeWindow = () => guard.mayQuit();
  return { state, asked, ensureWindow, teardown, quit, closeWindow };
}

describe('quitGuard', () => {
  it('does not ask when nobody is in the realm, and lets the quit happen', () => {
    const app = harness();
    expect(app.quit()).toBe(false);
    expect(app.asked).toEqual([]);
    expect(app.teardown).toHaveBeenCalledTimes(1);
  });

  /*
   * The bug this file exists for: the quit used to be prevented before the
   * question was asked, on the assumption that agreeing produced a second
   * `before-quit` to fall through. Nothing re-issues a cancelled quit, so the
   * sessions were torn down and the process went on running with no window —
   * the client looked closed and its terminal never came back.
   */
  it('never prevents the quit once the player has agreed to it', () => {
    const app = harness({ connected: ['warrior'], answer: 'quit' });
    expect(app.quit()).toBe(false);
    expect(app.asked).toEqual([['warrior']]);
    expect(app.teardown).toHaveBeenCalledTimes(1);
    expect(app.ensureWindow).not.toHaveBeenCalled();
  });

  it('prevents it to keep playing, and leaves somewhere to play in', () => {
    const app = harness({ connected: ['healer'], answer: 'stay' });
    expect(app.quit()).toBe(true);
    expect(app.teardown).not.toHaveBeenCalled();
    expect(app.ensureWindow).toHaveBeenCalledTimes(1);
  });

  it('asks again the next time, because the realm has moved on', () => {
    const app = harness({ connected: ['healer'], answer: 'stay' });
    app.quit();
    app.state.answer = 'quit';
    expect(app.quit()).toBe(false);
    expect(app.asked).toHaveLength(2);
    expect(app.teardown).toHaveBeenCalledTimes(1);
  });

  it('asks once and disposes once, however many times the quit is signalled', () => {
    const app = harness({ connected: ['rogue'], answer: 'quit' });
    app.quit();
    expect(app.quit()).toBe(false);
    expect(app.asked).toHaveLength(1);
    expect(app.teardown).toHaveBeenCalledTimes(1);
  });
});

/*
 * The window is what people actually close, and it used to close regardless.
 *
 * Closing the last one raises `window-all-closed`, which quits, which asks --
 * by which time the window is gone. Answering "keep playing" left four
 * characters connected to a PvP realm with nothing on screen to play them
 * with. The window asks first now, and vetoes its own close.
 */
describe('closing the window that would end the app', () => {
  it('is refused when the player says they are still playing', () => {
    const app = harness({ connected: ['healer'], answer: 'stay' });
    expect(app.closeWindow()).toBe(false);
    expect(app.teardown).not.toHaveBeenCalled();
  });

  it('does not ask a second time once the player has agreed', () => {
    const app = harness({ connected: ['warrior'], answer: 'quit' });
    expect(app.closeWindow()).toBe(true);
    // The close goes through, `window-all-closed` quits, and `before-quit`
    // must not put the same question up again on the way past.
    expect(app.quit()).toBe(false);
    expect(app.asked).toHaveLength(1);
    expect(app.teardown).toHaveBeenCalledTimes(1);
  });

  it('says nothing at all when nobody is in the realm', () => {
    const app = harness();
    expect(app.closeWindow()).toBe(true);
    expect(app.asked).toEqual([]);
    // And asking did not tear anything down: only the quit does that.
    expect(app.teardown).not.toHaveBeenCalled();
  });
});
