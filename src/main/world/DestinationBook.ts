import fs from 'node:fs';
import path from 'node:path';

import { matchVisits, rememberVisit, type VisitedDestination } from '../../shared/destinations';
import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { realmKey } from './RealmLore';

/**
 * Where characters on this machine have walked, per realm.
 *
 * The reason it exists is in `src/shared/destinations.ts`: the realm's own room
 * search is a capped substring match over 55,806 rooms in build order, so a
 * query like `forest` answers with places nobody has been while the one place
 * they *have* been sits below the cap and is never shown at all.
 *
 * **Keyed by realm, not by character**, like `RealmLore` and `PlayerBook` and
 * for the same reason: a bank is in the same room whoever walks to it. It
 * shares `realmKey` with the lore rather than defining a second one — two keying
 * rules that drifted would file one realm's rooms under two names, and the
 * symptom would be a list that silently forgot everything on a rename.
 *
 * **Writes are lazy and never block a walk.** `remember` is called at the
 * moment a route starts, which is the one moment this process has something
 * better to do than touch a disk — the same rule `WorldMemory` keeps.
 */
export interface DestinationBookOptions {
  /** Where the file lives. Created on demand. */
  file: string;
  /** How long to wait before writing after a change. */
  saveDelayMs?: number;
  /** Reported when the file cannot be read or written. Never silent. */
  notify?(message: string): void;
}

interface DestinationFile {
  v: number;
  /** Keyed by realm identity, so one file serves every realm played. */
  realms: Record<string, VisitedDestination[]>;
}

/**
 * The view one realm sees.
 *
 * Narrow, for the reason `RealmLore.forRealm` is narrow: a session holds one of
 * these and must not be able to name a *realm*, which is the door through which
 * one realm's rooms would reach another's search.
 */
export interface RealmDestinations {
  /** Note that a walk has been started toward this room. */
  remember(room: { id: string; name: string }): void;
  /** The recent destinations matching a query, newest first. */
  matching(query: string, limit: number): VisitedDestination[];
}

export class DestinationBook {
  private readonly visited = new Map<string, VisitedDestination[]>();
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private loaded = false;
  /** True once the file was found unparseable; nothing is written over it. */
  private suspended = false;

  constructor(private readonly options: DestinationBookOptions) {}

  forRealm(realm: string): RealmDestinations {
    const key = realmKey(realm);
    return {
      remember: (room) => this.remember(key, room),
      matching: (query, limit) => this.matching(key, query, limit)
    };
  }

  private matching(realm: string, query: string, limit: number): VisitedDestination[] {
    this.load();
    return matchVisits(this.visited.get(realm) ?? [], query, limit);
  }

  private remember(realm: string, room: { id: string; name: string }): void {
    this.load();
    const before = this.visited.get(realm) ?? [];
    const after = rememberVisit(
      before,
      { id: room.id, name: room.name, at: Date.now() },
      tuning().records.maxDestinations
    );
    this.visited.set(realm, after);
    this.schedule();
  }

  /**
   * Reads the file, once.
   *
   * A file that cannot be read is not a file that can be overwritten: it is the
   * only record of where these characters have been, and losing it to a
   * transient read failure would be silent. So the disk is suspended and said
   * out loud, and the list carries on in memory for this run.
   */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;

    let text: string;
    try {
      text = fs.readFileSync(this.options.file, 'utf8');
    } catch (error) {
      // A file that is simply not there yet is the ordinary first run, and
      // saying so would be the client reporting its own startup as a fault.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.suspended = true;
        this.options.notify?.(
          t('notices.world.destinations.readError', {
            file: this.options.file,
            message: errorMessage(error)
          })
        );
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.suspended = true;
      this.options.notify?.(
        t('notices.world.destinations.readError', {
          file: this.options.file,
          message: errorMessage(error)
        })
      );
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) return;
    const realms = (parsed as Record<string, unknown>)['realms'];
    if (typeof realms !== 'object' || realms === null) return;

    for (const [realm, value] of Object.entries(realms)) {
      if (!Array.isArray(value)) continue;
      const rows = value
        .map((entry) => readEntry(entry))
        .filter((entry): entry is VisitedDestination => entry !== null)
        // Sorted on the way in rather than trusted: every reader below takes
        // the head of this list as "most recent", and a hand-edited file must
        // not be able to make that claim false.
        .sort((a, b) => b.at - a.at)
        .slice(0, tuning().records.maxDestinations);
      if (rows.length > 0) this.visited.set(realmKey(realm), rows);
    }
  }

  private schedule(): void {
    if (this.suspended || this.timer !== null) return;
    this.dirty = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, this.options.saveDelayMs ?? tuning().records.destinationsSaveDelayMs);
    // Never a reason to hold the process open: what is unwritten is one row
    // saying somewhere was walked to, and it will be walked to again.
    this.timer.unref?.();
  }

  /**
   * Writes what has been visited.
   *
   * Temp file and rename, like every other file this client owns — a crash
   * mid-write must not leave a half-written file that then refuses to parse and
   * suspends the record for good.
   */
  save(): void {
    if (this.suspended || !this.dirty) return;
    this.dirty = false;

    const realms: DestinationFile['realms'] = {};
    for (const [realm, rows] of this.visited) {
      if (rows.length === 0) continue;
      realms[realm] = rows;
    }

    const temporary = `${this.options.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
      fs.writeFileSync(
        temporary,
        `${JSON.stringify({ v: 1, realms } satisfies DestinationFile, null, 2)}\n`
      );
      fs.renameSync(temporary, this.options.file);
    } catch (error) {
      this.dirty = true;
      this.options.notify?.(
        t('notices.world.destinations.writeError', {
          file: this.options.file,
          message: errorMessage(error)
        })
      );
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Nothing useful to do about a temp file that will not go away, and
        // failing here would replace a warning with a crash.
      }
    }
  }

  /** Writes anything outstanding and stops the timer. Called on quit. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.save();
  }
}

/** One row, or null. Every field is checked; none is coerced. */
function readEntry(value: unknown): VisitedDestination | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const id = record['id'];
  const name = record['name'];
  const at = record['at'];
  const visits = record['visits'];

  // A row missing either half is not a destination: an id with no name cannot
  // be searched for and a name with no id cannot be walked to.
  if (typeof id !== 'string' || id.trim().length === 0) return null;
  if (typeof name !== 'string' || name.trim().length === 0) return null;

  return {
    id: id.trim(),
    name: name.trim(),
    at: typeof at === 'number' && Number.isFinite(at) ? at : 0,
    visits: typeof visits === 'number' && Number.isFinite(visits) && visits > 0 ? visits : 1
  };
}
