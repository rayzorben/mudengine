import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useRoutePanel, type RoutePanelState } from '../useRoutePanel';
import { mount } from './mount';

/*
 * The panel hands the caret back after it has closed (todo 00): from an
 * effect, so the dialog is gone from the page when `returnFocus` looks for one.
 */

let panel: RoutePanelState | null = null;

function Probe({ returnFocus }: { returnFocus: () => void }): null {
  panel = useRoutePanel(returnFocus);
  return null;
}

const probe = mount();

afterEach(() => {
  probe.unmount();
  panel = null;
});

function shown(): RoutePanelState {
  if (panel === null) throw new Error('nothing is mounted');
  return panel;
}

describe('useRoutePanel', () => {
  it('hands the caret back once per close, by either way of closing', () => {
    const returnFocus = vi.fn();
    probe.render(createElement(Probe, { returnFocus }));
    expect(returnFocus).not.toHaveBeenCalled();

    shown().openCold();
    probe.render(createElement(Probe, { returnFocus }));
    expect(shown().open).toBe(true);
    expect(returnFocus).not.toHaveBeenCalled();

    /*
     * Not until the panel has gone from the page. Inside `act`, as the app's
     * concurrent root batches a close's updates: the test renderer's legacy
     * root renders each update outside `act` at once, flushing the last one's
     * effects before the next.
     */
    act(() => {
      shown().close();
      expect(returnFocus).not.toHaveBeenCalled();
    });
    probe.render(createElement(Probe, { returnFocus }));
    expect(shown().open).toBe(false);
    expect(returnFocus).toHaveBeenCalledTimes(1);

    shown().toggleCold();
    probe.render(createElement(Probe, { returnFocus }));
    shown().toggleCold();
    probe.render(createElement(Probe, { returnFocus }));
    expect(returnFocus).toHaveBeenCalledTimes(2);

    // Closing a closed panel is not a second hand-back.
    shown().close();
    probe.render(createElement(Probe, { returnFocus }));
    expect(returnFocus).toHaveBeenCalledTimes(2);
  });

  it('drops the name it was opened on when it closes, by either way of closing (todo 136)', () => {
    const returnFocus = vi.fn();
    const draw = (): void => probe.render(createElement(Probe, { returnFocus }));
    draw();

    shown().openOn(null, 'grave');
    draw();
    expect(shown().search).toBe('grave');
    shown().close();
    draw();
    shown().toggleCold();
    draw();
    expect(shown().open).toBe(true);
    expect(shown().search).toBeNull();

    shown().openOn(null, 'grave');
    draw();
    expect(shown().search).toBe('grave');
    shown().toggleCold();
    draw();
    expect(shown().open).toBe(false);
    expect(shown().search).toBeNull();
  });
});
