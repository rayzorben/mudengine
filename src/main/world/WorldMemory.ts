import fs from 'node:fs';
import path from 'node:path';

import { discoveryKey, isDiscoveryReason, type Discovery } from '../../shared/memory';
import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';

interface MemoryFile {
  version: 1;
  /**
   * The realm these were learned against.
   *
   * A realm that changes its `database` is a different map, and an
   * edge learned on the shipped realm says nothing about a private one — the
   * room numbers do not even mean the same places. The file is kept and
   * ignored rather than deleted: somebody who switches back gets it back, and
   * throwing away a record because a setting changed is not this client's call.
   */
  realm: string;
  /**
   * Read as `unknown[]` and checked one row at a time, because the envelope
   * check deliberately does not vouch for the rows — see `isMemoryFile`. It is
   * written as `Discovery[]`, which is what `write` puts here.
   */
  discoveries: unknown[];
}

/**
 * What one character has learned about its realm, on disk.
 *
 * One file per character, beside the options file and the profiles, because
 * this is exactly as personal as those: a character that has been down a
 * corridor knows something the client did not ship with, and a second character
 * has not been there.
 *
 * **Nothing here writes to the realm database.** See `src/shared/memory.ts` for
 * why: an observation is one sample of one walk, and a pathfinder that believed
 * it would route a character through an edge that may have been a one-off.
 *
 * The write is deferred and atomic — temp file and rename, the same handling
 * `YamlFile` gives the options — because a client that is killed mid-write must
 * lose the last two seconds rather than the file.
 */
export class WorldMemory {
  private discoveries: Discovery[] = [];
  private readonly seen = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  /**
   * @param file Where this character's memory lives.
   * @param realm What realm it is being learned against, as `RealmLoad.source`.
   * @param onError Reported rather than thrown: failing to read a memory file
   *   must not stop a character connecting, and the failure is worth saying out
   *   loud because the alternative is a client that silently forgets.
   */
  constructor(
    private readonly file: string,
    private readonly realm: string,
    private readonly onError?: (message: string) => void
  ) {
    this.load();
  }

  /** Everything learned, oldest first. */
  get all(): readonly Discovery[] {
    return this.discoveries;
  }

  /**
   * Records an observation, or does nothing if it is already known.
   *
   * Returns it when it was new, so the caller can say so once rather than on
   * every walk down the same new corridor.
   */
  learn(discovery: Discovery): Discovery | null {
    const key = discoveryKey(discovery);
    if (this.seen.has(key)) return null;

    this.seen.add(key);
    this.discoveries.push(discovery);
    /*
     * The oldest goes, not the newest. A character that has been playing for
     * months has learned the map it plays on; the cap is a guard against a
     * pathological stream of one-off observations, and in that case the recent
     * ones are the ones still true.
     */
    if (this.discoveries.length > tuning().records.memoryLimit) {
      const dropped = this.discoveries.shift();
      if (dropped) this.seen.delete(discoveryKey(dropped));
    }
    this.schedule();
    return discovery;
  }

  /**
   * Strikes an observation out, because the person looking at it says it is
   * wrong. Returns whether there was one to strike.
   *
   * The one edit this record accepts. An observation is one sample of one
   * walk, and the walk may have been a mistyped direction the server happened
   * to accept — which is exactly the case nothing automatic can tell from a
   * genuine way through. Struck rather than hidden: `learn` will write it down
   * again the next time it is walked, which is the right answer if the person
   * was wrong and the map was not.
   */
  forget(key: string): boolean {
    if (!this.seen.has(key)) return false;
    this.seen.delete(key);
    this.discoveries = this.discoveries.filter((entry) => discoveryKey(entry) !== key);
    this.schedule();
    return true;
  }

