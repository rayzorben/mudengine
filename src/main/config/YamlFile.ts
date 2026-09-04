import fs from 'node:fs';
import path from 'node:path';
import { parseDocument, type Document } from 'yaml';

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
 *   leave a truncated options file. Rename is safe here precisely because the
 *   config watcher is an owned poll rather than `fs.watch`, which loses a file
 *   on the first atomic save (see CLAUDE.md).
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

/**
 * Reads, edits, verifies and replaces one YAML file.
 *
 * Creates it from an empty document if it does not exist, so a first server or
 * first character does not need the file to have been made by hand.
 */
export function editYaml(file: string, options: EditOptions): EditResult {
  let source = '';
  const exists = fs.existsSync(file);
  if (exists) {
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (error) {
      return { ok: false, error: `could not read ${path.basename(file)}: ${reason(error)}` };
    }
  }

  const document = parseDocument(source);
  if (document.errors.length > 0) {
    /*
     * Refuse rather than overwrite. A file that does not parse is a file
     * somebody is halfway through editing, or one an earlier bug damaged;
     * either way the comments and values in it are the only copy, and replacing
     * it with a document built from the parts that did parse throws away the
     * rest without asking.
     */
    return {
      ok: false,
      error:
        `${path.basename(file)} does not parse, so it will not be edited: ` +
        `${document.errors[0]?.message ?? 'unknown error'}`
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
      return { ok: false, error: `the change would not parse back: ${round.errors[0]?.message}` };
    }
    const complaint = options.verify(round.toJS() ?? {});
    if (complaint !== null) return { ok: false, error: complaint };
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // One rolling backup, taken from what is on disk right now.
    if (exists) fs.copyFileSync(file, `${file}.bak`);
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, file);
  } catch (error) {
    return { ok: false, error: `could not save ${path.basename(file)}: ${reason(error)}` };
  }

  return { ok: true };
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
 * The message from a thrown value, without assuming it is an `Error`.
 *
 * Never interpolates the value itself: these paths run with a password in
 * scope, and a thrown object that stringifies to its own contents is exactly
 * how one ends up in a log.
 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
