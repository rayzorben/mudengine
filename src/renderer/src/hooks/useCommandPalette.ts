/**
 * Whether the command palette is open, and closing it, which hands the caret
 * back unless the command that closed it is taking the caret itself.
 *
 * Out of `App` (todo 732) with the state it owns; the list it shows is
 * `lib/palette.ts`. See `mudengine-ui` › *Focus lives in the terminal*.
 */
import { useCallback, useState } from 'react';

export interface CommandPaletteState {
  open: boolean;
  /** Stable, because the status rail is memoised and an arrow re-drew it per commit. */
  openPalette(): void;
  /**
   * @param movesFocus Set by a command that is taking focus somewhere itself;
   *   every other route out of the palette hands it back to the terminal.
   */
  close(movesFocus?: boolean): void;
  toggle(): void;
}

/** @param returnFocus The window's one hand-back. */
export function useCommandPalette(returnFocus: () => void): CommandPaletteState {
  const [open, setOpen] = useState(false);

  const openPalette = useCallback(() => setOpen(true), []);

  const close = useCallback(
    (movesFocus = false) => {
      setOpen(false);
      if (!movesFocus) returnFocus();
    },
    [returnFocus]
  );

  const toggle = useCallback(() => {
    if (open) close();
    else setOpen(true);
  }, [open, close]);

  return { open, openPalette, close, toggle };
}
