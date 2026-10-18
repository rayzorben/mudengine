/**
 * The text of each file a store resolved its values from, and the one way a
 * change the client makes reaches it: the held text and the live values
 * first, in the same turn, then the file (todo 137). A write that fails puts
 * the held text back and republishes; a write that lands settles the store's
 * watch past that one file, so it is never read back as somebody else's edit.
 * `mudengine-config` › *Configuration is YAML, watched, hot-reloaded*.
 */
import path from 'node:path';

import {
  applyEdit,
  ON_DISK,
  readYaml,
  removeYaml,
  writeYaml,
  type EditOptions,
  type EditResult,
  type YamlFiles
} from './YamlFile';
import { errorMessage } from '../../shared/values';
import type { Poller } from './Poller';

/** A store's files, which it can say are its own: what the settings editor routes by. */
export interface OwnedFiles extends YamlFiles {
  owns(file: string): boolean;
}

export class HeldFiles implements OwnedFiles {
  private texts = new Map<string, string>();

  /**
   * `owns` says which files are the store's; `republish` resolves its values
   * again from the held texts and emits its `change`, synchronously, without
   * reading the disk.
   */
  constructor(
    private readonly poller: Poller,
    readonly owns: (file: string) => boolean,
    private readonly republish: () => void
  ) {}

  /** Replaces everything held with what the store has just read from disk. */
  replace(texts: ReadonlyMap<string, string>): void {
    this.texts = new Map(texts);
  }

  /** Every file held, sorted. */
  get files(): string[] {
    return [...this.texts.keys()].sort();
  }

  /** Each held file with the directory it is in, by that directory's name: a character's or a realm's id. */
  byDirectory(): { file: string; id: string }[] {
    return this.files
      .map((file) => ({ file, id: path.basename(path.dirname(file)) }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * The held text; for a file the store holds none of (one that appeared
   * since its last check, or one it could not read), what is on disk, null
   * when there is nothing, and a throw when it cannot be read.
   */
  read(file: string): string | null {
    const held = this.texts.get(file);
    if (held !== undefined) return held;
    const disk = readYaml(file);
    if (!disk.ok) throw new Error(disk.error);
    return disk.text;
  }

  edit(file: string, options: EditOptions): EditResult {
    const before = this.before(file);
    if (!before.ok) return before;
    const edited = applyEdit(file, before.text, options);
    if (!edited.ok) return edited;
    // Nothing changed: no republish and no write, so a save that lists every
    // loop writes only the loops it changed (todo 854: 423 unchanged edits took 7.3 s).
    if (edited.text === before.text) return { ok: true };
    return this.swap(file, before.text, edited.text, () => writeYaml(file, edited.text));
  }

  remove(file: string): EditResult {
    const before = this.before(file);
    if (!before.ok) return before;
    return this.swap(file, before.text, null, () => removeYaml(file));
  }

  /** What an edit starts from: never an empty document in place of a file that could not be read. */
  private before(file: string): { ok: true; text: string | null } | { ok: false; error: string } {
    const held = this.texts.get(file);
    return held !== undefined ? { ok: true, text: held } : readYaml(file);
  }

  /*
   * A landed write settles the one file it wrote: one `stat`, so an edit costs
   * what it wrote and no listing, and every other file keeps the stamp it was
   * read at, so a hand edit to one of them still reloads. A listener that
   * throws on the new values stops the write: nothing is written that the
   * client could not take in.
   */
  private swap(
    file: string,
    before: string | null,
    after: string | null,
    write: () => EditResult
  ): EditResult {
    this.hold(file, after);
    try {
      this.republish();
    } catch (error) {
      this.hold(file, before);
      this.republish();
      return { ok: false, error: `could not apply the change: ${errorMessage(error)}` };
    }
    const written = write();
    if (written.ok) {
      this.poller.settleFile(file);
    } else {
      this.hold(file, before);
      this.republish();
    }
    return written;
  }

  private hold(file: string, text: string | null): void {
    if (text === null) this.texts.delete(file);
    else this.texts.set(file, text);
  }
}

/**
 * One door onto every store's files: each read and write goes to the store
 * that owns the file, and a file none holds is read and written on disk.
 */
export function routeFiles(owners: readonly OwnedFiles[]): YamlFiles {
  const ownerOf = (file: string): YamlFiles => owners.find((owner) => owner.owns(file)) ?? ON_DISK;
  return {
    read: (file) => ownerOf(file).read(file),
    edit: (file, options) => ownerOf(file).edit(file, options),
    remove: (file) => ownerOf(file).remove(file)
  };
}
