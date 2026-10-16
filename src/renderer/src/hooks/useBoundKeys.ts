/**
 * The keys the player bound to a macro (`keys:`, todo 74), MegaMUD's macros:
 * a press sends the line for the character on screen, through main's reading
 * of a Talk-box line, so an alias or a `;` line paces like any macro. Each
 * character has its own over Global's (todo 134), pushed resolved on its
 * summary. The rules for a bare key are `useHotkeys`'s: Numpad 8 walks from
 * the terminal and stands down in a chrome field.
 */
import { useMemo } from 'react';

import { useHotkeys, type Hotkey } from './useHotkeys';
import type { IpcApi, ProfileSummary, SessionId } from '@shared/ipc';
import { parseChord, type KeyBindings } from '@shared/keys';

export function useBoundKeys(
  api: Pick<IpcApi, 'macro'>,
  shown: { readonly current: SessionId },
  session: SessionId,
  profiles: readonly Pick<ProfileSummary, 'id' | 'keys'>[],
  fallback: KeyBindings
): void {
  const bindings = profiles.find((one) => one.id === session)?.keys ?? fallback;
  const hotkeys = useMemo(
    () =>
      Object.entries(bindings).flatMap(([name, line]): Hotkey[] => {
        const chord = parseChord(name);
        if (chord === null) return [];
        const { code, mod, alt, shift } = chord;
        // Only for the character these bindings are: a press in the frame
        // after a tab switch would send one character's macro to another.
        const run = (): void => {
          if (shown.current === session) api.macro(session, line);
        };
        return [{ key: code, code, mod, alt, shift, run }];
      }),
    [api, shown, session, bindings]
  );
  useHotkeys(hotkeys);
}
