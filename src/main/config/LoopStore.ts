/**
 * The loops on disk: one file each, in one of three directories.
 *
 * A loop used to be an entry in `automation.loops` in whichever YAML file
 * happened to hold it, which made two things impossible to say. The first is
 * *scope*: a loop belongs to everybody, to every character on one server, or to
 * one character, and a list inside a character's own file can only ever mean
 * the last of those — sharing one meant pasting it into every file that wanted
 * it, and then keeping the copies in step by hand. The second is *addressing*:
 * `overlay` replaces a list wholesale, so a character that wanted one loop of
 * its own had to restate every loop it also wanted to keep.
 *
 * So the scope is the **directory a file sits in** and nothing else:
 *
 * ```
 * global/loops/*.yaml            every character, whatever server
 * servers/<id>/loops/*.yaml      every character on that server
 * profiles/<id>/loops/*.yaml     that character alone
 * ```
 *
 * Nothing inside a file says which scope it is in, because then a file could
 * disagree with where it is, and moving one between scopes would be an edit
 * rather than a move.
 *
 * Held and watched like every file the user owns (`HeldFiles`, `Poller`), so a
 * loop filed from the client is live before its file is written, one written
 * by hand appears without a restart, and one deleted stops being offered.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

import { isLoopFileName } from '../../shared/files';
import { asLoops, type Loop } from '../../shared/loops';
import { LOOPS_DIR, type Home } from '../app/home';
import { directoryNames } from './dirs';
import { HeldFiles, type OwnedFiles } from './HeldFiles';
import { Poller } from './Poller';
import type { Watched } from './revision';

/** The loops as a reader needs them: the settings editor's view of the live store. */
export type LoopLists = Pick<LoopStore, 'globalLoops' | 'forServer' | 'forProfile'>;

/** Which scope a loops directory is: everybody's, one realm's or one character's. */
type LoopScopeOf = { scope: 'global' } | { scope: 'server' | 'profile'; id: string };

export interface LoopStoreEvents {
  change: () => void;
}

export declare interface LoopStore {
  on<E extends keyof LoopStoreEvents>(event: E, listener: LoopStoreEvents[E]): this;
  emit<E extends keyof LoopStoreEvents>(event: E, ...args: Parameters<LoopStoreEvents[E]>): boolean;
}

export class LoopStore extends EventEmitter {
  private global: Loop[] = [];
  private servers = new Map<string, Loop[]>();
  private profiles = new Map<string, Loop[]>();
  private problems: string[] = [];
  private readonly poller: Poller;
  private readonly held: HeldFiles;

  constructor(
    private readonly home: Home,
    private readonly onError?: (message: string) => void
  ) {
    super();
    this.poller = new Poller({
      watched: () => this.watched(),
      reload: () => this.reload()
    });
    this.held = new HeldFiles(
      this.poller,
      (file) => isLoopFileName(path.basename(file)) && this.scopeOf(path.dirname(file)) !== null,
      () => {
        this.resolve();
        this.emit('change');
      }
    );
    this.load();
  }

  /** The store's files, read and edited through what it holds (`HeldFiles`). */
  get files(): OwnedFiles {
    return this.held;
  }

  /** Loops every character may walk. */
  get globalLoops(): Loop[] {
    return this.global;
  }

  /** Loops every character on this server may walk. Keyed by directory id. */
  forServer(id: string): Loop[] {
    return this.servers.get(id) ?? [];
  }

  /** Loops only this character may walk. Keyed by directory id. */
  forProfile(id: string): Loop[] {
    return this.profiles.get(id) ?? [];
  }

  /** Files that could not become a loop, and why. */
  get errors(): string[] {
    return this.problems;
  }

  watch(): void {
    this.poller.start();
  }

  dispose(): void {
    this.poller.stop();
    this.removeAllListeners();
  }

  /** Reads every loop file from disk now: the watch's reload, and an import's. */
  reload(): void {
    this.load();
    this.emit('change');
  }

  private load(): void {
    const texts = new Map<string, string>();
    const unread: string[] = [];
    const take = (dir: string): void => {
      for (const name of yamlFiles(dir)) {
        const file = path.join(dir, name);
        try {
          texts.set(file, fs.readFileSync(file, 'utf8'));
        } catch (error) {
          unread.push(unreadable(file, error));
        }
      }
    };
    take(this.home.globalLoops);
    for (const id of directories(this.home.serversDir)) take(this.home.server(id).loops);
    for (const id of directories(this.home.profilesDir)) take(this.home.profile(id).loops);
    this.held.replace(texts);
    this.poller.settle();
    this.resolve(unread);
  }

