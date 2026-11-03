import fs from 'node:fs';
import path from 'node:path';
import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  YAMLError,
  type Document,
  type YAMLSeq
} from 'yaml';
import { t } from '../app/i18n';

/**
 * Editing a YAML file the user owns.
 *
 * Every rule here exists because these files are *theirs*: written by hand,
 * commented, and the only record of credentials the client has. A settings
 * screen that rewrites one carelessly costs somebody their notes or their
 * account.
 *
 * - **`parseDocument`, never `parse` and re-`stringify`.** A round trip through
 *   plain objects discards every comment in the file, and the options template
 *   *is* the documentation — `default.yaml` explains each setting where it sits.
 *   Losing that turns a readable file into a bag of values.
 * - **Validate before writing, not after.** A save that produces a file the
 *   client cannot load is worse than a refused save: the watcher would pick it
 *   up, `normalizeConfig` would fall back to defaults, and a character would
 *   quietly start dialling somewhere else. The caller supplies the check.
 * - **One rolling backup per file.** Not one per save — that litters a
 *   directory the user opens — and not none, because these edits are the only
 *   ones the user did not make themselves.
 * - **Written to a temporary file and renamed.** A crash mid-write must not
 *   leave a truncated options file. The stores watch each file's directory,
 *   never the file, since a watch on the file is lost at the first rename
 *   (`Poller`).
 */
export type EditResult = { ok: true } | { ok: false; error: string };

export interface EditOptions {
  /**
   * Applied to the parsed document. Mutate it in place.
   *
   * Errors thrown here are reported rather than crashing: a settings screen
   * that takes down every character's socket because one field was odd is the
   * failure `guardTheProcess` exists to stop, and this is a place it is easy to
   * cause.
   */
  mutate(document: Document): void;
  /**
   * Reads back what the edit produced and says whether it is acceptable.
   *
   * Given the re-parsed *plain value*, so it checks what the client will
   * actually load rather than what the editor believes it wrote. Return an
   * error string to refuse the save and leave the file untouched.
   */
  verify?(value: unknown): string | null;
}

/** An edit applied to a file's text: the new text, or why it was refused. */
export type Edited = { ok: true; text: string } | { ok: false; error: string };

/**
 * Applies one edit to a file's text without touching the disk: parse, mutate,
 * stringify, verify. `source` null is a file that does not exist yet, edited
 * from an empty document, so a first server or first character does not need
 * the file to have been made by hand. A store applies it to the text it holds
 * (`HeldFiles`); `editYaml` to what is on disk.
 */
export function applyEdit(file: string, source: string | null, options: EditOptions): Edited {
  const document = parseDocument(source ?? '');
  const fault = document.errors[0] ?? document.warnings[0];
  if (fault !== undefined) {
    /*
     * Refuse rather than overwrite. A file that does not parse is a file
     * somebody is halfway through editing, or one an earlier bug damaged;
     * either way the comments and values in it are the only copy, and replacing
     * it with a document built from the parts that did parse throws away the
     * rest without asking.
     */
    return {
      ok: false,
      error: `${path.basename(file)} does not parse, so it will not be edited: ` + yamlFault(fault)
    };
  }

  try {
    options.mutate(document);
  } catch (error) {
    return { ok: false, error: `could not apply the change: ${reason(error)}` };
  }

  let text: string;
  try {
    text = String(document);
  } catch (error) {
    return { ok: false, error: `could not write the change out: ${reason(error)}` };
  }

  // What the client will actually load, read back from the text rather than
  // taken from the document that produced it.
  if (options.verify) {
    const round = parseDocument(text);
    if (round.errors.length > 0) {
      return { ok: false, error: `the change would not parse back: ${yamlFault(round.errors[0])}` };
    }
    const complaint = options.verify(round.toJS() ?? {});
    if (complaint !== null) return { ok: false, error: complaint };
  }
  return { ok: true, text };
}

/**
 * Writes a file's new text: one rolling backup of what is on disk now, then a
 * temporary file renamed over it. The backup is taken whenever the file
 * exists, whatever the caller believed, so a hand edit a store had not read
 * yet is still kept beside the file.
 */
export function writeYaml(file: string, text: string): EditResult {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, file);
  } catch (error) {
    return { ok: false, error: `could not save ${path.basename(file)}: ${reason(error)}` };
  }
  return { ok: true };
}

