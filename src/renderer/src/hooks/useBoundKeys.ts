/**
 * The keys the player bound to a line (`keys:`, todo 74), MegaMUD's macros:
 * a press sends the line for the character on screen, through main's reading
 * of a Talk-box line, so an alias or a `;` line paces like any macro. The
 * rules for a bare key are `useHotkeys`'s: Numpad 8 walks from the terminal
 * and stands down in a chrome field.
 */
import { useMemo } from 'react';

import { useHotkeys, type Hotkey } from './useHotkeys';
import type { IpcApi, SessionId } from '@shared/ipc';
import { parseChord, type KeyBindings } from '@shared/keys';

export function useBoundKeys(
  api: Pick<IpcApi, 'macro'>,
  shown: { readonly current: SessionId },
  bindings: KeyBindings
): void {
  const hotkeys = useMemo(
    () =>
      Object.entries(bindings).flatMap(([name, line]): Hotkey[] => {
        const chord = parseChord(name);
        if (chord === null) return [];
        const { code, mod, alt, shift } = chord;
        return [{ key: code, code, mod, alt, shift, run: () => api.macro(shown.current, line) }];
      }),
    [api, shown, bindings]
  );
  useHotkeys(hotkeys);
}
