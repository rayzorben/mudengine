import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RoutePage, WalkPages } from '@shared/routeLegs';
import { IDLE_WALK, type WalkProgress } from '@shared/walk';
import type { RouteStep } from '@shared/world';
import { useWalkPages, type LoadWalkPage, type WalkPager } from '../useWalkPages';
import { mount } from './mount';

/* Todo 20261102-1008-02: a walk sends two pages, and a later one is asked for when turned to. */

const page = (n: number): RoutePage => {
  const step: RouteStep = {
    from: `1/${n}`,
    to: `1/${n + 1}`,
    direction: 'e',
    command: 'e',
    name: `Room ${n + 1}`,
    requirement: null,
    dark: false
  };
  return { rooms: [step.from, step.to], steps: [step], jump: null, entry: null, sheet: null };
};

/** Five pages of one step each, the first two sent. */
const PAGED: WalkPages = { paging: 7, done: 0, lengths: [1, 1, 1, 1, 1], legs: [page(1), page(2)] };

const walk: WalkProgress = {
  ...IDLE_WALK,
  status: 'walking',
  total: 5,
  destination: 'Room 6',
  destinationRoom: { map: 1, room: 6 },
  path: ['1/1', '1/2', '1/3', '1/4', '1/5', '1/6']
};

let pager: WalkPager | null = null;

interface ProbeProps {
  load: () => Promise<WalkPages>;
  loadPage: LoadWalkPage;
  at?: WalkProgress;
}

function Probe({ load, loadPage, at = walk }: ProbeProps) {
  pager = useWalkPages(load, loadPage, at);
  return null;
}

/** Lets the answers already resolved land. */
const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe('useWalkPages', () => {
  const view = mount();
  afterEach(() => {
    view.unmount();
    pager = null;
  });

  it('asks for a page past the two sent only when the pager turns to it', async () => {
    const load = vi.fn(() => Promise.resolve(PAGED));
    const loadPage = vi.fn<LoadWalkPage>((_paging, index) => Promise.resolve(page(index + 1)));
    view.render(createElement(Probe, { load, loadPage }));
    await settle();
    // The positive control: the paging has landed and is being followed.
    expect(load).toHaveBeenCalledTimes(1);
    expect(pager?.walking).toBe(0);
    expect(pager?.legs).toHaveLength(5);
    expect(loadPage).not.toHaveBeenCalled();

    // The next page was sent: turning to it asks nothing.
    act(() => pager?.page(1));
    expect(pager?.shown).toBe(1);
    expect(loadPage).not.toHaveBeenCalled();

    // The fourth was not: it is asked for, and shown once it lands.
    act(() => pager?.page(3));
    expect(pager?.shown).toBeNull();
    await settle();
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(loadPage).toHaveBeenCalledWith(7, 3);
    expect(pager?.shown).toBe(3);
    expect(pager?.legs[3]?.rooms[0]).toBe('1/4');
  });

  it('asks for the page the walk steps onto, without paging the walk again', async () => {
    const load = vi.fn(() => Promise.resolve(PAGED));
    const loadPage = vi.fn<LoadWalkPage>((_paging, index) => Promise.resolve(page(index + 1)));
    view.render(createElement(Probe, { load, loadPage }));
    await settle();
    expect(pager?.walking).toBe(0);
    // Three steps on: the fourth page, which was not sent.
    view.render(
      createElement(Probe, { load, loadPage, at: { ...walk, done: 3, path: walk.path.slice(3) } })
    );
    await settle();
    expect(loadPage).toHaveBeenCalledWith(7, 3);
    expect(pager?.walking).toBe(3);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('pages the walk again once when main no longer keeps the paging', async () => {
    const load = vi.fn(() => Promise.resolve(PAGED));
    const loadPage = vi.fn<LoadWalkPage>(() => Promise.resolve(null));
    view.render(createElement(Probe, { load, loadPage }));
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    act(() => pager?.page(3));
    await settle();
    expect(loadPage).toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(2);
    expect(pager?.shown).toBeNull();
  });
});
