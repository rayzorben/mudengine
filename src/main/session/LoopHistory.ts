import { latestFirst, newestFirst } from '../../shared/recent';
import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { DeferredFile } from '../world/DeferredFile';
import { readJsonRecord } from '../world/readJsonRecord';

/**
 * The loops one character started by name, newest first, for the console's
 * right-click menu (todo 28). Per character, because loop names are: a profile
 * overlay replaces `automation.loops`, so one character's `Darkwood` is not
 * another's. Kept in `recent-loops/<id>.json` (`CHARACTER_RECORDS`), so it
 * travels with an exported character. A loop no longer in the character's
 * options stays in the file and is left out when read, since an edit can put
 * it back. An unreadable file is said once and never written over.
 */
export interface RecentLoop {
  name: string;
  at: number;
}

const VERSION = 1;

export class LoopHistory {
  private loops: RecentLoop[] = [];
  /** True once the file was found unreadable; nothing is written over it. */
  private suspended = false;
  private readonly disk: DeferredFile;

  constructor(
    private readonly file: string,
    private readonly notify: (message: string) => void
  ) {
    this.disk = new DeferredFile(
      file,
      () => ({ v: VERSION, loops: this.loops }),
      (error) =>
        notify(t('notices.session.recentLoops.writeError', { file, message: errorMessage(error) }))
    );
    this.load();
  }

  /** A loop the player started by name. */
  remember(name: string, at = Date.now()): void {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    this.loops = latestFirst(
      this.loops,
      { name: trimmed, at },
      (other) => other.name === trimmed
    ).slice(0, tuning().records.recentLoopsKept);
    if (!this.suspended) this.disk.schedule();
  }

  /** The newest `limit` names the character still has a loop for. */
  latest(known: (name: string) => boolean, limit: number): string[] {
    return this.loops
      .filter((loop) => known(loop.name))
      .slice(0, Math.max(0, limit))
      .map((loop) => loop.name);
  }

  /** Writes anything outstanding. Called on quit. */
  close(): void {
    if (!this.suspended) this.disk.close();
  }

  private load(): void {
    const read = readJsonRecord(this.file);
    // No file yet is the first loop this character has started.
    if (read.kind === 'absent') return;
    if (read.kind === 'unreadable') {
      this.refuse(read.error);
      return;
    }
    const parsed = read.value;
    const rows =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['loops']
        : null;
    if (!Array.isArray(rows)) {
      this.refuse(new Error(t('notices.session.recentLoops.notAList')));
      return;
    }
    // A row this build cannot read, its time included, is skipped, never the file.
    this.loops = rows
      .flatMap((row): RecentLoop[] => {
        if (typeof row !== 'object' || row === null) return [];
        const { name, at } = row as Record<string, unknown>;
        if (typeof name !== 'string' || name.trim().length === 0) return [];
        if (typeof at !== 'number' || !Number.isFinite(at)) return [];
        return [{ name: name.trim(), at }];
      })
      .sort(newestFirst);
  }

  private refuse(error: unknown): void {
    this.suspended = true;
    this.notify(
      t('notices.session.recentLoops.readError', { file: this.file, message: errorMessage(error) })
    );
  }
}
