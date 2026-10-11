/**
 * The connection's keys, for the character on screen: `Ctrl/Cmd Enter` dials
 * or hangs up, and `Alt H` or `Ctrl/Cmd Q` only ever hangs up (todo 04). The
 * second pair is for a panic: pressed twice in a hurry, it never dials back in.
 * All three are chords, so they work with the caret in a chrome field too.
 */
import { useHotkeys } from './useHotkeys';
import { CLIENT_KEYS } from '@shared/keys';

export function useConnectionKeys(toggleConnection: () => void, hangUp: () => void): void {
  useHotkeys([
    { ...CLIENT_KEYS.connection, run: toggleConnection },
    { ...CLIENT_KEYS.hangUp, run: hangUp },
    { ...CLIENT_KEYS.hangUpQuit, run: hangUp }
  ]);
}
