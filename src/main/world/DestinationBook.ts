import { matchVisits, rememberVisit, type VisitedDestination } from '../../shared/destinations';
import { newestFirst } from '../../shared/recent';
import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';
import { writeWholeSync } from '../app/writeWhole';
import { tuning } from '../app/tuning';
import { realmKey } from './RealmLore';
import { readJsonRecord } from './readJsonRecord';

/**
 * Where each character on this machine has walked, one list per character.
 *
 * The reason the list exists is in `src/shared/destinations.ts`: the realm's
 * own room search is a capped substring match in build order, so the one place
 * a character has been sits below the cap and is never shown.
 *
 * One list per character (the user, 2026-11-03): four characters on one realm
 * buried each one's own places under the others' walks.
 * Inside a character's file the rows are still filed by world through
 * `realmKey`, because a room id only means a place in the data that defines it.
 * Writes are lazy and never block a walk. `mudengine-world` › `parts/lore.md`.
 */
export interface DestinationBookOptions {
  /** Where one character's file lives (`CHARACTER_RECORDS.destinations`). Created on demand. */
  fileFor(character: string): string;
  /** How long to wait before writing after a change. */
  saveDelayMs?: number;
  /** Reported when a file cannot be read or written. Never silent. */
  notify?(message: string): void;
}

/** One character's file. The migration that seeded it writes the same shape. */
interface DestinationFile {
  v: number;
  /** Keyed by world (`realmKey`), since a room id only means a place in its own data. */
  realms: Record<string, VisitedDestination[]>;
}

/**
 * The view one character on one world sees.
 *
 * Narrow, for the reason `RealmLore.forRealm` is narrow: a session holds one of
 * these and cannot name another character or another world, which is the door
 * through which one list's rooms would reach another's search.
 */
export interface RealmDestinations {
  /** Note that a walk has been started toward this room. */
  remember(room: { id: string; name: string }): void;
  /** The destinations matching a query, newest first; the latest with none. */
  matching(query: string, limit: number): VisitedDestination[];
}

export class DestinationBook {
  private readonly lists = new Map<string, DestinationList>();

  constructor(private readonly options: DestinationBookOptions) {}

  /** This character's list on this world, read from its own file on first use. */
  forCharacter(character: string, realm: string): RealmDestinations {
    let list = this.lists.get(character);
    if (list === undefined) {
      list = new DestinationList(this.options.fileFor(character), this.options);
      this.lists.set(character, list);
    }
    const key = realmKey(realm);
    const held = list;
    return {
      remember: (room) => held.remember(key, room),
      matching: (query, limit) => held.matching(key, query, limit)
    };
  }

  /** Writes every list's outstanding rows and stops their timers. Called on quit. */
  flush(): void {
    for (const list of this.lists.values()) list.flush();
  }
}

/** One character's file: its rows per world, read once, written lazily. */
class DestinationList {
  private readonly visited = new Map<string, VisitedDestination[]>();
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private loaded = false;
  /** True once the file was found unparseable; nothing is written over it. */
  private suspended = false;

  constructor(
    private readonly file: string,
    private readonly options: Pick<DestinationBookOptions, 'saveDelayMs' | 'notify'>
  ) {}

  matching(realm: string, query: string, limit: number): VisitedDestination[] {
    this.load();
    return matchVisits(this.visited.get(realm) ?? [], query, limit);
  }

  remember(realm: string, room: { id: string; name: string }): void {
    this.load();
    const before = this.visited.get(realm) ?? [];
    const after = rememberVisit(before, { id: room.id, name: room.name, at: Date.now() });
    this.visited.set(realm, after);
    this.schedule();
  }

  /**
   * Reads the file, once.
   *
   * A file that cannot be read is not a file that can be overwritten: it is the
   * only record of where this character has been, and losing it to a
   * transient read failure would be silent. So the disk is suspended and said
   * out loud, and the list carries on in memory for this run.
   */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;

    const read = readJsonRecord(this.file);
    // A file that is simply not there yet is a character that has walked nowhere.
    if (read.kind === 'absent') return;
    if (read.kind === 'unreadable') {
      this.suspended = true;
      this.options.notify?.(
        t('notices.world.destinations.readError', {
          file: this.file,
          message: errorMessage(read.error)
        })
      );
      return;
    }
    const parsed = read.value;

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
        .sort(newestFirst);
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
  private save(): void {
    if (this.suspended || !this.dirty) return;
    this.dirty = false;

    const realms: DestinationFile['realms'] = {};
    for (const [realm, rows] of this.visited) {
      if (rows.length === 0) continue;
      realms[realm] = rows;
    }

    try {
      writeWholeSync(
        this.file,
        `${JSON.stringify({ v: 1, realms } satisfies DestinationFile, null, 2)}\n`
      );
    } catch (error) {
      this.dirty = true;
      this.options.notify?.(
        t('notices.world.destinations.writeError', {
          file: this.file,
          message: errorMessage(error)
        })
      );
    }
  }

  /** Writes anything outstanding and stops the timer. */
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
