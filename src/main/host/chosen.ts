/**
 * Which file a window may have main read after naming it as picked
 * (`Host.chosenPath`): the card layout Load and the character Import read a
 * path the window sends back, so without this a tab could name any file on
 * the machine and learn whether it exists and whether it parses.
 *
 * The desktop accepts the path its own dialog last gave that window. A
 * browser tab picks over `browseHome`, a listing of the home, so it is
 * accepted only for a file under the home, by real path. Reasoning in
 * `mudengine-session` › `parts/hosts.md`.
 */
import { resolveWithin } from '../app/browse';

/** The last path each window's own file dialog returned. */
export class PickedFiles {
  private readonly last = new Map<number, string>();

  /** Remember what a dialog answered a window, and hand it on. */
  remember(windowId: number, file: string | null): string | null {
    if (file === null) this.last.delete(windowId);
    else this.last.set(windowId, file);
    return file;
  }

  /** The file, when it is the one this window's dialog last returned. */
  chosen(windowId: number, file: string): string | null {
    return this.last.get(windowId) === file ? file : null;
  }

  /** A closed window picks nothing more. */
  forget(windowId: number): void {
    this.last.delete(windowId);
  }
}

/**
 * The real path of a file under the home, or null when it resolves outside.
 * A path that cannot be resolved inside the home throws the filesystem's
 * error, which the reader reports with where and why.
 */
export async function fileUnderHome(root: string, file: string): Promise<string | null> {
  const resolved = await resolveWithin(root, file);
  switch (resolved.kind) {
    case 'within':
      return resolved.real;
    case 'outside':
      return null;
    case 'unreadable':
      throw resolved.error instanceof Error ? resolved.error : new Error(String(resolved.error));
    default: {
      const never: never = resolved;
      return never;
    }
  }
}
