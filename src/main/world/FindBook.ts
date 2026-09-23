import fs from 'node:fs';
import path from 'node:path';

import { findKey, FINDS_VERSION, type Find, type Sighting } from '../../shared/finds';
import type { RoomId } from '../../shared/world';
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
  /** Bare searches counted per room, whatever they turned up. See `Find.searched`. */
  searches: Record<RoomId, number>;
  /**
   * Read as `unknown[]` and checked a row at a time, because the envelope
   * deliberately does not vouch for the rows. See `load`.
   */
  finds: unknown[];
}

/** A row as it is kept: its room's count lives once, in `searches`. */
type Kept = Omit<Find, 'searched'>;

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
  private finds: Kept[] = [];
  private readonly index = new Map<string, Kept>();
  private readonly searches = new Map<RoomId, number>();
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

  /** Everything found, oldest first, each with its room's count. The card sorts. */
  get all(): readonly Find[] {
    return this.finds.map((row) => this.joined(row));
  }

  /**
   * Counts one bare search of a room and writes down what it turned up —
   * nothing, for `Your search revealed nothing.`, which is a search all the
   * same and the one a rate most needs.
   *
   * One call, so a hit can never be written without the search it was part of
   * and no row's `hits` can pass its room's count. Returns the rows this search
   * was the **first** to turn up, so a caller can say so once rather than on
   * every lap; a repeat still moves `at`, `seen` and `hits`.
   */
  search(room: RoomId, found: readonly Sighting[]): Find[] {
    this.searches.set(room, (this.searches.get(room) ?? 0) + 1);
    const fresh: Kept[] = [];
    const counted = new Set<string>();

    for (const sighting of found) {
      const key = findKey({ room, name: sighting.name });
      // One search is one hit however many of its names fold together, or a
      // room could report a thing turning up more often than it was searched.
      if (counted.has(key)) continue;
      counted.add(key);

      const known = this.index.get(key);
      if (known !== undefined) {
        known.at = sighting.at;
        known.seen += 1;
        known.hits += 1;
        // The quantity is this search's, not the first one's: four farthings
        // today and none tomorrow is a room that had four farthings today.
        known.quantity = sighting.quantity;
        known.copper = sighting.copper;
        continue;
      }

      const row: Kept = { ...sighting, room, seen: 1, hits: 1 };
      this.index.set(key, row);
      this.finds.push(row);
      fresh.push(row);
      /*
       * The oldest goes, as in `WorldMemory`: a character that has played for
       * months has searched the rooms it plays in, and the cap guards against a
       * pathological stream rather than against ordinary use — in which case
       * the recent rows are the ones still true. The room counts stay, bounded
       * by the realm's rooms, and a dropped row found again is fresh.
       */
      if (this.finds.length > tuning().records.findLimit) {
        const dropped = this.finds.shift();
        if (dropped) this.index.delete(findKey(dropped));
      }
    }
    this.schedule();
    return fresh.map((row) => this.joined(row));
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
      const read: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const upgraded = fromVersion1(read);
      const parsed = upgraded ?? read;
      if (!isFindsFile(parsed)) {
        this.onError?.(
          t('notices.world.finds.invalidFile', { fileName: path.basename(this.file) })
        );
        return;
      }
      if (parsed.realm !== this.realm) return;
      const searches = new Map(Object.entries(parsed.searches));

      /*
       * A malformed row refuses the file and a *missing* one is skipped — the
       * two halves `WorldMemory.load` records at length. There is no
       * `isUnnamedReason` equivalent yet because `Find` has no closed union in
       * it; when one is added, this is where its skip goes, and the whole-file
       * refusal must not be widened to cover it.
       */
      const rows: Kept[] = [];
      for (const find of parsed.finds) {
        // More hits than its room was searched is a count that cannot be true.
        if (!isKept(find) || find.hits > (searches.get(find.room) ?? 0)) {
          this.onError?.(
            t('notices.world.finds.invalidFile', { fileName: path.basename(this.file) })
          );
          return;
        }
        rows.push(find);
      }

      for (const [room, count] of searches) this.searches.set(room, count);
      for (const find of rows) {
        const key = findKey(find);
        if (this.index.has(key)) continue;
        this.index.set(key, find);
        this.finds.push(find);
      }

      if (upgraded !== null) {
        fs.copyFileSync(this.file, `${this.file}.bak`);
        this.onError?.(t('notices.world.finds.upgraded', { fileName: path.basename(this.file) }));
        this.schedule();
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

  private joined(row: Kept): Find {
    return { ...row, searched: this.searches.get(row.room) ?? 0 };
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
    const payload: FindsFile = {
      version: FINDS_VERSION,
      realm: this.realm,
      searches: Object.fromEntries(this.searches),
      finds: this.finds
    };
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

/**
 * A version 1 log as version 2, or null for anything else (2026-09-18).
 *
 * Version 1 counted no searches, so every room starts at none and every row at
 * no hits: no rate until its room is searched again, never a guessed one. Done
 * here rather than once by hand because the file is written while the player
 * plays, and a version 1 file refused is overwritten by the next find. Goes
 * when no version 1 file remains.
 */
function fromVersion1(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return null;
  const file = value as { version?: unknown; finds?: unknown };
  if (file.version !== 1 || !Array.isArray(file.finds)) return null;
  return {
    ...file,
    version: FINDS_VERSION,
    searches: {},
    finds: file.finds.map((row: unknown) =>
      typeof row === 'object' && row !== null ? { ...row, hits: 0 } : row
    )
  };
}

/** Parsed, not trusted — the envelope only. See `WorldMemory`'s own note. */
function isFindsFile(value: unknown): value is FindsFile {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Partial<FindsFile>;
  if (file.version !== FINDS_VERSION || typeof file.realm !== 'string') return false;
  if (!isCounts(file.searches)) return false;
  return Array.isArray(file.finds);
}

function isCounts(value: unknown): value is Record<RoomId, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((count) => Number.isInteger(count) && count > 0);
}

function isKept(value: unknown): value is Kept {
  if (typeof value !== 'object' || value === null) return false;
  const find = value as Partial<Kept>;
  return (
    typeof find.room === 'string' &&
    typeof find.roomName === 'string' &&
    typeof find.name === 'string' &&
    (find.quantity === null || typeof find.quantity === 'number') &&
    (find.copper === null || typeof find.copper === 'number') &&
    typeof find.at === 'number' &&
    typeof find.seen === 'number' &&
    typeof find.hits === 'number' &&
    Number.isInteger(find.hits) &&
    find.hits >= 0
  );
}
