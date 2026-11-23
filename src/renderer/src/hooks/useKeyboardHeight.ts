/**
 * The height of what is visible above a touch keyboard, and whether one is up.
 *
 * Chrome on Android shrinks the visual viewport and leaves the layout viewport
 * at full height, so a fixed-height shell would slide under the keys. The
 * shell takes this height instead, which keeps the command field on the keys
 * at whatever size the keyboard is.
 *
 * A keyboard is up only while a text field has focus and the visible height
 * has fallen well under what it was with none focused. Comparing against the
 * window's own height reported a keyboard on the user's phone (2026-11-23) with
 * none showing, and hid the tab bar; the figures there were not captured.
 */
import { useEffect, useRef, useState } from 'react';

import { takesText, targetOf } from '../lib/history';
import { keyboardUp } from '../lib/phone';

export interface KeyboardView {
  /** Pixels visible. */
  height: number;
  up: boolean;
}

const visibleHeight = (): number => Math.round(window.visualViewport?.height ?? window.innerHeight);

const typing = (): boolean => takesText(targetOf(document.activeElement));

export function useKeyboardHeight(): KeyboardView {
  const [view, setView] = useState<KeyboardView>(() => ({ height: visibleHeight(), up: false }));
  /** The visible height the last time no field had focus: the page's with the browser bars showing and no keyboard. */
  const resting = useRef(visibleHeight());
  /** The width it was taken at: a turned phone is a different page, whatever its keys are doing. */
  const width = useRef(window.innerWidth);
  useEffect(() => {
    const update = () => {
      const height = visibleHeight();
      const focused = typing();
      if (window.innerWidth !== width.current) {
        width.current = window.innerWidth;
        resting.current = window.innerHeight;
      }
      if (!focused) resting.current = height;
      const up = keyboardUp(height, resting.current, focused);
      setView((was) => (was.height === height && was.up === up ? was : { height, up }));
    };
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', update);
    window.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    update();
    return () => {
      viewport?.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('focusin', update);
    };
  }, []);
  return view;
}