/** A file's text on disk, null when there is none, or why it could not be read. */
export function readYaml(
  file: string
): { ok: true; text: string | null } | { ok: false; error: string } {
  if (!fs.existsSync(file)) return { ok: true, text: null };
  try {
    return { ok: true, text: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    return { ok: false, error: `could not read ${path.basename(file)}: ${reason(error)}` };
  }
}

/**
 * Reads, edits, verifies and replaces one YAML file on disk, for a writer that
 * runs before any store holds it (migrations, `reconcileWithTemplate`) or
 * with none running.
 */
export function editYaml(file: string, options: EditOptions): EditResult {
  const read = readYaml(file);
  if (!read.ok) return read;
  const edited = applyEdit(file, read.text, options);
  if (!edited.ok) return edited;
  // Unchanged text is not written, so the one rolling backup stays the last real edit's.
  return edited.text === read.text ? { ok: true } : writeYaml(file, edited.text);
}

/**
 * Removes a file, keeping one copy of it.
 *
 * Deleting a character is a click, and the file may hold the only record of a
 * password. The backup is what makes the click reversible.
 */
export function removeYaml(file: string): EditResult {
  if (!fs.existsSync(file)) return { ok: false, error: `${path.basename(file)} is already gone` };
  try {
    fs.copyFileSync(file, `${file}.bak`);
    fs.unlinkSync(file);
  } catch (error) {
    return { ok: false, error: `could not remove ${path.basename(file)}: ${reason(error)}` };
  }
  return { ok: true };
}

/**
 * Where the settings editor reads and writes a file the client owns: through
 * the store that holds it, so the live value changes before the file does
 * (todo 137), or straight on disk when no store is running.
 */
export interface YamlFiles {
  /** The file's text as its owner holds it, null when there is none; throws when unreadable. */
  read(file: string): string | null;
  edit(file: string, options: EditOptions): EditResult;
  remove(file: string): EditResult;
}

/** The files as they are on disk, for a caller with no store running. */
export const ON_DISK: YamlFiles = {
  read: (file) => {
    const read = readYaml(file);
    if (!read.ok) throw new Error(read.error);
    return read.text;
  },
  edit: editYaml,
  remove: removeYaml
};

/**
 * `document.setIn(at, value)` for a plain value, keeping every node that
 * survives it.
 *
 * `setIn` with an object or a list builds a new node and drops the old one with
 * every comment inside it: a save of the Global page took most of the options
 * template's notes. Here a map that is already there is patched key by key (a
 * key the value lacks or leaves `undefined` is removed, as `setIn` would) and a
 * list row by row (`keepRows`), down to the scalars, which `setIn` updates in
 * place with their comments and quoting. The value read back is the same as
 * `setIn`'s. A `Node` is set as given, being already styled by its writer.
 */
export function setKeeping(document: Document, at: readonly unknown[], value: unknown): void {
  const node = document.getIn(at, true);
  if (isMap(node) && isPlainRecord(value)) {
    for (const pair of [...node.items]) {
      const key = isScalar(pair.key) ? pair.key.value : pair.key;
      if (typeof key !== 'string' || value[key] === undefined) node.delete(pair.key);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) setKeeping(document, [...at, key], entry);
    }
    return;
  }
  if (isSeq(node) && Array.isArray(value)) {
    keepRows(document, at, node, value);
    return;
  }
  document.setIn([...at], value);
}

/**
 * A list written row by row, each row the file had kept with its comment
 * where it goes. A row the list still says exactly is the same node, wherever
 * it moved; a changed row is patched in place when its position held a row
 * nothing else claimed; anything else is a new row. A row inserted, removed or
 * moved above another leaves that row's comment on it.
 */
function keepRows(
  document: Document,
  at: readonly unknown[],
  node: YAMLSeq,
  value: readonly unknown[]
): void {
  const old = node.items;
  // Each row's text to the positions saying it, earliest first, so a match is one lookup.
  const said = new Map<string, number[]>();
  old.forEach((item, index) => {
    const text = JSON.stringify(isNode(item) ? item.toJSON() : item);
    const at = said.get(text);
    if (at === undefined) said.set(text, [index]);
    else at.push(index);
  });
  const claimed = new Set<number>();
  const same = value.map((entry) => {
    const found = said.get(JSON.stringify(entry))?.shift() ?? -1;
    if (found >= 0) claimed.add(found);
    return found;
  });
  const patched: number[] = [];
  node.items = value.map((entry, index) => {
    const found = same[index] ?? -1;
    if (found >= 0) return old[found];
    if (index < old.length && !claimed.has(index)) {
      claimed.add(index);
      patched.push(index);
      return old[index];
    }
    return document.createNode(entry);
  });
  for (const index of patched) setKeeping(document, [...at, index], value[index]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isNode(value);
}

/**
 * The value of a file the user owns, or a throw `yamlFault` can say.
 *
 * `parse` prints a warning to stderr with the line it is about, and reads on
 * past it: `password: !hunter2` is a tag nobody defined, printed whole, and
 * read as an empty password. A warning is refused here like an error, so the
 * file is reported by place and no value it changed is used.
 */
export function parseOwned(text: string): unknown {
  const document = parseDocument(text);
  const fault = document.errors[0] ?? document.warnings[0];
  if (fault !== undefined) throw fault;
  return document.toJS();
}

/**
 * Why a file the user owns could not be read, said by place alone when YAML
 * refused it.
 *
 * A YAML error's message quotes the source: the line it failed on, and in
 * some messages the text itself (`Invalid escape sequence \q`). In a
 * character's file that line can be the password, typed by hand with an `@`
 * or a `: ` in it, and the message goes to a notice, stdout and the settings
 * screen. Line and column are enough to find it.
 */
export function yamlFault(error: unknown): string {
  if (!(error instanceof YAMLError)) return error === undefined ? 'unknown error' : reason(error);
  const at = error.linePos?.[0];
  return at === undefined
    ? t('errors.yaml.unplaced')
    : t('errors.yaml.at', { line: at.line, col: at.col });
}

/**
 * The message from a thrown value, without assuming it is an `Error`.
 *
 * Never interpolates the value itself: these paths run with a password in
 * scope, and a thrown object that stringifies to its own contents is exactly
 * how one ends up in a log.
 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
