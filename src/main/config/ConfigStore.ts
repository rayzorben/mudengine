/**
 * Loads, watches and republishes the YAML options file.
 *
 * The store owns exactly one file and never throws at its callers: a missing
 * file is created from the bundled template, and an unparseable one leaves the
 * previous values in place with the error reported alongside them. Options
 * therefore have the same availability guarantee as the socket — a bad edit
 * cannot end a session.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

import {
  DEFAULT_CONFIG,
  normalizeConfig,
  type AppConfig,
  type ConfigSnapshot,
  type Server
} from '../../shared/config';
import { mergeLoops, sameLoops, type Loop } from '../../shared/loops';
import { errorMessage } from '../../shared/values';
import { Poller } from './Poller';

export interface ConfigStoreEvents {
  /** A reload completed, successfully or otherwise. */
  change: (snapshot: ConfigSnapshot) => void;
}

export interface ConfigStoreOptions {
  /**
   * An explicit choice, which wins outright.
   *
   * Separate from `searchPaths` because it is not a candidate — it is an
   * instruction. It used to be the first search path, and a search path only
   * wins if the file it names *already exists*: point `MUDENGINE_CONFIG` at a
   * fresh path and the client silently used whichever ordinary location
   * happened to have a file, which on a developer's machine is their real
   * configuration with their real characters in it.
   *
   * Silently, which is the part that matters. A harness asking for a clean
   * configuration got a dirty one and had no way to tell.
   */
  override?: string | undefined;
  /**
   * Candidate paths, most specific first. The first that exists is used; if
   * none do, the first writable candidate is created from `template`.
   */
  searchPaths: string[];
  /** Path of the annotated default file copied on first run. */
  template?: string | undefined;
}

export declare interface ConfigStore {
  on<E extends keyof ConfigStoreEvents>(event: E, listener: ConfigStoreEvents[E]): this;
  emit<E extends keyof ConfigStoreEvents>(
    event: E,
    ...args: Parameters<ConfigStoreEvents[E]>
  ): boolean;
}

export class ConfigStore extends EventEmitter {
  private readonly file: string;
  private current: AppConfig = DEFAULT_CONFIG;
  /**
   * The parsed file, before coercion.
   *
   * Profiles are overlays on the *file*, not on the coerced result: normalising
   * is not idempotent — a rule's `when: 'every 3s'` becomes a parsed trigger,
   * and feeding that back through the parser drops it — so a profile's patch is
   * merged onto this and the sum is coerced exactly once.
   */
  private raw: unknown = {};
  /**
   * What the tree beside the file contributes, rather than the file itself.
   *
   * Servers and global loops are directories now, and everything that reads a
   * configuration -- the palette, the profile overlay, the settings screen --
   * asks this store for one. Folding them in here rather than at every call
   * site is what stops a caller getting a configuration with the file's half
   * and not the disk's: there is one `config`, and it is complete.
   */
  private extras: { servers: Server[]; loops: Loop[] } = { servers: [], loops: [] };
  private error: string | null = null;
  private loadedAt = 0;

  /**
   * The watcher polls `stat` rather than subscribing to inotify. That is the
   * slower mechanism and it is the right one here: `fs.watch` loses the file
   * the moment an editor saves by writing a temp file and renaming over the
   * target — which vim, JetBrains and every atomic-save editor do by default —
   * and this project lives inside a Dropbox tree, where the sync client
   * replaces files the same way. `megamind-client` polls for exactly this
   * reason; the earlier CoffeeScript `mudengine` used `fs.watch` and stops
   * reloading after the first such save.
   *
   * The poll is an owned `setInterval` rather than `fs.watchFile`. The latter
   * establishes its baseline with an *asynchronous* stat, so a write landing
   * between `watch()` and that stat completing is absorbed into the baseline
   * and never reported at all — the file silently stops being watched from the
   * very first edit. Polling ourselves also keeps two stores on the same path
   * independent, which `fs.watchFile`'s per-filename listener registry does
   * not. One `stat` twice a second on a 2 KB file costs nothing.
   *
   * `Poller` holds the mechanism, once, for every store in this directory; the
   * revision it settles on is the one that was actually parsed, so a write
   * racing the read is picked up on the next tick instead of being mistaken
   * for the starting state.
   */
  private readonly poller: Poller;

  constructor(options: ConfigStoreOptions) {
    super();
    this.file = ConfigStore.locate(options);
    this.poller = new Poller({
      signature: () => this.signature(),
      reload: () => {
        this.read();
        this.emit('change', this.snapshot);
      }
    });
    this.read();
  }

  /** The current values. Always complete, even after a failed reload. */
  get config(): AppConfig {
    return this.current;
  }

  get path(): string {
    return this.file;
  }

  /**
   * The parsed file, with what the tree beside it contributes folded in.
   *
   * Callers overlay a profile onto this, so it has to carry the servers a
   * character may name and the loops it inherits — a base missing them would
   * make `server: GreaterMUD (local)` unresolvable for every character the
   * moment servers moved out of the file.
   */
  get source(): unknown {
    return this.composed();
  }

