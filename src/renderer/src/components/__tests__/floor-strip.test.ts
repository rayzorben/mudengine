import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import FloorStrip from '../game/FloorStrip';
import { mount } from '../../hooks/__tests__/mount';

const probe = mount();
afterEach(() => probe.unmount());

describe('the floor strip', () => {
  const floors = [
    { floor: 1, to: '1/20' },
    { floor: 0, to: null },
    { floor: -2, to: '1/30' }
  ];

  it('shows a floor around the room its nearest stair reaches', () => {
    const onShow = vi.fn();
    probe.render(createElement(FloorStrip, { floors, home: -2, onShow }));
    const buttons = probe.root().findAllByType('button');
    expect(buttons.map((button) => button.props['data-floor'])).toEqual([1, 0, -2]);
    // The floor shown is the one held, and the character's own is marked.
    expect(buttons[1]!.props.disabled).toBe(true);
    expect(buttons[2]!.props['data-home']).toBe('true');
    act(() => buttons[2]!.props.onClick());
    expect(onShow).toHaveBeenCalledWith('1/30');
  });

  it('is not drawn when no stair reaches another floor', () => {
    probe.render(createElement(FloorStrip, { floors: [], home: 0, onShow: vi.fn() }));
    expect(probe.root().findAllByType('button')).toEqual([]);
  });
});
