import fs from 'node:fs';
import { parse } from 'yaml';

import { errorMessage } from '../../shared/values';

/**
 * A list the client ships as YAML under one key (`loops:`, `rooms:`), read
 * once and kept, through the parser the rest of the client uses for the same
 * entries, so a shipped entry that has gone wrong is lost alone. A missing or
 * broken file is an empty list and a warning: what is shipped is a
 * convenience, and the window that asked must still work without it.
 */
export class ShippedList<T> {
  private loaded: T[] | null = null;

  constructor(
    private readonly file: string,
    private readonly key: string,
    private readonly read: (value: unknown) => T[]
  ) {}

  /** Every entry, in the order the file lists them. */
  all(): T[] {
    this.loaded ??= this.load();
    return this.loaded;
  }

  private load(): T[] {
    let source: string;
    try {
      source = fs.readFileSync(this.file, 'utf8');
    } catch {
      console.warn(`${this.key}: no catalogue at ${this.file}`);
      return [];
    }
    try {
      const document = parse(source) as unknown;
      const entries = this.read(
        typeof document === 'object' && document !== null
          ? (document as Record<string, unknown>)[this.key]
          : undefined
      );
      if (entries.length === 0) console.warn(`${this.key}: ${this.file} defines none`);
      return entries;
    } catch (error) {
      console.warn(`${this.key}: ${this.file} would not parse: ${errorMessage(error)}`);
      return [];
    }
  }
}
