/**
 * Loads and watches the profiles directory: one YAML file per character.
 *
 * A sibling of `ConfigStore`, and it polls for the same reasons — `fs.watch`
 * loses a file the moment an editor saves by writing a temp file and renaming
 * over the target, which vim, JetBrains and every atomic-save editor do by
 * default, and this project lives inside a Dropbox tree where the sync client
 * replaces files the same way. `fs.watchFile` establishes its baseline with an
 * asynchronous stat, so an edit landing during startup is absorbed and never
 * reported. Both failure modes are silent. See `ConfigStore` for the full
 * account; the only difference here is that the revision covers a *listing*
 * rather than one path, so a file appearing or disappearing counts as a change
 * too.
 *
 * Like the options store, it never throws at its callers. A file that will not
 * parse, or that cannot name a server, is reported and skipped — the other
 * characters load. One broken profile must not cost you the rest of them.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

import { mergeLoops, type Loop } from '../../shared/loops';
import { resolveProfile, type Profile } from '../../shared/profiles';
import { errorMessage } from '../../shared/values';
import { PROFILE_FILE } from '../app/home';
import { directoryNames } from './dirs';
import { Poller } from './Poller';

export interface ProfileSnapshot {
  directory: string;
  /** Characters that loaded, ordered by id so tabs do not reshuffle. */
  profiles: Profile[];
  /** Files that could not become a character, and why. */
  errors: string[];
  loadedAt: number;
}

export interface ProfileStoreEvents {
  change: (snapshot: ProfileSnapshot) => void;
}

export interface ProfileStoreOptions {
  directory: string;
  /**
   * The live options file **as parsed, before coercion**.
   *
   * Read through rather than captured, because a profile is an overlay on it:
   * an options file reloaded at runtime has to reach every character, including
   * settings no profile mentions. Raw rather than coerced because coercion is
   * not idempotent — see `resolveProfile`.
   */
  base: () => unknown;
  /**
   * Loops this character may walk that its own file does not state.
   *
   * The server's, then its own -- read from `servers/<id>/loops` and
   * `profiles/<id>/loops`, which this store cannot find for itself because it
   * knows nothing about servers. Applied *after* resolution rather than folded
   * into the base, because the base is shared by every character and these two
   * scopes are not.
   */
  loopsFor?: (id: string, serverName: string) => readonly Loop[];
}

export declare interface ProfileStore {
  on<E extends keyof ProfileStoreEvents>(event: E, listener: ProfileStoreEvents[E]): this;
  emit<E extends keyof ProfileStoreEvents>(
    event: E,
    ...args: Parameters<ProfileStoreEvents[E]>
  ): boolean;
}

/** Identifies a particular revision of the whole directory. */
type Listing = string;

export class ProfileStore extends EventEmitter {
  private readonly dir: string;
  private current: Profile[] = [];
  private errors: string[] = [];
  private loadedAt = 0;
  private readonly poller: Poller;

  constructor(private readonly options: ProfileStoreOptions) {
    super();
    this.dir = options.directory;
    this.poller = new Poller({
      signature: () => this.listing(),
      reload: () => {
        this.read();
        this.emit('change', this.snapshot);
      }
    });
    this.read();
  }

  get directory(): string {
    return this.dir;
  }

  get profiles(): Profile[] {
    return this.current;
  }

  get snapshot(): ProfileSnapshot {
    return {
      directory: this.dir,
      profiles: this.current,
      errors: this.errors,
      loadedAt: this.loadedAt
    };
  }

  /** Creates the directory if it is missing, so there is somewhere to put one. */
  ensureDirectory(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      // Reported by the next read; an unwritable directory is not fatal.
    }
  }

  watch(): void {
    this.poller.start();
  }

  /**
   * Re-resolves every character against a changed global configuration.
   *
   * Nothing on disk moved, so the listing is untouched — this is the path for
   * "the options file was edited", where each profile's overlay has to be
   * reapplied to new base values.
   */
  refresh(): void {
    this.load();
    this.emit('change', this.snapshot);
  }

  dispose(): void {
    this.poller.stop();
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------- internals

  private read(): void {
    /*
     * Settled before loading rather than after, so a file changing while the
     * profiles are being read differs from the settled listing and is picked
     * up on the next tick instead of being absorbed.
     */
    this.poller.settle();
    this.load();
  }

  /**
   * Every profile file's name, size and mtime, as one comparable string.
   *
   * A file added or removed changes the listing just as an edit does, which is
   * the whole reason this is a directory digest rather than a set of per-file
   * stats: dropping a YAML file in is the entire gesture for adding a
   * character, and it has to be noticed.
   */
  private listing(): Listing {
    try {
      return this.ids()
        .map((id) => {
          try {
            const stat = fs.statSync(path.join(this.dir, id, PROFILE_FILE));
            return `${id}:${stat.mtimeMs}:${stat.size}`;
          } catch {
            return `${id}:gone`;
          }
        })
        .join('|');
    } catch {
      // No directory yet is a valid state, and a stable one.
      return '';
    }
  }

  /**
   * The character directories, sorted so tabs do not reshuffle.
   *
   * A character is a **directory** now rather than a file, because it owns
   * loops of its own and a file cannot contain a directory. `strict` lets the
   * caller that has to distinguish "no directory yet" from "unreadable" see
   * the error, while the twice-a-second listing quietly reads nothing.
   */
  private ids(options: { strict?: boolean } = {}): string[] {
    try {
      return directoryNames(this.dir);
    } catch (error) {
      if (options.strict) throw error;
      return [];
    }
  }

  private load(): void {
    const base = this.options.base();
    const profiles: Profile[] = [];
    const errors: string[] = [];

    let ids: string[];
    try {
      ids = this.ids({ strict: true });
    } catch (cause) {
      /*
       * A directory that has become unreadable is not the same as one with no
       * characters in it, and silently returning none makes every tab vanish
       * with nothing said. `ENOENT` *is* the empty case — the directory has
       * simply not been created yet — and stays quiet.
       */
      ids = [];
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.errors = [`${this.dir}: ${errorMessage(cause)}`];
        this.current = [];
        this.loadedAt = Date.now();
        return;
      }
    }

    for (const id of ids) {
      const file = path.join(this.dir, id, PROFILE_FILE);
      if (!fs.existsSync(file)) continue;

      let raw: unknown;
      try {
        raw = parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        errors.push(`${id}: ${errorMessage(error)}`);
        continue;
      }

      // An empty file parses to null. That is a file someone is part-way
      // through writing, not a broken one, so it is skipped without complaint.
      if (raw === null || raw === undefined) continue;

      const result = resolveProfile(id, raw, base);
      if (result.error !== undefined) {
        errors.push(result.error);
        continue;
      }
      /*
       * The loops the directories beside this file lend it, laid over the ones
       * the configuration states. Later wins by name, so a character's own
       * `Sewer loop` is the one it walks -- the same rule its `automation:`
       * overlay follows, applied to a list that is assembled rather than
       * replaced.
       */
      const lent = this.options.loopsFor?.(id, result.profile.serverName) ?? [];
      if (lent.length > 0) {
        result.profile.config.automation.loops = mergeLoops(
          result.profile.config.automation.loops,
          lent
        );
      }
      profiles.push(result.profile);
    }

    this.current = profiles;
    this.errors = errors;
    this.loadedAt = Date.now();
  }
}
