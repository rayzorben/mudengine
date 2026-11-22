/**
 * The height of what is visible above a touch keyboard, and whether one is up.
 *
 * Chrome on Android shrinks the visual viewport and leaves the layout viewport
 * at full height, so a fixed-height shell would slide under the keys. The
 * shell takes this height instead, which keeps the command field on the keys
 * at whatever size the keyboard is.
 */
import { useSyncExternalStore } from 'react';

/**
 * Under this share of the window's height, something is covering the bottom of it. Gboard in
 * portrait is about 270 dp on a screen of about 800 dp, a third, so a keyboard leaves about 0.66;
 * 0.75 sits between that and a bare address bar, which takes a few percent.
 */
const KEYBOARD_SHARE = 0.75;

function subscribe(notify: () => void): () => void {
  const viewport = window.visualViewport;
  viewport?.addEventListener('resize', notify);
  window.addEventListener('resize', notify);
  return () => {
    viewport?.removeEventListener('resize', notify);
    window.removeEventListener('resize', notify);
  };
}

const height = (): number => Math.round(window.visualViewport?.height ?? window.innerHeight);

export interface KeyboardView {
  /** Pixels visible. */
  height: number;
  up: boolean;
}

export function useKeyboardHeight(): KeyboardView {
  const visible = useSyncExternalStore(subscribe, height);
  return { height: visible, up: visible < window.innerHeight * KEYBOARD_SHARE };
}
