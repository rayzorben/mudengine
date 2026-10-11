import { useEffect, useState } from 'react';

import type { ExtensionInfo } from '@shared/extensions';

/**
 * Kept once answered: the extensions are found at startup and do not change
 * while it runs. The answer, not the asking, so a question a lost web socket
 * left unanswered is asked again by the remount (`lib/webBridge.ts`).
 */
let known: ExtensionInfo[] | null = null;

/**
 * The extensions installed in the home that draw a card (todo 84), empty
 * until main has answered and wherever none is installed.
 */
export function useExtensions(): readonly ExtensionInfo[] {
  const [extensions, setExtensions] = useState<readonly ExtensionInfo[]>([]);
  useEffect(() => {
    let live = true;
    const show = (all: ExtensionInfo[]): void => {
      if (live) setExtensions(all.filter((each) => each.page !== null));
    };
    if (known !== null) show(known);
    else
      void window.mudengine.listExtensions().then((all) => {
        known = all;
        show(all);
      });
    return () => {
      live = false;
    };
  }, []);
  return extensions;
}
