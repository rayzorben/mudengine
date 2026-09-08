import fs from 'node:fs';
import path from 'node:path';

import type { RealmFamily as RealmWord } from '../../shared/character';
import { asShippedWorld, worldOfRealm, type ShippedWorld } from '../../shared/worlds';
import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';

/**
 * Which bundled world each realm has said it runs, by the address dialled.
 *
 * A realm names its data at its own menu — `[MAJORMUD]:`, `[PARADIGM]:` — but
 * a session's world is bound when the session is built, before anything has
 * been dialled. So what a realm said last time is written down here, and a
 * realm that has never said anything walks the default world, announced, until
 * it does. Keyed by address like `PlayerBook`: the word is the server's, and
 * two realm entries dialling one address are one realm.
 *
 * **Written the moment it is learned**, synchronously and atomically: one small
 * record, once per connection, and the one moment it matters is the next
 * launch. A file that will not parse is left alone and said out loud, and the
 * process carries on with what it heard this run.
 */
export interface WorldBookOptions {
  /** Where the file lives. Created on demand. */
  file: string;
  /** Reported when the file cannot be read or written. Never silent. */
  notify?(message: string): void;
}

interface WorldEntry {
  world: ShippedWorld;
  /** The realm's own word, kept as provenance for the world beside it. */
  realm: RealmWord;
  at: number;
}

interface WorldFile {
  v: number;
  realms: Record<string, WorldEntry>;
}

export class WorldBook {
  private readonly known = new Map<string, WorldEntry>();
  private loaded = false;
  /** True once the file was found unparseable; nothing is written over it. */
  private suspended = false;

  constructor(private readonly options: WorldBookOptions) {}

  /** The world this address has said it runs, or null if it never has. */
  at(address: string): ShippedWorld | null {
    this.load();
    return this.known.get(address)?.world ?? null;
  }

  /**
   * Records what a realm called itself. Returns the world that word names, or
   * null when it names none — and writes only when the answer changed.
   */
  learn(address: string, realm: RealmWord, at = Date.now()): ShippedWorld | null {
    this.load();
    const world = worldOfRealm(realm);
    if (world === null) return null;
    const held = this.known.get(address);
    if (held?.world === world && held.realm === realm) return world;
    this.known.set(address, { world, realm, at });
    this.save();
    return world;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;

    let text: string;
    try {
      text = fs.readFileSync(this.options.file, 'utf8');
    } catch (error) {
      // Not there yet is the ordinary first run, not a fault to report.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.suspended = true;
        this.options.notify?.(
          t('notices.world.worlds.readError', {
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
        t('notices.world.worlds.readError', {
          file: this.options.file,
          message: errorMessage(error)
        })
      );
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) return;
    const realms = (parsed as Record<string, unknown>)['realms'];
    if (typeof realms !== 'object' || realms === null) return;
    for (const [address, value] of Object.entries(realms)) {
      const entry = readEntry(value);
      if (entry !== null) this.known.set(address, entry);
    }
  }

  /** Temp file and rename, like every other file this client owns. */
  private save(): void {
    if (this.suspended) return;
    const realms: WorldFile['realms'] = {};
    for (const [address, entry] of [...this.known].sort(([a], [b]) => (a < b ? -1 : 1))) {
      realms[address] = entry;
    }
    const temporary = `${this.options.file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
      fs.writeFileSync(
        temporary,
        `${JSON.stringify({ v: 1, realms } satisfies WorldFile, null, 2)}\n`
      );
      fs.renameSync(temporary, this.options.file);
    } catch (error) {
      this.options.notify?.(
        t('notices.world.worlds.writeError', {
          file: this.options.file,
          message: errorMessage(error)
        })
      );
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // A temp file that will not go is a warning, not a crash.
      }
    }
  }
}

/** One entry, or null: the world parsed, the word checked, the time a number. */
function readEntry(value: unknown): WorldEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const world = asShippedWorld(record['world']);
  const realm = record['realm'];
  const at = record['at'];
  if (world === null) return null;
  if (realm !== 'majormud' && realm !== 'paradigm' && realm !== 'greatermud') return null;
  // The word must still name the world beside it; a hand edit that split them
  // is dropped rather than half-believed.
  if (worldOfRealm(realm) !== world) return null;
  return { world, realm, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 };
}
