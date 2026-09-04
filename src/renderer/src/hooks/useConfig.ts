import { useEffect, useState } from 'react';

import { DEFAULT_CONFIG, type ConfigSnapshot } from '@shared/config';

const INITIAL: ConfigSnapshot = {
  config: DEFAULT_CONFIG,
  path: '',
  error: null,
  loadedAt: 0
};

/**
 * The live options file.
 *
 * The main process owns the file and its watcher; this hook only mirrors what
 * it publishes. The initial `getConfig` call covers the window between mount
 * and the first push, so the first paint already uses the user's font rather
 * than flashing the defaults.
 */
export function useConfig(): ConfigSnapshot {
  const [snapshot, setSnapshot] = useState<ConfigSnapshot>(INITIAL);

  useEffect(() => {
    let live = true;
    const off = window.mudengine.onConfig(setSnapshot);

    void window.mudengine.getConfig().then((current) => {
      // A push may have landed while the invoke was in flight; the pushed value
      // is never older, so do not let the reply overwrite it.
      if (live)
        setSnapshot((previous) => (previous.loadedAt >= current.loadedAt ? previous : current));
    });

    return () => {
      live = false;
      off();
    };
  }, []);

  return snapshot;
}
