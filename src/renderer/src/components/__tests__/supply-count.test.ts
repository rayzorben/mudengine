import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CountInput } from '../SupplyControls';
import { stockCeiling } from '@shared/supplies';
import { mount } from '../../hooks/__tests__/mount';

/*
 * Min and max on an item's panel: typed into, then the panel closed with the
 * cursor still in the field. Closing takes the field away without a blur, and
 * the figure typed was lost (user, 2026-10-07).
 */
describe('a supply count typed and not left', () => {
  const probe = mount();
  afterEach(() => probe.unmount());

  const draw = (onCommit: (value: number) => void, value = 0): void =>
    probe.render(createElement(CountInput, { label: 'min', onCommit, value }));
  const input = () => probe.root().findByType('input');
  const type = (text: string): void => {
    act(() => {
      input().props.onChange({ target: { value: text } });
    });
  };

  it('is committed when the panel closes', () => {
    const onCommit = vi.fn();
    draw(onCommit);
    type('12');
    expect(onCommit).not.toHaveBeenCalled();
    probe.unmount();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(12);
  });

  it('is committed once when left and then closed', () => {
    const onCommit = vi.fn();
    draw(onCommit);
    type('3');
    act(() => {
      input().props.onBlur();
    });
    expect(onCommit).toHaveBeenCalledWith(3);
    probe.unmount();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the field was never typed in', () => {
    const onCommit = vi.fn();
    draw(onCommit, 4);
    act(() => {
      input().props.onBlur();
    });
    probe.unmount();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('puts back the saved figure for something that is not a count', () => {
    const onCommit = vi.fn();
    draw(onCommit, 4);
    type('lots');
    act(() => {
      input().props.onBlur();
    });
    expect(input().props.value).toBe('4');
    expect(onCommit).not.toHaveBeenCalled();
  });
});

/*
 * A Max typed under its Min (todo 149): committed as typed, so the write can
 * say it was raised, and shown at the Min the list will hold.
 */
describe('a supply count the list keeps higher', () => {
  const probe = mount();
  afterEach(() => probe.unmount());

  it('is committed as typed and shown as the list keeps it', () => {
    const onCommit = vi.fn();
    probe.render(
      createElement(CountInput, {
        label: 'max',
        onCommit,
        value: 3,
        shown: (max: number) => stockCeiling({ min: 3, max })
      })
    );
    const input = () => probe.root().findByType('input');
    act(() => {
      input().props.onChange({ target: { value: '2' } });
    });
    act(() => {
      input().props.onBlur();
    });
    expect(onCommit).toHaveBeenCalledWith(2);
    expect(input().props.value).toBe('3');
  });
});
