/**
 * Loads, watches and republishes the internal settings file.
 *
 * The same shape as `ConfigStore` and for the same reasons — an owned
 * `setInterval` poll rather than `fs.watch`, because this repo lives in a
 * Dropbox tree and every atomic-save editor replaces the file rather than
 * writing into it; a bad edit keeps the last good values and reports; a
 * missing file is created from the bundled template. Its own class rather
 * than a generic one shared with the options store because the two files
 * have different lifecycles (the options file has an override, search paths,
 * profiles overlaid on its *source*) and a generic store would carry both
 * sets of concerns for two callers.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

import { DEFAULT_INTERNAL, normalizeInternal, type InternalConfig } from '../../shared/internal';
import { errorMessage } from '../../shared/values';
import { Poller } from './Poller';

export interface InternalStoreOptions {
  /** Where the live file is, or should be created. */
  file: string;
  /** The annotated template copied on first run. */
  template: string;
  /** A parse failure, said out loud rather than swallowed. */
  onError?: (message: string) => void;
}

export interface InternalStoreEvents {
  change: (config: InternalConfig) => void;
}

export declare interface InternalStore {
  on<E extends keyof InternalStoreEvents>(event: E, listener: InternalStoreEvents[E]): this;
  emit<E extends keyof InternalStoreEvents>(
    event: E,
    ...args: Parameters<InternalStoreEvents[E]>
  ): boolean;
}

export class InternalStore extends EventEmitter {
  private current: InternalConfig = DEFAULT_INTERNAL;
  private readonly poller: Poller;

  constructor(private readonly options: InternalStoreOptions) {
    super();
    this.poller = new Poller({
      signature: () => this.signature(),
      reload: () => {
        this.read();
        this.emit('change', this.current);
      }
    });
    this.create();
    this.read();
  }

  /** The current values. Always complete, even after a failed reload. */
  get config(): InternalConfig {
    return this.current;
  }

  get path(): string {
    return this.options.file;
  }

  watch(): void {
    this.poller.start();
  }

  dispose(): void {
    this.poller.stop();
    this.removeAllListeners();
  }

  /** Copies the template into place on first run. Never overwrites. */
  private create(): void {
    const { file, template } = this.options;
    if (fs.existsSync(file)) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, fs.readFileSync(template, 'utf8'), 'utf8');
    } catch {
      // Unwritable, or no template: the defaults still apply, and `read`
      // reports the missing file once.
    }
  }

  private read(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.options.file, 'utf8');
      this.poller.settle();
    } catch (cause) {
      // Settled on the unreadable state, so a file that stays missing is quiet
      // until it appears.
      this.poller.settle();
      this.options.onError?.(`Could not read ${this.options.file}: ${errorMessage(cause)}`);
      return;
    }
    try {
      this.current = normalizeInternal(parse(text));
    } catch (cause) {
      // The last good values stay; the edit that broke the file is reported
      // where somebody can fix it.
      this.options.onError?.(`${path.basename(this.options.file)}: ${errorMessage(cause)}`);
    }
  }

  /** One file's revision. A throw — no file yet — is `Poller`'s to absorb. */
  private signature(): string {
    const stat = fs.statSync(this.options.file);
    return `${stat.mtimeMs}:${stat.size}`;
  }
}
