import { useEffect, useState } from 'react';

import type { ExtensionInfo } from '@shared/extensions';

/** Asked once per window: the extensions are found at startup and do not change while it runs. */
let asked: Promise<ExtensionInfo[]> | null = null;

/**
 * The extensions installed in the home that draw a card (todo 84), empty
 * until main has answered and wherever none is installed.
 */
export function useExtensions(): readonly ExtensionInfo[] {
  const [extensions, setExtensions] = useState<readonly ExtensionInfo[]>([]);
  useEffect(() => {
    let live = true;
    asked ??= window.mudengine.listExtensions();
    void asked.then((all) => {
      if (live) setExtensions(all.filter((each) => each.page !== null));
    });
    return () => {
      live = false;
    };
  }, []);
  return extensions;
}
