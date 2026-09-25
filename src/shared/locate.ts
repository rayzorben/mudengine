/**
 * The realm's word for "where am I standing" (todo 811): a closed list,
 * stated per realm (`server.yaml` `locate:`) and overridable per character
 * (`profile.yaml` `locate:`), resolved in `resolveProfile` the way the login
 * script is. `none` is a realm that has no such word, where the client asks
 * nothing. The fork's `sys-status` is held: its only source is a sysop's
 * tool. See `mudengine-config` › *A realm's own word for where am I*.
 *
 * Dependency-free, like the rest of `src/shared`.
 */

export const LOCATE_WORDS = ['rm', 'none'] as const;
export type LocateWord = (typeof LOCATE_WORDS)[number];

/** What a realm that states nothing uses: `rm`, what every realm was asked before. */
export const DEFAULT_LOCATE: LocateWord = 'rm';

/** A locate word off disk or off the wire, or null for anything this client does not know. */
export function asLocateWord(value: unknown): LocateWord | null {
  return typeof value === 'string' && (LOCATE_WORDS as readonly string[]).includes(value)
    ? (value as LocateWord)
    : null;
}

/** The command a locate word sends, or null where the realm has none. */
export function locateCommand(word: LocateWord): string | null {
  switch (word) {
    case 'rm':
      return 'rm';
    case 'none':
      return null;
    default: {
      const unreachable: never = word;
      return unreachable;
    }
  }
}
