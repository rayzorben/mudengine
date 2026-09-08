import fs from 'node:fs';
import path from 'node:path';

import { findKey, FINDS_VERSION, type Find } from '../../shared/finds';
import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';

interface FindsFile {
  version: typeof FINDS_VERSION;
  /**
   * The realm these were found in.
   *
   * The same rule `WorldMemory` states: a realm that changes its `database` is
   * a different map and its room numbers do not mean the same places, so a file
   * stamped with another realm is kept and ignored rather than deleted.
   */
  realm: string;
  /**
   * Read as `unknown[]` and checked a row at a time, because the envelope
   * deliberately does not vouch for the rows. See `load`.
   */
  finds: unknown[];
}

/**
 * What searching has turned up in one realm, on disk.
 *
 * **One file per realm, not per character**, which is the whole reason this is
 * here rather than in `WorldMemory`: that a room hides a rusty key is a fact
 * about the world, like a shop's stock (`SplitMemory`), and a second character
 * re-learning it spends a search to be told what the first already knew.
 *
 * Otherwise it is `WorldMemory`'s shape deliberately, down to the failure
 * handling, because that shape is the one this project has already paid for:
 * deferred atomic write (temp file and rename), a whole-file refusal for a
 * damaged **envelope**, and a *row*-level skip for a row this build cannot
 * name. The second half is the `unknown-stock` lesson — one unreadable row
 * must never cost the file — and it applies here identically the first time a
 * field is added to `Find`.
 *
 * The one difference from `WorldMemory.learn` is what a repeat means. An
 * observation there is a *discovery* and its `at` never moves; a find is a
 * **recurrence**, and a room searched every lap is one row whose `at` moves and
 * whose `seen` climbs. That is what makes "newest first" and "this room is
 * worth searching" legible.
 */
export class FindBook {
  private finds: Find[] = [];
  private readonly index = new Map<string, Find>();
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  /**
   * @param file Where this realm's log lives.
   * @param realm What realm it is being kept against, as `RealmLoad.source`.
   * @param onError Reported rather than thrown: a log that cannot be read must
   *   not stop a character connecting, and it is worth saying out loud because
   *   the alternative is a client that silently forgets.
   */
  constructor(
    private readonly file: string,
    private readonly realm: string,
    private readonly onError?: (message: string) => void
  ) {
    this.load();
  }

  /** Everything found, oldest first. The card sorts; this preserves arrival. */
  get all(): readonly Find[] {
    return this.finds;
  }

  /**
   * Writes down one find, or moves the one already there.
   *
   * Returns the row when this search is the **first** to turn the thing up in
   * that room, so a caller can say so once rather than on every lap. A repeat
   * returns null and still moves `at` and `seen`: the record changed, the news
   * did not.
   */
  record(find: Omit<Find, 'seen'>): Find | null {
    const key = findKey(find);
    const known = this.index.get(key);
    if (known !== undefined) {
      known.at = find.at;
      known.seen += 1;
      // The quantity is this search's, not the first one's: four farthings
      // today and none tomorrow is a room that had four farthings today.
      known.quantity = find.quantity;
      known.copper = find.copper;
      this.schedule();
      return null;
    }

    const row: Find = { ...find, seen: 1 };
    this.index.set(key, row);
    this.finds.push(row);
    /*
     * The oldest goes, as in `WorldMemory`: a character that has played for
     * months has searched the rooms it plays in, and the cap guards against a
     * pathological stream rather than against ordinary use — in which case the
     * recent rows are the ones still true.
     */
    if (this.finds.length > tuning().records.findLimit) {
      const dropped = this.finds.shift();
      if (dropped) this.index.delete(findKey(dropped));
    }
    this.schedule();
    return row;
  }

  /**
   * Strikes one row out, because the person looking at it says it is wrong.
   *
   * The one edit this record accepts, and the same one `WorldMemory.forget`
   * accepts for the same reason: struck rather than hidden, so the next search
   * that turns the thing up writes it down again.
   */
  forget(key: string): boolean {
    const known = this.index.get(key);
    if (known === undefined) return false;
    this.index.delete(key);
    this.finds = this.finds.filter((find) => findKey(find) !== key);
    this.schedule();
    return true;
  }

  /** Writes anything outstanding and stops the timer. Safe to call twice. */
  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.dirty) this.write();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!isFindsFile(parsed)) {
        this.onError?.(
          t('notices.world.finds.invalidFile', { fileName: path.basename(this.file) })
        );
        return;
      }
      if (parsed.realm !== this.realm) return;

      /*
       * A malformed row refuses the file and a *missing* one is skipped — the
       * two halves `WorldMemory.load` records at length. There is no
       * `isUnnamedReason` equivalent yet because `Find` has no closed union in
       * it; when one is added, this is where its skip goes, and the whole-file
       * refusal must not be widened to cover it.
       */
      const rows: Find[] = [];
      for (const find of parsed.finds) {
        if (!isFind(find)) {
          this.onError?.(
            t('notices.world.finds.invalidFile', { fileName: path.basename(this.file) })
          );
          return;
        }
        rows.push(find);
      }

      for (const find of rows) {
        const key = findKey(find);
        if (this.index.has(key)) continue;
        this.index.set(key, find);
        this.finds.push(find);
      }
    } catch (error) {
      // Kept, not deleted: it is the only record of what this realm hides, and
      // a parse failure is not permission to throw it away.
      this.onError?.(
        t('notices.world.finds.readError', {
          fileName: path.basename(this.file),
          message: errorMessage(error)
        })
      );
    }
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, tuning().records.memoryWriteDelayMs);
    // Nothing here holds the app open; `close()` is what guarantees a landing.
    this.timer.unref?.();
  }

  private write(): void {
    const payload: FindsFile = { version: FINDS_VERSION, realm: this.realm, finds: this.finds };
    const temporary = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.renameSync(temporary, this.file);
      this.dirty = false;
    } catch (error) {
      this.onError?.(
        t('notices.world.finds.saveError', {
          fileName: path.basename(this.file),
          message: errorMessage(error)
        })
      );
      // Left dirty on purpose, so the next find tries again rather than the
      // failure quietly becoming permanent.
      fs.rmSync(temporary, { force: true });
    }
  }
}

/** Parsed, not trusted — the envelope only. See `WorldMemory`'s own note. */
function isFindsFile(value: unknown): value is FindsFile {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Partial<FindsFile>;
  if (file.version !== FINDS_VERSION || typeof file.realm !== 'string') return false;
  return Array.isArray(file.finds);
}

function isFind(value: unknown): value is Find {
  if (typeof value !== 'object' || value === null) return false;
  const find = value as Partial<Find>;
  return (
    typeof find.room === 'string' &&
    typeof find.roomName === 'string' &&
    typeof find.name === 'string' &&
    (find.quantity === null || typeof find.quantity === 'number') &&
    (find.copper === null || typeof find.copper === 'number') &&
    typeof find.at === 'number' &&
    typeof find.seen === 'number'
  );
}
