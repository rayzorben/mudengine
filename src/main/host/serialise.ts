/**
 * What a host sends a window, as JSON text, or null with the reason said: a
 * value JSON cannot carry (a cycle, a BigInt) is a defect in what sent it, and
 * one worth naming, since the window would otherwise wait for something that
 * never comes. Both hosts send text (`PUSH_METHODS`, the web's socket).
 */
import { errorMessage } from '../../shared/values';

export function serialise(
  value: unknown,
  what: string
): { text: string; error: null } | { text: null; error: string } {
  try {
    return { text: JSON.stringify(value ?? null), error: null };
  } catch (error) {
    console.error(`could not serialise ${what}: ${errorMessage(error)}`);
    return { text: null, error: errorMessage(error) };
  }
}
