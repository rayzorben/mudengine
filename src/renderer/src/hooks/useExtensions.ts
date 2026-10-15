import { useEffect, useMemo, useState } from 'react';

import type { ExtensionInfo } from '@shared/extensions';

/**
 * Kept once answered: the extensions are found at startup and do not change
 * while it runs. The answer, not the asking, so a question a lost web socket
 * left unanswered is asked again by the remount (`lib/webBridge.ts`).
 */
let known: ExtensionInfo[] | null = null;

/**
 * Every extension installed in the home, switched off ones included (todo
 * 118), empty until main has answered and wherever none is installed.
 */
export function useInstalledExtensions(): readonly ExtensionInfo[] {
  const [extensions, setExtensions] = useState<readonly ExtensionInfo[]>(known ?? []);
  useEffect(() => {
    if (known !== null) return;
    let live = true;
    void window.mudengine.listExtensions().then((all) => {
      known = all;
      if (live) setExtensions(all);
    });
    return () => {
      live = false;
    };
  }, []);
  return extensions;
}

/** The extensions running this launch that draw a card (todo 84). */
export function useExtensions(): readonly ExtensionInfo[] {
  const installed = useInstalledExtensions();
  return useMemo(() => installed.filter((each) => each.loaded && each.page !== null), [installed]);
}
