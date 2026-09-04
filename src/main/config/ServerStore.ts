/**
 * The servers on disk: one directory each, holding its file and its loops.
 *
 * `servers:` was a list inside the options file, which was the right shape
 * while a server was four fields and the options file was the only file there
 * was. It stopped being so the moment a server acquired a **login script** —
 * a list of menus and answers per BBS, which is the largest thing in the file
 * and the thing least like a setting — and it could never hold the loops that
 * belong to a realm rather than to a character, because a list inside a list
 * inside a global file has no way to say which server a loop is for.
 *
 * So a server is a directory:
 *
 * ```
 * servers/<id>/server.yaml    host, port, encoding, the menus
 * servers/<id>/loops/*.yaml   loops for every character playing here
 * ```
 *
 * The directory's name is an **id** — a filename, lower case, no spaces — and
 * the name a player reads is inside the file, exactly as a character's id is
 * its directory and its name is a key. Renaming a server therefore does not
 * move its loops, and two servers whose names differ only in punctuation are
 * two directories rather than one file overwriting another.
 *
 * Watched by an owned poll, like everything else the user owns; see
 * `ConfigStore` for why it is not `fs.watch`.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { parse } from 'yaml';

import { asServer, type Server } from '../../shared/config';
import type { Home } from '../app/home';
import { t } from '../app/i18n';
import { directoryNames } from './dirs';
import { Poller } from './Poller';

/** One server and the directory it was read from. */
export interface StoredServer {
  /** The directory name: how its loops are found, and how a file is addressed. */
  id: string;
  server: Server;
}

export interface ServerStoreEvents {
  change: () => void;
}

export declare interface ServerStore {
  on<E extends keyof ServerStoreEvents>(event: E, listener: ServerStoreEvents[E]): this;
  emit<E extends keyof ServerStoreEvents>(
    event: E,
    ...args: Parameters<ServerStoreEvents[E]>
  ): boolean;
}

export class ServerStore extends EventEmitter {
  private stored: StoredServer[] = [];
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

  get all(): StoredServer[] {
    return this.stored;
  }

  /** Just the servers, in the shape the rest of the client already reads. */
  get servers(): Server[] {
    return this.stored.map((entry) => entry.server);
  }

  /** Files that could not become a server, and why. */
  get errors(): string[] {
    return this.problems;
  }

  /**
   * The directory a server's name refers to.
   *
   * A character names its server in words and its loops live under an id, so
   * this is the one place the two are joined. Case-insensitive, because that is
   * how `servers:` has always been looked up.
   */
  idFor(name: string): string | undefined {
    const wanted = name.trim().toLowerCase();
    return this.stored.find((entry) => entry.server.name.toLowerCase() === wanted)?.id;
  }

  watch(): void {
    this.poller.start();
  }

  dispose(): void {
    this.poller.stop();
    this.removeAllListeners();
  }

  /** Re-reads now, for a caller that has just written one. */
  refresh(): void {
    this.read();
    this.emit('change');
  }

  private read(): void {
    const found: StoredServer[] = [];
    this.problems = [];

    for (const id of this.ids()) {
      const file = this.home.server(id).file;
      if (!fs.existsSync(file)) continue;
      try {
        const server = asServer(parse(fs.readFileSync(file, 'utf8')), id);
        if (!server) {
          // A server with no host is not a server. Reported rather than
          // defaulted, because a defaulted one is a character quietly dialling
          // somewhere nobody chose -- the rule a profile follows too.
          this.problems.push(t('notices.config.servers.noHost', { file }));
          continue;
        }
        found.push({ id, server });
      } catch (error) {
        this.problems.push(
          t('notices.config.servers.readError', {
            file,
            message: error instanceof Error ? error.message : 'unknown error'
          })
        );
      }
    }

    this.stored = found;
    this.poller.settle();
    for (const problem of this.problems) this.onError?.(problem);
  }

  private ids(): string[] {
    try {
      return directoryNames(this.home.serversDir);
    } catch {
      return [];
    }
  }

  private signature(): string {
    return this.ids()
      .map((id) => {
        try {
          const info = fs.statSync(this.home.server(id).file);
          return `${id}:${info.size}:${info.mtimeMs}`;
        } catch {
          return `${id}:gone`;
        }
      })
      .join('|');
  }
}
