import { useEffect, useRef } from 'react';

/**
 * Window-level keyboard accelerators for the chrome.
 *
 * Listening in the capture phase is what makes these work while the terminal
 * has focus, which it almost always does. The allowlist is deliberately narrow:
 * an unrecognised chord is never swallowed, so anything the game might want
 * still reaches xterm.
 *
 * **A bare key belongs to whatever holds the caret.** Capture plus
 * `stopPropagation` means a window hotkey reaches the event first and the
 * surface never sees it at all — so while the diagnostics rail was open, Escape
 * was eaten by the rail toggle and the Talk card's reply box could not be
 * escaped from. The caret stayed in it, and a held caret is a swallowed
 * keystroke.
 *
 * Chorded hotkeys are unaffected: `Ctrl/Cmd K` has to work from anywhere, and
 * no text field wants it. It is the unmodified keys — Escape above all — that
 * belong to whatever holds the caret. The terminal is excluded from the rule
 * because it *is* the game: a bare Escape there is for the server, and the
 * hotkeys that fire over it are the reason this listens in capture.
 */

/**
 * True when something in the chrome has deliberately taken the caret.
 *
 * Text fields, and anything that says so with `data-owns-keys`.
 *
 * The attribute exists because the tag list is not the rule — it was only ever
 * a stand-in for it. When this was written the one chrome surface that held the
 * caret was a text field; a tab's menu is a second, made of buttons, and it was
 * eaten by exactly the hotkey this rule was added to protect against. Marking
 * the surface fixes the class rather than adding a second tag to a list that
 * will need a third.
 */
function chromeOwnsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('.terminal-cell')) return false;
  return (
    target.closest('[data-owns-keys]') !== null ||
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  );
}
export interface Hotkey {
  /** `event.key`, compared case-insensitively. */
  key: string;
  /** Require Ctrl on Windows/Linux or Meta on macOS. */
  mod?: boolean;
  shift?: boolean;
  run: () => void;
}

function matches(event: KeyboardEvent, hotkey: Hotkey): boolean {
  if (event.key.toLowerCase() !== hotkey.key.toLowerCase()) return false;
  const mod = event.ctrlKey || event.metaKey;
  if ((hotkey.mod ?? false) !== mod) return false;
  return (hotkey.shift ?? false) === event.shiftKey;
}

export function useHotkeys(hotkeys: Hotkey[]): void {
  // Read through a ref so callers can pass a fresh array each render without
  // detaching and reattaching the listener.
  const ref = useRef(hotkeys);
  ref.current = hotkeys;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const hit = ref.current.find((hotkey) => matches(event, hotkey));
      if (!hit) return;
      // An unmodified key belongs to whatever holds the caret.
      if (!(hit.mod ?? false) && chromeOwnsKeys(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      hit.run();
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);
}
