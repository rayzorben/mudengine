import fs from 'node:fs';

import type { SessionId } from '../../shared/ipc';
import { t } from '../app/i18n';
import { writeWholeSync } from '../app/writeWhole';

/**
 * The characters whose tab the player closed, kept across restarts.
 *
 * A profile file says a character exists; a tab says they are playing it now.
 * Held only in memory, a closed tab came back at the next launch because every
 * profile file is loaded at startup. Its own file beside `workspace.json`: that
 * one records where a tab sits, this one whether it is there.
 *
 * Nothing here is read until `open`, since the file's home exists only once
 * the client has built its paths. A file that is missing or does not parse
 * means nothing is closed, the safe reading: every character shows.
 */
export class ClosedTabs {
  private readonly ids = new Set<SessionId>();
  private file: string | null = null;

  constructor(private readonly onError: (message: string) => void = () => undefined) {}

  /** Reads the remembered set from `file`, and writes there from now on. */
  open(file: string): void {
    this.file = file;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      const closed = (parsed as { closed?: unknown } | null)?.closed;
      if (!Array.isArray(closed)) return;
      for (const id of closed) if (typeof id === 'string') this.ids.add(id);
    } catch (error) {
      // A first run has no file; anything else is said and read as nothing closed.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.onError(t('app.profiles.closedTabsUnreadable', { message: (error as Error).message }));
      }
    }
  }

  has(id: SessionId): boolean {
    return this.ids.has(id);
  }

  add(id: SessionId): void {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    this.save();
  }

  delete(id: SessionId): void {
    if (this.ids.delete(id)) this.save();
  }

  /** Everything closed, for a caller that reconciles against the characters that exist. */
  all(): SessionId[] {
    return [...this.ids];
  }

  private save(): void {
    if (this.file === null) return;
    try {
      writeWholeSync(
        this.file,
        `${JSON.stringify({ v: 1, closed: [...this.ids].sort() }, null, 2)}\n`
      );
    } catch (error) {
      this.onError(t('app.profiles.closedTabsNotSaved', { message: (error as Error).message }));
    }
  }
}
