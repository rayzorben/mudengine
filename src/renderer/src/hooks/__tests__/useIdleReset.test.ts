import { createElement, type MutableRefObject } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useIdleReset } from '../useIdleReset';
import { mount } from './mount';

interface ProbeProps {
  active: boolean;
  onIdle: () => void;
  out: MutableRefObject<(() => void) | null>;
}

function Probe({ active, onIdle, out }: ProbeProps): null {
  out.current = useIdleReset(active, () => 1000, onIdle);
  return null;
}

describe('useIdleReset', () => {
  const view = mount();
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    view.unmount();
    vi.useRealTimers();
  });

  const probe = (active: boolean, onIdle: () => void, out: ProbeProps['out']) =>
    view.render(createElement(Probe, { active, onIdle, out }));

  it('fires once the hold has gone untouched for the delay, and not before', () => {
    const onIdle = vi.fn();
    const out: ProbeProps['out'] = { current: null };
    probe(true, onIdle, out);
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(onIdle).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  /*
   * The Map card re-renders on every status line. The clock is the hold's,
   * not the render's: a render with `active` unchanged leaves it running
   * (the reviewer's case), and only a touch starts it again.
   */
  it('keeps the clock running across re-renders, and restarts it only on a touch', () => {
    const onIdle = vi.fn();
    const out: ProbeProps['out'] = { current: null };
    probe(true, onIdle, out);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    // A new `onIdle` arrow each render, as a component passes one.
    probe(
      true,
      vi.fn(() => onIdle()),
      out
    );
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('starts the clock again from each touch', () => {
    const onIdle = vi.fn();
    const out: ProbeProps['out'] = { current: null };
    probe(true, onIdle, out);
    act(() => {
      vi.advanceTimersByTime(900);
    });
    act(() => out.current?.());
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(onIdle).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('runs no clock while inactive, and puts a running one down', () => {
    const onIdle = vi.fn();
    const out: ProbeProps['out'] = { current: null };
    probe(false, onIdle, out);
    act(() => out.current?.());
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onIdle).not.toHaveBeenCalled();
    // Positive control, then the hold let go by its owner before the clock lapses.
    probe(true, onIdle, out);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    probe(false, onIdle, out);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onIdle).not.toHaveBeenCalled();
    probe(true, onIdle, out);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});
