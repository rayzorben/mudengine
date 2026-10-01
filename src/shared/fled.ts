/**
 * The monsters this character ran from for its health, and at what level: a
 * fight is not opened on one again until the character is `fledLevels` past
 * the level it ran at, or `fledForgetMs` has passed. Kept with what the
 * character owns (`Belongings`), per realm, so a restart does not walk it
 * back into the mad wizard it ran from three times.
 *
 * Per level and on a clock, not for ever: running from a kobold at level 1
 * says nothing about level 25, and a loop whose only monster was run from
 * once must not stop earning the levels that would lift it. Dependency-free
 * like everything in `shared/`.
 */
import { mobKey } from './world';

export interface FledEntry {
  /** The monster's name as `mobKey` folds it. */
  name: string;
  /** The character's level when it ran; null where the sheet had not said. */
  level: number | null;
  at: number;
}

/** Whether an entry is still in force at `now`. */
function fresh(entry: FledEntry, now: number, forgetMs: number): boolean {
  return now - entry.at < forgetMs;
}

/**
 * The entries with these monsters run from now, each kept at the highest
 * level it was run from; entries past `forgetMs` are dropped, so the list
 * stays as long as what it still says.
 */
export function withFled(
  entries: readonly FledEntry[],
  names: readonly string[],
  level: number | null,
  at: number,
  forgetMs: number
): FledEntry[] {
  const next = entries.filter((entry) => fresh(entry, at, forgetMs));
  for (const raw of names) {
    const name = mobKey(raw);
    const index = next.findIndex((entry) => entry.name === name);
    const was = index < 0 ? undefined : next[index];
    const kept =
      was?.level === undefined || was.level === null || (level !== null && level >= was.level)
        ? level
        : was.level;
    const entry = { name, level: kept, at };
    if (index < 0) next.push(entry);
    else next[index] = entry;
  }
  return next;
}

/**
 * The entry that keeps this character off a monster at `level`, or null. An
 * unknown level on either side keeps it off for as long as the clock does.
 */
export function avoided(
  entries: readonly FledEntry[],
  name: string,
  level: number | null,
  limits: { band: number; forgetMs: number; now: number }
): FledEntry | null {
  if (limits.band <= 0) return null;
  const key = mobKey(name);
  const entry = entries.find((each) => each.name === key);
  if (entry === undefined || !fresh(entry, limits.now, limits.forgetMs)) return null;
  if (entry.level === null || level === null) return entry;
  return level < entry.level + limits.band ? entry : null;
}

/** Whether a value read back from disk is a list of entries. */
export function isFledList(value: unknown): value is FledEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as FledEntry).name === 'string' &&
        typeof (entry as FledEntry).at === 'number' &&
        ((entry as FledEntry).level === null || typeof (entry as FledEntry).level === 'number')
    )
  );
}
