/**
 * Turning a name somebody wrote into a name a filesystem will keep.
 *
 * Three things the client owns are addressed by a name a person chose and
 * stored in a file or a directory named after it: a server, a loop, and a
 * character. The name inside the file stays exactly what was written — that is
 * what the player reads and what everything else addresses it by — and this is
 * only how the file is *found*.
 *
 * - **Lower case, ASCII, hyphens.** Windows and macOS do not distinguish case,
 *   so `Sewer Loop` and `sewer loop` must not be able to produce two files that
 *   are one file on half the platforms anybody runs.
 * - **Never empty.** A name made entirely of punctuation is a real thing to
 *   call something and a terrible thing to open a file with.
 * - **Never a silent overwrite.** `taken` is what the directory already holds,
 *   and a collision gets a number rather than replacing somebody else's file:
 *   two names that differ only in punctuation are two things.
 *
 * Dependency-free, like the rest of `src/shared`.
 */

/** Longest a generated name may be, so a path stays inside a filesystem's limit. */
const MAX = 64;

export function fileSlug(name: string, taken: ReadonlySet<string> = new Set()): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX) || 'unnamed';

  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
