import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTabKeys } from '../useTabKeys';
import { mount } from './mount';

/*
 * `Alt 1` to `Alt 9` show a character by its place on the tab rail. The suite
 * runs in node, so the window is a bare `EventTarget`, as in
 * `useConnectionKeys.test.ts`.
 */

interface ProbeProps {
  ids: string[];
  /** Characters another player shares, which take no key. */
  shared?: string[];
  show: (id: string) => void;
  step: (delta: number) => void;
}

const REMOTE = { via: 'festus', viaName: 'Festus' };

function Probe({ ids, shared = [], show, step }: ProbeProps): null {
  useTabKeys(
    ids.map((id) => ({ id, remote: shared.includes(id) ? REMOTE : null })),
    show,
    step
  );
  return null;
}

function press(init: { key: string; code: string; ctrl?: boolean; alt?: boolean }): Event {
  const event = Object.assign(new Event('keydown', { cancelable: true }), {
    key: init.key,
    code: init.code,
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

describe('useTabKeys', () => {
  it('shows the character at that place on the rail', () => {
    const show = vi.fn();
    probe.render(createElement(Probe, { ids: ['a', 'b', 'c'], show, step: vi.fn() }));

    expect(press({ key: '1', code: 'Digit1', alt: true }).defaultPrevented).toBe(true);
    expect(press({ key: '3', code: 'Digit3', alt: true }).defaultPrevented).toBe(true);
    // Option turns 2 into another glyph on macOS; the physical key still counts.
    press({ key: '™', code: 'Digit2', alt: true });

    expect(show.mock.calls).toEqual([['a'], ['c'], ['b']]);
  });

  it("counts this install's own characters, as the rail does", () => {
    const show = vi.fn();
    probe.render(
      createElement(Probe, { ids: ['a', 'theirs', 'b'], shared: ['theirs'], show, step: vi.fn() })
    );

    press({ key: '2', code: 'Digit2', alt: true });
    expect(press({ key: '3', code: 'Digit3', alt: true }).defaultPrevented).toBe(false);

    expect(show.mock.calls).toEqual([['b']]);
  });

  it('follows the rail when its order changes', () => {
    const show = vi.fn();
    const step = vi.fn();
    probe.render(createElement(Probe, { ids: ['a', 'b'], show, step }));
    probe.render(createElement(Probe, { ids: ['b', 'a'], show, step }));

    press({ key: '1', code: 'Digit1', alt: true });

    expect(show.mock.calls).toEqual([['b']]);
  });

  it('leaves a digit past the last character, a bare digit and a keypad digit alone', () => {
    const show = vi.fn();
    probe.render(createElement(Probe, { ids: ['a', 'b'], show, step: vi.fn() }));

    // Positive control: the binding is live.
    expect(press({ key: '2', code: 'Digit2', alt: true }).defaultPrevented).toBe(true);
    expect(press({ key: '3', code: 'Digit3', alt: true }).defaultPrevented).toBe(false);
    expect(press({ key: '1', code: 'Digit1' }).defaultPrevented).toBe(false);
    expect(press({ key: '1', code: 'Numpad1', alt: true }).defaultPrevented).toBe(false);
    expect(press({ key: '1', code: 'Digit1', alt: true, ctrl: true }).defaultPrevented).toBe(false);

    expect(show.mock.calls).toEqual([['b']]);
  });

  it('binds nine at most, and still steps on Ctrl Tab', () => {
    const show = vi.fn();
    const step = vi.fn();
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    probe.render(createElement(Probe, { ids, show, step }));

    press({ key: '9', code: 'Digit9', alt: true });
    expect(press({ key: '0', code: 'Digit0', alt: true }).defaultPrevented).toBe(false);
    press({ key: 'Tab', code: 'Tab', ctrl: true });

    expect(show.mock.calls).toEqual([['i']]);
    expect(step.mock.calls).toEqual([[1]]);
  });
});
