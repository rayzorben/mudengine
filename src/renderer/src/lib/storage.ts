/**
 * The window's `localStorage`, read and written inside a guard: private mode,
 * storage disabled and a value written by an older build are expected, and
 * each is answered with the fallback, never a throw. `session` is the tab's
 * own `sessionStorage`, which a reload and a discarded browser tab keep and
 * another tab never sees.
 */

export type StorageArea = 'local' | 'session';

const areaOf = (area: StorageArea): Storage =>
  area === 'session' ? window.sessionStorage : window.localStorage;

/**
 * Read what the store holds for a key, or fall back. `parse` runs inside the
 * guard on purpose: a stored value written by an older build is as much an
 * expected failure as private mode or storage disabled.
 */
export function readStored<T>(
  key: string,
  parse: (stored: string) => T,
  fallback: () => T,
  area: StorageArea = 'local'
): T {
  try {
    const stored = areaOf(area).getItem(key);
    return stored === null ? fallback() : parse(stored);
  } catch {
    // Private mode, storage disabled, or a value written by an older build.
    return fallback();
  }
}

export function writeStored(key: string, value: string, area: StorageArea = 'local'): void {
  try {
    areaOf(area).setItem(key, value);
  } catch {
    // Refused: the value applies for as long as the window is open.
  }
}

export function forgetStored(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Refused: the value stays until storage takes writes again.
  }
}
