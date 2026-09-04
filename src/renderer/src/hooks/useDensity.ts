import { useCallback, useEffect, useState } from 'react';

import { useOverridablePreference } from './usePreference';
import { tuning } from '../lib/tuning';

/**
 * Adaptive information density for the chrome.
 *
 * `auto` derives density from the viewport; an explicit choice overrides it and
 * persists. Density never touches the terminal font — changing that would
 * change the character grid, and therefore what the server is told over NAWS.
 */
export type DensityPreference = 'auto' | 'comfortable' | 'compact';
export type Density = 'comfortable' | 'compact';

const STORAGE_KEY = 'mudengine.density';
const CYCLE: DensityPreference[] = ['auto', 'comfortable', 'compact'];

function measure(): Density {
  return window.innerHeight < tuning().compactHeight || window.innerWidth < tuning().compactWidth
    ? 'compact'
    : 'comfortable';
}

function isPreference(value: unknown): value is DensityPreference {
  return value === 'auto' || value === 'comfortable' || value === 'compact';
}

/**
 * @param configured The `ui.density` value from the options file. Cycling from
 *   the palette overrides it and is remembered; editing the file overrides the
 *   override. See `useOverridablePreference`.
 */
export function useDensity(configured: DensityPreference = 'auto'): {
  preference: DensityPreference;
  density: Density;
  cycle: () => void;
} {
  const [preference, setPreference] = useOverridablePreference(
    STORAGE_KEY,
    configured,
    isPreference
  );
  const [measured, setMeasured] = useState<Density>(measure);

  useEffect(() => {
    // A ResizeObserver rather than the resize event: React mounts before the
    // Electron window is shown at its final size, and no resize event
    // necessarily follows, which would leave the first measurement stale.
    const observer = new ResizeObserver(() => setMeasured(measure()));
    observer.observe(document.documentElement);
    return () => observer.disconnect();
  }, []);

  const density = preference === 'auto' ? measured : preference;

  useEffect(() => {
    document.documentElement.dataset['density'] = density;
  }, [density]);

  const cycle = useCallback(() => {
    setPreference(CYCLE[(CYCLE.indexOf(preference) + 1) % CYCLE.length] ?? 'auto');
  }, [preference, setPreference]);

  return { preference, density, cycle };
}
