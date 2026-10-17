/**
 * Loads and watches the profiles directory: one YAML file per character, as a
 * directory of its own. It holds each file's text and resolves the characters
 * from it, so a change the client makes (`edit`, through `HeldFiles`) reaches
 * every session before the file is written, and the watch (`Poller`) reloads
 * only an edit made elsewhere. A revision covers the listing, so a character
 * appearing or going counts as a change. `mudengine-config` has the reasons.
 *
 * It never throws at its callers. A file that will not parse, or that cannot
 * name a server, is reported and skipped; the other characters load.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

import { mergeLoops, type Loop } from '../../shared/loops';
import { mergeMobRules, type MobRule } from '../../shared/mobRules';
import { resolveProfile, type Profile } from '../../shared/profiles';
import { errorMessage } from '../../shared/values';
import { PROFILE_FILE } from '../app/home';
import { directoryNames } from './dirs';
import { HeldFiles, type OwnedFiles } from './HeldFiles';
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
  /**
   * The monster rows beneath every scope: MegaMUD's table (todo 817). Merged
   * after resolution, under the list the three scopes already made, so any
   * row a player states for the same monster wins.
   */
  mobRulesBeneath?: () => readonly MobRule[];
  /** Each character read, as its file states it and as it resolved, for what it refuses (todo 134). */
  resolved?: (id: string, raw: unknown, profile: Profile) => void;
}

export declare interface ProfileStore {
  on<E extends keyof ProfileStoreEvents>(event: E, listener: ProfileStoreEvents[E]): this;
  emit<E extends keyof ProfileStoreEvents>(
    event: E,
    ...args: Parameters<ProfileStoreEvents[E]>
  ): boolean;
}

export class ProfileStore extends EventEmitter {
  private readonly dir: string;
  private current: Profile[] = [];
  private errors: string[] = [];
  private loadedAt = 0;
  private readonly poller: Poller;
  private readonly held: HeldFiles;
  /** Files the last read from disk could not open, and why. */
  private readErrors: string[] = [];
  /** The directory itself, when it could not be listed. */
  private unlisted: string | null = null;

  constructor(private readonly options: ProfileStoreOptions) {
    super();
    this.dir = options.directory;
    this.poller = new Poller({
      watched: () => [
        {
          kind: 'each',
          dir: this.dir,
          each: (id) => [{ kind: 'file', path: path.join(this.dir, id, PROFILE_FILE) }]
        }
      ],
      reload: () => this.reload()
    });
    this.held = new HeldFiles(
      this.poller,
      (file) =>
        path.basename(file) === PROFILE_FILE && path.dirname(path.dirname(file)) === this.dir,
      () => this.refresh()
    );
    this.load();
  }

  /** The store's files, read and edited through what it holds (`HeldFiles`). */
  get files(): OwnedFiles {
    return this.held;
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
   * Re-resolves every character from the held files, for a changed global
   * configuration or loop, or the store's own edit. Nothing is read from disk.
   */
  refresh(): void {
    this.resolve();
    this.emit('change', this.snapshot);
  }

  /** Reads every character's file from disk now: the watch's reload, and an import's. */
  reload(): void {
    this.load();
    this.emit('change', this.snapshot);
  }

  dispose(): void {
    this.poller.stop();
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------- internals

  private load(): void {
    /*
     * Settled before reading rather than after, so a file changing while the
     * profiles are being read differs from the settled listing and is picked
     * up on the next check instead of being absorbed.
     */
    this.poller.settle();
    const texts = new Map<string, string>();
    const errors: string[] = [];
    this.unlisted = null;
    let ids: string[] = [];
    try {
      ids = directoryNames(this.dir);
    } catch (cause) {
      /*
       * A directory that has become unreadable is not the same as one with no
       * characters in it, and silently returning none makes every tab vanish
       * with nothing said. `ENOENT` *is* the empty case — the directory has
       * simply not been created yet — and stays quiet.
       */
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.unlisted = `${this.dir}: ${errorMessage(cause)}`;
      }
    }
    for (const id of ids) {
      const file = path.join(this.dir, id, PROFILE_FILE);
      if (!fs.existsSync(file)) continue;
      try {
        texts.set(file, fs.readFileSync(file, 'utf8'));
      } catch (error) {
        errors.push(`${id}: ${errorMessage(error)}`);
      }
    }
    this.readErrors = errors;
    this.held.replace(texts);
    this.resolve();
  }

  /** The characters, ordered by id, from the held texts. */
  private resolve(): void {
    this.loadedAt = Date.now();
    if (this.unlisted !== null) {
      this.errors = [this.unlisted];
      this.current = [];
      return;
    }
    const base = this.options.base();
    const profiles: Profile[] = [];
    const errors = [...this.readErrors];
    for (const { file, id } of this.held.byDirectory()) {
      let raw: unknown;
      try {
        raw = parse(this.held.read(file) ?? '');
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
      const beneath = this.options.mobRulesBeneath?.() ?? [];
      if (beneath.length > 0) {
        const combat = result.profile.config.automation.combat;
        combat.mobRules = mergeMobRules(beneath, combat.mobRules);
      }
      this.options.resolved?.(id, raw, result.profile);
      profiles.push(result.profile);
    }

    this.current = profiles;
    this.errors = errors;
  }
}
