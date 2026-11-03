import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { useSearchBar, type SearchBarState } from '../useSearchBar';
import { mount } from './mount';
import type { SessionId } from '@shared/ipc';

/*
 * The search bar finds in the shown character's console. Switching tabs with
 * it open left the first character's console marked with every match and the
 * bar counting that character's matches over the second one's console; closing
 * it then cleared only the second console, so the marks stayed for good.
 */

type Console = { search(query: string, direction: 'next' | 'previous'): void; asked: string[] };

function fakeConsole(): Console {
  const asked: string[] = [];
  return { asked, search: (query) => void asked.push(query) };
}

let bar: SearchBarState | null = null;

function Probe({ session, consoles }: { session: SessionId; consoles: Map<SessionId, Console> }) {
  bar = useSearchBar(session, { current: consoles }, () => undefined);
  return null;
}

const probe = mount();
afterEach(() => {
  probe.unmount();
  bar = null;
});

function shown(): SearchBarState {
  if (bar === null) throw new Error('nothing is mounted');
  return bar;
}

const A = 'a' as SessionId;
const B = 'b' as SessionId;

describe('useSearchBar', () => {
  it('takes the find to the console now shown, and clears the one left behind', () => {
    const consoles = new Map([
      [A, fakeConsole()],
      [B, fakeConsole()]
    ]);
    probe.render(createElement(Probe, { session: A, consoles }));
    act(() => shown().openSearch());
    act(() => shown().run('orc', 'next'));
    act(() => shown().setResult({ index: 0, count: 3 }));
    expect(consoles.get(A)?.asked).toEqual(['orc']);

    probe.render(createElement(Probe, { session: B, consoles }));

    expect(consoles.get(A)?.asked).toEqual(['orc', '']);
    expect(consoles.get(B)?.asked).toEqual(['orc']);
    // A's count is not B's: B's console reports its own when it has searched.
    expect(shown().result).toBeUndefined();
  });

  it('leaves the consoles alone on a switch while the bar is shut', () => {
    const consoles = new Map([
      [A, fakeConsole()],
      [B, fakeConsole()]
    ]);
    probe.render(createElement(Probe, { session: A, consoles }));
    act(() => shown().openSearch());
    act(() => shown().run('orc', 'next'));
    act(() => shown().close());
    expect(consoles.get(A)?.asked).toEqual(['orc', '']);

    probe.render(createElement(Probe, { session: B, consoles }));

    expect(consoles.get(A)?.asked).toEqual(['orc', '']);
    expect(consoles.get(B)?.asked).toEqual([]);
  });

  it('asks the shown console after a switch away from a tab that has closed', () => {
    const consoles = new Map([
      [A, fakeConsole()],
      [B, fakeConsole()]
    ]);
    probe.render(createElement(Probe, { session: A, consoles }));
    act(() => shown().openSearch());
    act(() => shown().run('orc', 'next'));
    consoles.delete(A);

    probe.render(createElement(Probe, { session: B, consoles }));

    expect(consoles.get(B)?.asked).toEqual(['orc']);
  });
});
