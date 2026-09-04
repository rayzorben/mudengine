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
 * Watched like everything else the user owns — an owned poll over the listing,
 * for the reasons `ConfigStore` sets out — so a loop written by hand appears
 * without a restart, and one deleted stops being offered.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

import { asLoops, type Loop } from '../../shared/loops';
import type { Home } from '../app/home';
import { directoryNames } from './dirs';
import { Poller } from './Poller';

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

  constructor(
    private readonly home: Home,
    private readonly onError?: (message: string) => void
  ) {
    super();
    this.poller = new Poller({
      signature: () => this.signature(),
      reload: () => {
        this.read();
        this.emit('change');
      }
    });
    this.read();
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

  /** Re-reads now. For a caller that has just written one and wants it live. */
  refresh(): void {
    this.read();
    this.emit('change');
  }

  private read(): void {
    this.problems = [];
    this.global = this.readDirectory(this.home.globalLoops);
    this.servers = this.readScopes(this.home.serversDir, (id) => this.home.server(id).loops);
    this.profiles = this.readScopes(this.home.profilesDir, (id) => this.home.profile(id).loops);
    this.poller.settle();
    for (const problem of this.problems) this.onError?.(problem);
  }

  private readScopes(root: string, loopsIn: (id: string) => string): Map<string, Loop[]> {
    const found = new Map<string, Loop[]>();
    for (const id of directories(root)) {
      const loops = this.readDirectory(loopsIn(id));
      if (loops.length > 0) found.set(id, loops);
    }
    return found;
  }

  private readDirectory(dir: string): Loop[] {
    const loops: Loop[] = [];
    for (const file of yamlFiles(dir)) {
      const full = path.join(dir, file);
      try {
        const parsed = parse(fs.readFileSync(full, 'utf8'));
        const found = readLoops(parsed, file.replace(/\.ya?ml$/i, ''));
        if (found.length === 0) {
          // Reported rather than skipped in silence: a file in a loops
          // directory was put there on purpose, and one that produces nothing
          // is a loop somebody believes they have.
          this.problems.push(`${full} is in a loops directory but does not describe a loop`);
          continue;
        }
        loops.push(...found);
      } catch (error) {
        this.problems.push(
          `${full} could not be read: ${error instanceof Error ? error.message : 'unknown error'}`
        );
      }
    }
    return loops;
  }

  /**
   * What is on disk right now, across all three scopes.
   *
   * Names, sizes and mtimes rather than contents: the point is to notice a
   * change cheaply, and re-reading every loop twice a second to find out
   * whether any of them changed is the cost this avoids.
   */
  private signature(): string {
    const parts: string[] = [stamp(this.home.globalLoops)];
    for (const id of directories(this.home.serversDir)) {
      parts.push(`s:${id}:${stamp(this.home.server(id).loops)}`);
    }
    for (const id of directories(this.home.profilesDir)) {
      parts.push(`p:${id}:${stamp(this.home.profile(id).loops)}`);
    }
    return parts.join('|');
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
    return fs
      .readdirSync(dir)
      .filter((name) => !name.startsWith('.') && /\.ya?ml$/i.test(name))
      .sort();
  } catch {
    return [];
  }
}

/** One directory's listing as a revision string. */
function stamp(dir: string): string {
  return yamlFiles(dir)
    .map((name) => {
      try {
        const info = fs.statSync(path.join(dir, name));
        return `${name}:${info.size}:${info.mtimeMs}`;
      } catch {
        return `${name}:gone`;
      }
    })
    .join(',');
}