  /** What has been learned about leaving one room. */
  from(room: string): Discovery[] {
    return this.discoveries.filter((discovery) => discovery.from === room);
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
      if (!isMemoryFile(parsed)) {
        this.onError?.(
          t('notices.world.memory.invalidFile', { fileName: path.basename(this.file) })
        );
        return;
      }
      if (parsed.realm !== this.realm) return;

      /*
       * Two different failures, and they want opposite answers.
       *
       * A row this build cannot *name* — a `reason` from a newer build, or one
       * added to the type and not yet to this reader — is intact data that this
       * version has no vocabulary for. Skipping it costs one row.
       *
       * A row that is **malformed** is different: a record missing `exits` read
       * as a record with no exits is half a fact presented as a whole one, and
       * a file containing one is a file something has damaged. That is what the
       * whole-file refusal was written for, and it stays.
       *
       * The two used to be one check, and the cost was severe: `unknown-stock`
       * was added to the type when shops were first learned from and never to
       * the reader, so from that day every character that had listed a single
       * shop reloaded with **nothing at all** — the exits went with it, and the
       * only visible symptom was the same shop being learned again each
       * session, which reads as a record that is not being saved.
       */
      const rows: Discovery[] = [];
      for (const discovery of parsed.discoveries) {
        if (isUnnamedReason(discovery)) continue;
        if (!isDiscovery(discovery)) {
          this.onError?.(
            t('notices.world.memory.invalidFile', { fileName: path.basename(this.file) })
          );
          return;
        }
        rows.push(discovery);
      }

      for (const discovery of rows) {
        const key = discoveryKey(discovery);
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        this.discoveries.push(discovery);
      }
    } catch (error) {
      // Kept, not deleted: it is the only copy of what this character learned,
      // and a parse failure is not permission to throw it away.
      this.onError?.(
        t('notices.world.memory.readError', {
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
    // Nothing here should hold the app open: a pending write is two seconds of
    // observations, and `close()` is what guarantees they land.
    this.timer.unref?.();
  }

  private write(): void {
    const payload: MemoryFile = {
      version: 1,
      realm: this.realm,
      discoveries: this.discoveries
    };
    const temporary = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.renameSync(temporary, this.file);
      this.dirty = false;
    } catch (error) {
      this.onError?.(
        t('notices.world.memory.saveError', {
          fileName: path.basename(this.file),
          message: errorMessage(error)
        })
      );
      // Deliberately left dirty, so the next discovery tries again rather than
      // the failure quietly becoming permanent.
      fs.rmSync(temporary, { force: true });
    }
  }
}

/**
 * Parsed, not trusted: this file is on disk where anything may have edited it.
 *
 * **The envelope only.** The rows are checked one at a time on the way in, and
 * a row that fails costs that row rather than the file — see `load`.
 *
 * It used to check the rows here too, with `.every(isDiscovery)`, and that is
 * the shape of the bug this whole change is about: one row the reader did not
 * recognise made the *whole file* "not a memory file", so everything a
 * character had learned was discarded and quietly re-learned. An unrecognised
 * row is the ordinary consequence of a file written by a newer build, or of one
 * reason being added to the type and not to the reader — which is exactly what
 * happened to `unknown-stock`. Neither is a reason to erase what is beside it.
 */
function isMemoryFile(value: unknown): value is MemoryFile {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Partial<MemoryFile>;
  if (file.version !== 1 || typeof file.realm !== 'string') return false;
  return Array.isArray(file.discoveries);
}

/**
 * A row that is shaped like a discovery but names a reason this build has never
 * heard of — a file written by a newer client, most likely.
 *
 * Told apart from a *damaged* row on purpose: this one is skipped and the file
 * is kept, where a damaged one is refused. See `load` for why the difference
 * matters enough to be two checks.
 */
function isUnnamedReason(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const reason = (value as { reason?: unknown }).reason;
  return typeof reason === 'string' && !isDiscoveryReason(reason);
}

function isDiscovery(value: unknown): value is Discovery {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<Discovery>;
  return (
    // From the union's own list, never spelled out again here: this check
    // named two of the three reasons for as long as shops have been learned
    // from, and the third failing it discarded the whole file.
    isDiscoveryReason(entry.reason) &&
    typeof entry.from === 'string' &&
    typeof entry.fromName === 'string' &&
    typeof entry.command === 'string' &&
    (entry.to === null || typeof entry.to === 'string') &&
    typeof entry.name === 'string' &&
    Array.isArray(entry.exits) &&
    entry.exits.every((exit) => typeof exit === 'string') &&
    typeof entry.at === 'number'
  );
}
