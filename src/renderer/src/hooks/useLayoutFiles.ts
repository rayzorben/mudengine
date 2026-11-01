/**
 * Card layouts to and from a file (the rail head's Layouts menu). Main writes
 * and reads the text where the player picks (`main/app/layoutFiles.ts`); the
 * window writes the file and reads it back through the same funnel a kept
 * layout comes through (`namedLayoutOf`). A loaded layout joins the saved
 * ones and is put on at once.
 */
import { useCallback, useMemo, useRef } from 'react';

import type { IpcApi } from '@shared/ipc';

import {
  arrangementOf,
  layoutFileText,
  layoutName,
  writtenLayoutFile,
  type LayoutFileOutcome,
  type LayoutFilesApi,
  type NamedLayout,
  type NamedLayoutsApi
} from '../lib/cardLayouts';
import { t } from '../lib/i18n';
import { namedLayoutOf, type NamedLayoutCards } from './useNamedLayouts';

export type LayoutFileBridge = Pick<
  IpcApi,
  'saveCardLayout' | 'chooseCardLayoutFile' | 'readCardLayout'
>;

export function useLayoutFiles(
  bridge: LayoutFileBridge,
  cards: NamedLayoutCards,
  adopt: NamedLayoutsApi['adopt']
): LayoutFilesApi {
  // Read once the file is back, not when it was asked for: the picker can be
  // open across moves and settings changes, which a stale one would undo.
  const live = useRef(adopt);
  live.current = adopt;

  const save = useCallback(
    async (entry: NamedLayout): Promise<LayoutFileOutcome | null> => {
      const result = await bridge.saveCardLayout(entry.name, layoutFileText(entry));
      switch (result.kind) {
        case 'written':
          return { kind: 'saved', file: result.file };
        case 'dismissed':
          return null;
        case 'refused':
          return { kind: 'refused', error: result.error };
        default: {
          const never: never = result;
          return never;
        }
      }
    },
    [bridge]
  );

  const saveShown = useCallback(
    (typed: string) => {
      const name = layoutName(typed) ?? t('cards.layouts.fileName');
      return save({ name, layout: arrangementOf(cards) });
    },
    [save, cards]
  );

  const load = useCallback(async (): Promise<LayoutFileOutcome | null> => {
    const file = await bridge.chooseCardLayoutFile();
    if (file === null) return null;
    const read = await bridge.readCardLayout(file);
    if (read.kind === 'refused') return { kind: 'refused', error: read.error };
    const written = writtenLayoutFile(read.text);
    const entry = written === null ? null : namedLayoutOf(written);
    if (entry === null) return { kind: 'refused', error: t('app.cardLayout.notALayout') };
    live.current(entry);
    return { kind: 'loaded', name: entry.name };
  }, [bridge]);

  return useMemo(() => ({ save, saveShown, load }), [save, saveShown, load]);
}
