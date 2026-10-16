/**
 * A start the player asked for, with a switch written on first (todo 03's
 * master switch, todo 148's Auto-Rest): written back off where the start is
 * refused or throws, so a refused start leaves the switch as it was. What to
 * say, and what a refused write means, is the caller's.
 */
export type SwitchedOn = { written: false } | { written: true; answer: string | null };

/** `write(true)`, then `start`, its answer or null; `write(false)` again on a refusal or a throw. */
export function switchedOn(
  write: (on: boolean) => boolean,
  start: () => string | null
): SwitchedOn {
  if (!write(true)) return { written: false };
  let answer: string | null;
  try {
    answer = start();
  } catch (error) {
    write(false);
    throw error;
  }
  if (answer !== null) write(false);
  return { written: true, answer };
}