  /** The three scopes from the held texts, each file in name order, each problem said. */
  private resolve(unread: readonly string[] = []): void {
    this.problems = [...unread];
    const global: Loop[] = [];
    const servers = new Map<string, Loop[]>();
    const profiles = new Map<string, Loop[]>();
    for (const file of this.held.files) {
      const scope = this.scopeOf(path.dirname(file));
      if (scope === null) continue;
      const loops = this.loopsIn(file);
      if (loops.length === 0) continue;
      if (scope.scope === 'global') {
        global.push(...loops);
        continue;
      }
      const into = scope.scope === 'server' ? servers : profiles;
      into.set(scope.id, [...(into.get(scope.id) ?? []), ...loops]);
    }
    this.global = global;
    this.servers = servers;
    this.profiles = profiles;
    for (const problem of this.problems) this.onError?.(problem);
  }

  /** Whose loops a directory holds, or null for one that is not a loops directory. */
  private scopeOf(dir: string): LoopScopeOf | null {
    if (dir === this.home.globalLoops) return { scope: 'global' };
    if (path.basename(dir) !== LOOPS_DIR) return null;
    const owner = path.dirname(dir);
    const id = path.basename(owner);
    if (path.dirname(owner) === this.home.serversDir) return { scope: 'server', id };
    if (path.dirname(owner) === this.home.profilesDir) return { scope: 'profile', id };
    return null;
  }

  /** The loops one held file describes; one that describes none, or does not parse, is said. */
  private loopsIn(file: string): Loop[] {
    try {
      const parsed = parse(this.held.read(file) ?? '');
      const found = readLoops(parsed, path.basename(file).replace(/\.ya?ml$/i, ''));
      // Reported rather than skipped in silence: a file in a loops directory
      // was put there on purpose, and one that produces nothing is a loop
      // somebody believes they have.
      if (found.length === 0) {
        this.problems.push(`${file} is in a loops directory but does not describe a loop`);
      }
      return found;
    } catch (error) {
      this.problems.push(unreadable(file, error));
      return [];
    }
  }

  /**
   * The loop files across all three scopes.
   *
   * Names, sizes and mtimes rather than contents: the point is to notice a
   * change cheaply, and re-reading every loop on every check to find out
   * whether any of them changed is the cost this avoids.
   */
  private watched(): Watched[] {
    const loops = (dir: string): Watched[] => [{ kind: 'files', dir, accept: isLoopFileName }];
    return [
      ...loops(this.home.globalLoops),
      { kind: 'each', dir: this.home.serversDir, each: (id) => loops(this.home.server(id).loops) },
      { kind: 'each', dir: this.home.profilesDir, each: (id) => loops(this.home.profile(id).loops) }
    ];
  }
}

/**
 * The loops one file describes.
 *
 * A file holds one loop — that is the convention the client writes and the
 * reason the directory exists — but a list, or a `loops:` mapping somebody
 * pasted out of an older options file, is read too. Refusing those would be
 * refusing a file whose meaning is not in doubt.
 *
 * A loop with no `name` takes the file's own, so a file that plainly describes
 * a loop is never dropped for want of a key. The name is how the loop is
 * addressed everywhere else, and `sewer-loop` is a worse name than the player
 * would have chosen but a far better one than nothing.
 */
export function readLoops(parsed: unknown, fallbackName: string): Loop[] {
  if (Array.isArray(parsed)) return asLoops(parsed);
  if (typeof parsed !== 'object' || parsed === null) return [];
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record['loops'])) return asLoops(record['loops']);
  const named = typeof record['name'] === 'string' && record['name'].trim().length > 0;
  return asLoops([named ? record : { ...record, name: fallbackName }]);
}

function unreadable(file: string, error: unknown): string {
  return `${file} could not be read: ${error instanceof Error ? error.message : 'unknown error'}`;
}

/** Directory names inside `root`, sorted, or nothing if there is no `root`. */
function directories(root: string): string[] {
  try {
    return directoryNames(root);
  } catch {
    return [];
  }
}

/** YAML files inside `dir`, sorted. Backups and temporaries are not loops. */
function yamlFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(isLoopFileName).sort();
  } catch {
    return [];
  }
}
