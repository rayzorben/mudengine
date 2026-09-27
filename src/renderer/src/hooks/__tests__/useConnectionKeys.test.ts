import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useConnectionKeys } from '../useConnectionKeys';
import { mount } from './mount';

/*
 * The panic keys (todo 04). The suite runs in node, so the window is a bare
 * `EventTarget` and a keydown is an `Event` carrying the fields `useHotkeys`
 * reads. Every binding here is a chord, so nothing asks for `HTMLElement`.
 */

interface ProbeProps {
  toggle: () => void;
  hangUp: () => void;
}

function Probe({ toggle, hangUp }: ProbeProps): null {
  useConnectionKeys(toggle, hangUp);
  return null;
}

function press(init: { key: string; code?: string; ctrl?: boolean; alt?: boolean }): Event {
  const event = Object.assign(new Event('keydown', { cancelable: true }), {
    key: init.key,
    code: init.code ?? '',
    ctrlKey: init.ctrl ?? false,
    metaKey: false,
    altKey: init.alt ?? false,
    shiftKey: false
  });
  window.dispatchEvent(event);
  return event;
}

const probe = mount();

beforeEach(() => vi.stubGlobal('window', new EventTarget()));
afterEach(() => {
  probe.unmount();
  vi.unstubAllGlobals();
});

describe('useConnectionKeys', () => {
  it('hangs up on Alt H and on Ctrl Q, and never dials', () => {
    const toggle = vi.fn();
    const hangUp = vi.fn();
    probe.render(createElement(Probe, { toggle, hangUp }));

    expect(press({ key: 'h', code: 'KeyH', alt: true }).defaultPrevented).toBe(true);
    expect(press({ key: 'q', code: 'KeyQ', ctrl: true }).defaultPrevented).toBe(true);
    // Option turns H into another glyph on macOS; the physical key still counts.
    press({ key: '˙', code: 'KeyH', alt: true });

    expect(hangUp).toHaveBeenCalledTimes(3);
    expect(toggle).not.toHaveBeenCalled();
  });

  it('keeps Ctrl Enter as the toggle, and leaves a bare H and Q to the game', () => {
    const toggle = vi.fn();
    const hangUp = vi.fn();
    probe.render(createElement(Probe, { toggle, hangUp }));

    expect(press({ key: 'h' }).defaultPrevented).toBe(false);
    expect(press({ key: 'q' }).defaultPrevented).toBe(false);
    press({ key: 'Enter', ctrl: true });

    expect(toggle).toHaveBeenCalledTimes(1);
    expect(hangUp).not.toHaveBeenCalled();
  });
});
