/**
 * The saved card layouts (the rail head's Layouts menu): kept per client in
 * `localStorage`, so a layout saved on one character is offered on every
 * other, and put on the shown character's cards. Another window of the client
 * saving one is heard through `storage`. See `mudengine-ui` ›
 * `parts/cards.md`, *Named card layouts*.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  arrangementOf,
  layoutName,
  shownLayout,
  withLayout,
  withoutLayout,
  writtenLayout,
  type NamedLayout,
  type NamedLayoutsApi
} from '../lib/cardLayouts';
import type { CardArrangement, CardLayoutApi } from '../lib/cards';
import { readStored, writeStored } from '../lib/storage';
import { layoutOf } from './useCardLayout';

const KEY = 'mudengine.layouts';

/** A written layout read as the client reads a kept one, through `layoutOf`. */
export function namedLayoutOf(value: unknown): NamedLayout | null {
  const written = writtenLayout(value);
  return written === null
    ? null
    : { name: written.name, layout: arrangementOf(layoutOf(written.layout)) };
}

/** The stored list; an entry that does not read is dropped, and a name kept twice keeps its last. */
function readLayouts(): NamedLayout[] {
  return readStored(
    KEY,
    (stored) => {
      const value: unknown = JSON.parse(stored);
      if (!Array.isArray(value)) return [];
      return value.reduce<NamedLayout[]>((list, entry) => {
        const read = namedLayoutOf(entry);
        return read === null ? list : withLayout(list, read);
      }, []);
    },
    () => []
  );
}

/** The layout api whole: `arrangementOf` reads every field a layout keeps. */
export type NamedLayoutCards = Pick<CardLayoutApi, keyof CardArrangement | 'apply'>;

export function useNamedLayouts(cards: NamedLayoutCards): NamedLayoutsApi {
  const [layouts, setLayouts] = useState<readonly NamedLayout[]>(readLayouts);

  useEffect(() => {
    const heard = (event: StorageEvent): void => {
      if (event.key === KEY || event.key === null) setLayouts(readLayouts());
    };
    window.addEventListener('storage', heard);
    return () => window.removeEventListener('storage', heard);
  }, []);

  /*
   * A change is made to the list as stored, read again first, so a layout
   * another window saved since this one last heard is not written over.
   */
  const keep = useCallback((change: (list: readonly NamedLayout[]) => NamedLayout[]) => {
    const next = change(readLayouts());
    setLayouts(next);
    writeStored(KEY, JSON.stringify(next));
  }, []);

  const { apply } = cards;
  const arrangement = useMemo(() => arrangementOf(cards), [cards]);
  const shown = useMemo(() => shownLayout(layouts, arrangement), [layouts, arrangement]);

  const save = useCallback(
    (typed: string) => {
      const name = layoutName(typed);
      if (name !== null) keep((list) => withLayout(list, { name, layout: arrangement }));
    },
    [keep, arrangement]
  );
  const applyNamed = useCallback(
    (name: string) => {
      const found = layouts.find((entry) => entry.name === name);
      if (found) apply(found.layout);
    },
    [layouts, apply]
  );
  const adopt = useCallback(
    (entry: NamedLayout) => {
      keep((list) => withLayout(list, entry));
      apply(entry.layout);
    },
    [keep, apply]
  );
  const remove = useCallback((name: string) => keep((list) => withoutLayout(list, name)), [keep]);

  return useMemo(
    () => ({ layouts, shown, save, apply: applyNamed, adopt, remove }),
    [layouts, shown, save, applyNamed, adopt, remove]
  );
}
