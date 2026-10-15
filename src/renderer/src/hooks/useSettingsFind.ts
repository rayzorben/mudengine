/**
 * The settings screen's find field: what is typed, and which sections of the
 * form on screen answer it. `mudengine-settings` › *Find a setting*. A
 * console's gear opens the screen narrowed the same way to the settings
 * behind one decision, the first of them in view, until anything is typed
 * (todo 119).
 */
import { useLayoutEffect, useMemo, useState, type RefObject } from 'react';

import { fieldSettingsOf } from '@shared/decisionSettings';
import type { SettingsFocus } from '../lib/settingPlaces';
import {
  applyFieldSet,
  applySettingsSearch,
  clearSettingsSearch,
  searches
} from '../lib/settingsSearch';

export interface SettingsFind {
  query: string;
  setQuery(query: string): void;
  /** Narrowed to the settings behind a decision rather than to words. */
  decision: boolean;
  /** The query has words or a decision is asked, so the forms draw every section. */
  searching: boolean;
  /** The sections shown, in the order drawn; null while not searching. */
  found: readonly string[] | null;
}

/**
 * @param body The screen's body, which holds whichever form is on screen. It
 *   is watched rather than the form, because a page or character switch
 *   replaces the form, and a switch opened under a search draws new fields.
 */
export function useSettingsFind(
  body: RefObject<HTMLElement>,
  focus: SettingsFocus | null
): SettingsFind {
  const [query, setTyped] = useState('');
  const [found, setFound] = useState<readonly string[] | null>(null);
  // The decision asked for, until the player types; a new door asks again.
  const [asked, setAsked] = useState(focus);
  const [door, setDoor] = useState(focus);
  if (door !== focus) {
    setDoor(focus);
    setAsked(focus);
  }
  const fields = useMemo(() => (asked === null ? null : fieldSettingsOf(asked.decision)), [asked]);
  const searching = searches(query) || fields !== null;
  const setQuery = useMemo(
    () => (next: string) => {
      setAsked(null);
      setTyped(next);
    },
    []
  );

  useLayoutEffect(() => {
    const root = body.current;
    if (!searching || root === null) {
      setFound(null);
      return;
    }
    // The first setting asked for is brought into view once, when the form holding it is drawn.
    let placed = fields === null;
    const run = (): void => {
      const form = root.querySelector('.settings-form');
      const next =
        form === null
          ? []
          : fields === null
            ? applySettingsSearch(form, query)
            : applyFieldSet(form, fields);
      setFound((was) => (was !== null && was.join() === next.join() ? was : next));
      const first = placed ? null : form?.querySelector('[data-search="hit"]');
      if (!first) return;
      first.scrollIntoView({ block: 'center' });
      // And the caret with it: the field the screen focuses on opening may be one the narrowing hid.
      // The control itself, not the hint's button that comes before it in the label.
      const control = first.querySelector<HTMLElement>('input, select, textarea');
      (control ?? first.querySelector<HTMLElement>('button:not(.hint-button)'))?.focus();
      placed = true;
    };
    run();
    if (fields === null) root.querySelector('.settings-form')?.scrollTo({ top: 0 });
    // The marks are attributes, so writing them never wakes this again; the
    // rail and the saving row change without changing what the form holds.
    const watch = new MutationObserver((records) => {
      if (records.some((record) => !outsideTheForm(record.target))) run();
    });
    watch.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      watch.disconnect();
      clearSettingsSearch(root);
    };
  }, [body, query, searching, fields]);

  return { query, setQuery, decision: fields !== null, searching, found };
}

function outsideTheForm(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return (element?.closest('.settings-nav, .settings-actions') ?? null) !== null;
}
