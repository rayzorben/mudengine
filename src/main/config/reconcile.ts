/**
 * Keeps the options file in step with the template it was copied from.
 *
 * The template is copied once, on first run, and never again — so every
 * setting added to it afterwards used to be invisible in an existing file.
 * Defaults still applied, so nothing broke; but a setting nobody can see is a
 * setting nobody uses, which is how automatic login shipped, was verified, and
 * still looked completely broken.
 *
 * The client used to *report* that gap on every reload — "your options file
 * predates these settings" — which is a complaint rather than a fix, and it
 * repeated for as long as the file stayed behind. Worse, it went on naming
 * blocks that had deliberately *left* the file: `servers:` moved out into
 * directories of its own, so a correct, current file was told every few
 * seconds that it was out of date.
 *
 * So the gap is closed instead of announced. Any top-level block the template
 * states and the file does not is copied across, **with the comments that
 * explain it**, because in this project the template is the documentation.
 * There is nothing left to report on the next launch, which is the difference
 * between parity and a notice.
 *
 * Three things it will not do:
 *
 * - **Touch a block that is already there.** The value is the user's, however
 *   old, and a template that overwrote it would undo an edit somebody made on
 *   purpose. Only absence is filled.
 * - **Rewrite a file it could not read.** An unparseable file is one somebody
 *   is halfway through editing; `editYaml` refuses it rather than rebuilding
 *   it from the parts that did parse.
 * - **Reach inside a block.** A key missing from within `automation:` is not
 *   filled in, because merging two mappings comment by comment cannot tell an
 *   omission from a deliberate deletion, and a list the user pruned would grow
 *   back every launch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDocument, isMap, type Document } from 'yaml';

import { errorMessage } from '../../shared/values';
import { editYaml } from './YamlFile';

export interface Reconciliation {
  /** Top-level blocks copied in from the template, in template order. */
  added: string[];
  /** Why nothing was done, when something should have been. */
  error: string | null;
}

const NOTHING: Reconciliation = { added: [], error: null };

/**
 * Adds the template's missing top-level blocks to the user's options file.
 *
 * Returns what it did rather than reporting it, so the caller decides where
 * that is said — this runs before there is a window to say it in.
 */
export function reconcileWithTemplate(file: string, template: string): Reconciliation {
  if (!fs.existsSync(file) || !fs.existsSync(template)) return NOTHING;

  let shipped: Document;
  try {
    shipped = parseDocument(fs.readFileSync(template, 'utf8'));
  } catch (error) {
    // The template ships with the client; a package that cannot read its own
    // is a broken package and not something the user can fix.
    return {
      added: [],
      error: `could not read ${path.basename(template)}: ${errorMessage(error)}`
    };
  }
  if (!isMap(shipped.contents)) return NOTHING;

  let mine: Document;
  try {
    mine = parseDocument(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { added: [], error: `could not read ${path.basename(file)}: ${errorMessage(error)}` };
  }
  // A file that does not parse is somebody's only copy of their own notes and
  // credentials. `editYaml` refuses it too; claiming nothing is missing is how
  // that refusal is expressed here.
  if (mine.errors.length > 0 || !isMap(mine.contents)) return NOTHING;

  const missing = keysOf(shipped).filter((key) => !mine.has(key));
  if (missing.length === 0) return NOTHING;

  const added: string[] = [];
  const result = editYaml(file, {
    mutate: (document) => {
      for (const key of missing) {
        const node = shipped.get(key, true);
        if (node === undefined) continue;
        document.set(key, node);
        added.push(key);
      }
    }
  });

  if (!result.ok) return { added: [], error: result.error };
  return { added, error: null };
}

/** The top-level keys of a document, in the order the file states them. */
function keysOf(document: Document): string[] {
  if (!isMap(document.contents)) return [];
  return document.contents.items
    .map((item) => (item.key as { value?: unknown } | null)?.value)
    .filter((key): key is string => typeof key === 'string');
}
