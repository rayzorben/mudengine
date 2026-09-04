/**
 * Platform-aware labels for keyboard shortcuts.
 *
 * The accelerators themselves accept Ctrl or Meta interchangeably; only the
 * label needs to know which machine it is on, so that a Linux user is not told
 * to press a key their keyboard does not have.
 */
const isApple = /mac|iphone|ipad/i.test(navigator.userAgent);

export const MOD = isApple ? '⌘' : 'Ctrl';
export const SHIFT = '⇧';

/** `chord('K')` -> "Ctrl K" or "⌘ K"; `chord('D', true)` inserts Shift. */
export function chord(key: string, shift = false): string {
  return shift ? `${MOD} ${SHIFT} ${key}` : `${MOD} ${key}`;
}