  /**
   * Hands the store what the directories beside the file say.
   *
   * Applied and republished immediately: these stores watch their own trees, so
   * a server file appearing has to reach every character the way an edit to the
   * options file does. Nothing is emitted while the values are unchanged, or a
   * store settling at startup would republish the configuration twice.
   */
  setExtras(extras: { servers: Server[]; loops: Loop[] }): void {
    const same =
      sameServers(extras.servers, this.extras.servers) &&
      sameLoops(extras.loops, this.extras.loops);
    this.extras = extras;
    if (same) return;
    this.recompose();
    this.emit('change', this.snapshot);
  }

  get snapshot(): ConfigSnapshot {
    return {
      config: this.current,
      path: this.file,
      error: this.error,
      loadedAt: this.loadedAt
    };
  }

  /** Begins watching. Idempotent, so callers need not track whether it ran. */
  watch(): void {
    this.poller.start();
  }

  dispose(): void {
    this.poller.stop();
    this.removeAllListeners();
  }

  /**
   * Reads and normalises the file.
   *
   * On any failure the previously loaded values are retained and the reason is
   * recorded on the snapshot for the renderer to surface. Note that a file that
   * parses to `null` — an empty file, or one that is only comments — is a valid
   * document meaning "all defaults", not an error.
   */
  private read(): void {
    let text: string;

    try {
      text = fs.readFileSync(this.file, 'utf8');
      this.poller.settle();
    } catch (cause) {
      // Settled on the unreadable state, so a file that stays missing is quiet
      // until it appears.
      this.poller.settle();
      this.error = `Could not read ${this.file}: ${errorMessage(cause)}`;
      return;
    }

    let parsed: unknown;
    try {
      parsed = parse(text);
    } catch (cause) {
      this.error = `${path.basename(this.file)}: ${errorMessage(cause)}`;
      return;
    }

    this.raw = parsed;
    this.recompose();
    this.error = null;
    this.loadedAt = Date.now();
  }

  /**
   * The file and the tree, as one configuration.
   *
   * `normalizeConfig` is not idempotent — a rule's `when: 'every 3s'` becomes a
   * parsed trigger and feeding that back through drops it — so the merge
   * happens on the *raw* value and is coerced exactly once, which is the same
   * rule `resolveProfile` follows for a profile overlay.
   */
  private composed(): unknown {
    if (typeof this.raw !== 'object' || this.raw === null || Array.isArray(this.raw)) {
      return this.raw;
    }
    const record = this.raw as Record<string, unknown>;
    const automation =
      typeof record['automation'] === 'object' && record['automation'] !== null
        ? (record['automation'] as Record<string, unknown>)
        : {};
    const stated = normalizeConfig(this.raw);
    return {
      ...record,
      /*
       * The directories, and only the directories. The options file used to be
       * able to state realms too and the two were merged by name; a realm is a
       * file now, so a second spelling of the same thing in the global file
       * would be one nobody could see and one the settings screen could not
       * edit.
       */
      servers: this.extras.servers,
      automation: { ...automation, loops: mergeLoops(stated.automation.loops, this.extras.loops) }
    };
  }

  private recompose(): void {
    this.current = normalizeConfig(this.composed());
  }

  /** One file's revision. A throw — no file yet — is `Poller`'s to absorb. */
  private signature(): string {
    const stat = fs.statSync(this.file);
    return `${stat.mtimeMs}:${stat.size}`;
  }

  /**
   * Picks the file to own, creating it from the template when nothing exists
   * yet. Falls back to the template itself — read-only but valid — if every
   * candidate directory refuses to be written to.
   */
  private static locate({ override, searchPaths, template }: ConfigStoreOptions): string {
    const candidates = searchPaths.filter((candidate) => candidate.length > 0);

    /*
     * An explicit choice is not a candidate. Whether the file exists yet is
     * beside the point — being told which file to use and then using a
     * different one is the failure, and it is silent.
     */
    if (override !== undefined && override.length > 0) {
      if (!fs.existsSync(override)) {
        try {
          fs.mkdirSync(path.dirname(override), { recursive: true });
          fs.writeFileSync(override, readTemplate(template), 'utf8');
        } catch {
          // Unwritable. Still the answer: the caller asked for this path, and
          // falling back to somebody's real configuration is worse than
          // starting with documented defaults.
        }
      }
      return override;
    }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }

    const contents = readTemplate(template);

    for (const candidate of candidates) {
      try {
        fs.mkdirSync(path.dirname(candidate), { recursive: true });
        fs.writeFileSync(candidate, contents, 'utf8');
        return candidate;
      } catch {
        // Read-only install directory, sandboxed home — try the next one.
      }
    }

    // Nothing was writable. The template still parses, so the app starts with
    // documented defaults rather than refusing to run.
    return template ?? candidates[0] ?? '';
  }
}

function readTemplate(template: string | undefined): string {
  if (!template) return '';
  try {
    return fs.readFileSync(template, 'utf8');
  } catch {
    return '';
  }
}

/** Whether two server lists say the same thing, for the no-op check above. */
function sameServers(a: readonly Server[], b: readonly Server[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((server, index) => {
    const other = b[index];
    return (
      !!other &&
      server.name === other.name &&
      server.host === other.host &&
      server.port === other.port &&
      server.encoding === other.encoding &&
      server.login.length === other.login.length &&
      server.login.every((step, at) => {
        const twin = other.login[at];
        return !!twin && step.when === twin.when && step.send === twin.send;
      })
    );
  });
}
