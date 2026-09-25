/**
 * A directory of the client's, drawn in the window, and closing it, which
 * hands the caret back to the dialog that asked for it if one did.
 *
 * Out of `App` (todo 732) with the state it owns. See `mudengine-ui` ›
 * *Focus lives in the terminal* (a dialog drawn over a dialog).
 */
import { useCallback, useEffect, useState } from 'react';

import { registerRealmPicker } from '../lib/pickers';
import type { Revealed } from '@shared/ipc';

export interface HomeBrowsing {
  start: string | null;
  /** The realm picker's promise, waiting on a file; null for a plain listing. */
  pick: ((file: string | null) => void) | null;
  /** The dialog control holding the caret when the browser was asked for, if any. */
  opener: HTMLElement | null;
}

export interface HomeBrowserState {
  /** Null while it is closed. */
  browsing: HomeBrowsing | null;
  close(): void;
  /** Reveal through the host, and show the listing where the host could not open one. */
  reveal(ask: () => Promise<Revealed>): void;
}

/**
 * Two things open it. Revealing a path — the options file, the characters
 * folder, the logs — answers `listed` from a host that has no file manager
 * to open on the machine the files are on, and the listing is what the
 * window shows instead of nothing. And the realm picker in web mode: the
 * bridge asks the window for one (`lib/pickers.ts`) because the disk being
 * chosen from is the client's, and `pick` is the promise it is waiting on.
 *
 * @param returnFocus The window's one hand-back, where no dialog asked.
 */
export function useHomeBrowser(returnFocus: () => void): HomeBrowserState {
  const [browsing, setBrowsing] = useState<HomeBrowsing | null>(null);

  /*
   * The browser hands the caret back to the dialog that asked for it, and only
   * otherwise to the terminal: the settings screen is still up behind a realm
   * picker, and a caret sent past it into the game left that screen deaf to
   * its own Escape (2026-09-07). `mudengine-ui` § Focus lives in the terminal.
   */
  const openBrowser = useCallback(
    (start: string | null, pick: ((file: string | null) => void) | null) => {
      const active = document.activeElement;
      const opener =
        active instanceof HTMLElement && active.closest('[role="dialog"]') !== null ? active : null;
      setBrowsing({ start, pick, opener });
    },
    []
  );

  const close = useCallback(() => {
    const opener = browsing?.opener ?? null;
    setBrowsing(null);
    if (opener !== null && opener.isConnected) window.requestAnimationFrame(() => opener.focus());
    else returnFocus();
  }, [browsing, returnFocus]);

  const reveal = useCallback(
    (ask: () => Promise<Revealed>) => {
      void ask().then((revealed) => {
        if (revealed.how === 'listed') openBrowser(revealed.path, null);
      });
    },
    [openBrowser]
  );

  useEffect(() => {
    registerRealmPicker(() => new Promise((resolve) => openBrowser(null, resolve)));
    return () => registerRealmPicker(null);
  }, [openBrowser]);

  return { browsing, close, reveal };
}
