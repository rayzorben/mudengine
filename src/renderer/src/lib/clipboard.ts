/**
 * What the terminal does about copy and paste.
 *
 * The decision — "is this keystroke a copy?" — is separated from the doing so
 * it can be tested without a terminal, a window or a clipboard. It is the part
 * with the edge cases in it: `Ctrl C` means two different things depending on
 * whether anything is selected, and getting that wrong either steals the
 * interrupt the server is owed or silently fails to copy.
 */

/** The keyboard event's fields, and nothing that needs a DOM to produce. */
export interface ClipboardKey {
  type: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export type ClipboardIntent = 'copy' | 'paste' | null;

/**
 * Whether a keystroke in the terminal is a clipboard action.
 *
 * Null means it is not, and the terminal must go on to handle the key itself —
 * which for `Ctrl C` with nothing selected means sending the interrupt the
 * server expects. **That is the whole reason the selection is a parameter.** A
 * client that swallowed `Ctrl C` unconditionally would take away a control
 * character the realm defines, in exchange for copying nothing.
 *
 * Ctrl and Meta are interchangeable, as everywhere else in this client: a
 * shortcut table per platform is a second thing to keep in step, and no realm
 * command is reachable by either.
 *
 * `Ctrl Shift C` and the `Insert` pair are here because they are what a
 * terminal user's hands already do — `Shift Insert` is the X11 paste that
 * predates every menu — and each costs one line to honour.
 */
export function clipboardIntent(event: ClipboardKey, hasSelection: boolean): ClipboardIntent {
  // Only the press. The handler is called for keyup and keypress too, and
  // acting on all three would copy three times.
  if (event.type !== 'keydown') return null;
  // Alt is a modifier the game itself may be given; a chord that carries it is
  // not one of ours, even if the rest of it matches.
  if (event.altKey) return null;

  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  if (mod && key === 'c') return hasSelection ? 'copy' : null;
  if (mod && key === 'v') return 'paste';
  if (mod && key === 'insert') return hasSelection ? 'copy' : null;
  if (event.shiftKey && key === 'insert') return 'paste';
  return null;
}

/**
 * Copy through main.
 *
 * Empty selections never get here — `clipboardIntent` refuses `Ctrl C` without
 * one — but the menu's Copy is reachable by mouse from a terminal whose
 * selection has been cleared in between, so the guard is kept on this side too
 * rather than relying on main's.
 */
export async function writeClipboard(text: string): Promise<void> {
  if (text.length === 0) return;
  await window.mudengine.copyText(text);
}

/** What is on the clipboard, or nothing if it holds no text. */
export async function readClipboard(): Promise<string> {
  return await window.mudengine.pasteText();
}
