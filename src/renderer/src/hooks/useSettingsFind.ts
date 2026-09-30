/**
 * The settings screen's find field: what is typed, and which sections of the
 * form on screen answer it. `mudengine-settings` › *Find a setting*.
 */
import { useLayoutEffect, useState, type RefObject } from 'react';

import { applySettingsSearch, clearSettingsSearch, searches } from '../lib/settingsSearch';

export interface SettingsFind {
  query: string;
  setQuery(query: string): void;
  /** The query has words, so the forms draw every section. */
  searching: boolean;
  /** The sections shown, in the order drawn; null while not searching. */
  found: readonly string[] | null;
}

/**
 * @param body The screen's body, which holds whichever form is on screen. It
 *   is watched rather than the form, because a page or character switch
 *   replaces the form, and a switch opened under a search draws new fields.
 */
export function useSettingsFind(body: RefObject<HTMLElement>): SettingsFind {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<readonly string[] | null>(null);
  const searching = searches(query);

  useLayoutEffect(() => {
    const root = body.current;
    if (!searching || root === null) {
      setFound(null);
      return;
    }
    const run = (): void => {
      const form = root.querySelector('.settings-form');
      const next = form === null ? [] : applySettingsSearch(form, query);
      setFound((was) => (was !== null && was.join() === next.join() ? was : next));
    };
    run();
    root.querySelector('.settings-form')?.scrollTo({ top: 0 });
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
  }, [body, query, searching]);

  return { query, setQuery, searching, found };
}

function outsideTheForm(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return (element?.closest('.settings-nav, .settings-actions') ?? null) !== null;
}
