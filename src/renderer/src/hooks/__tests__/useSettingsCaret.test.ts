import { createElement, type RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsCaret } from '../useSettingsCaret';
import { mount } from './mount';

interface ProbeProps {
  page: string | null;
  body: RefObject<HTMLElement>;
  firstField: RefObject<HTMLElement>;
  firstFieldFirst: boolean;
}

function Probe({ page, body, firstField, firstFieldFirst }: ProbeProps): null {
  useSettingsCaret(page, body, firstField, firstFieldFirst);
  return null;
}

describe('useSettingsCaret', () => {
  const view = mount();
  let frames: Array<() => void> = [];
  const frame = (): void => {
    const due = frames;
    frames = [];
    for (const run of due) run();
  };

  const find = { focus: vi.fn() };
  const first = { focus: vi.fn() };
  const firstField = { current: first } as unknown as RefObject<HTMLElement>;
  /** A body whose rail draws a find field, or one that draws none, as the realm page does. */
  const bodyWith = (field: typeof find | null): RefObject<HTMLElement> =>
    ({ current: { querySelector: () => field } }) as unknown as RefObject<HTMLElement>;

  const probe = (page: string | null, body: RefObject<HTMLElement>, firstFieldFirst = false) =>
    view.render(createElement(Probe, { page, body, firstField, firstFieldFirst }));

  beforeEach(() => {
    frames = [];
    find.focus.mockClear();
    first.focus.mockClear();
    vi.stubGlobal('window', {
      requestAnimationFrame: (run: () => void) => frames.push(run),
      cancelAnimationFrame: () => {
        frames = [];
      }
    });
  });
  afterEach(() => {
    view.unmount();
    vi.unstubAllGlobals();
  });

  it('puts the caret in the find field when the screen opens', () => {
    probe('characters:vaelor', bodyWith(find));
    frame();
    expect(find.focus).toHaveBeenCalledTimes(1);
    expect(first.focus).not.toHaveBeenCalled();
  });

  it('puts it in the first field on a page with no find field', () => {
    probe('realms:null', bodyWith(null));
    frame();
    expect(first.focus).toHaveBeenCalledTimes(1);
  });

  it('puts it in the first field when that is the one wanted, a new character', () => {
    probe('characters:new', bodyWith(find), true);
    frame();
    expect(first.focus).toHaveBeenCalledTimes(1);
    expect(find.focus).not.toHaveBeenCalled();
  });

  it('places it again on a change of page, and not on a redraw of the same one', () => {
    const body = bodyWith(find);
    probe('characters:vaelor', body);
    frame();
    // Positive control: the first placement happened, so a redraw had its chance to repeat it.
    expect(find.focus).toHaveBeenCalledTimes(1);
    probe('characters:vaelor', body, true);
    frame();
    expect(find.focus).toHaveBeenCalledTimes(1);
    expect(first.focus).not.toHaveBeenCalled();
    probe('global:vaelor', body);
    frame();
    expect(find.focus).toHaveBeenCalledTimes(2);
  });

  it('places nothing while the screen is closed', () => {
    probe(null, bodyWith(find));
    expect(frames).toEqual([]);
  });
});
