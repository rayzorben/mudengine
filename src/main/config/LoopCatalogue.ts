import fs from 'node:fs';
import { parse } from 'yaml';

import { asLoops, type Loop } from '../../shared/loops';
import { errorMessage } from '../../shared/values';

/**
 * The loops the client ships, ready to be copied into a character.
 *
 * `resources/loops/megamud.yaml` is 420 of MegaMUD's own 488 recorded paths,
 * replayed through the shipped realm data by `npm run build:loops` and reduced
 * to the fewest waypoints whose routes reproduce each loop exactly (see
 * docs/mega-paramud.md). It is the shelf, not a character's own list: nothing
 * here runs, and nothing here is a setting until somebody puts it in a profile.
 *
 * Three things this exists to get right:
 *
 * - **It is read through the same parser the options file goes through.**
 *   `asLoops` decides what a loop is in exactly one place, so a loop chosen
 *   from the catalogue and one typed into YAML by hand cannot mean different
 *   things — and a shipped file that has gone wrong loses the entries that are
 *   wrong rather than the whole shelf.
 * - **It is read once and kept.** Four hundred loops parsed on every keypress
 *   in a search field is the CoffeeScript engine's per-line SQLite query by
 *   another name. The file is shipped inside the application and changes only
 *   when the application does.
 * - **A missing file is empty and says so, once.** The catalogue is a
 *   convenience; a package that lost it must still let somebody write a loop by
 *   hand, so this never throws at the window that asked.
 */
export class LoopCatalogue {
  private loaded: Loop[] | null = null;

  constructor(private readonly file: string) {}

  /** Every shipped loop, in the order the file lists them. */
  all(): Loop[] {
    if (this.loaded !== null) return this.loaded;
    this.loaded = this.read();
    return this.loaded;
  }

  private read(): Loop[] {
    let source: string;
    try {
      source = fs.readFileSync(this.file, 'utf8');
    } catch {
      // Not an error worth a dialog: the shelf is empty, the Movement tab says
      // so, and a hand-written loop still works.
      console.warn(`loops: no catalogue at ${this.file}`);
      return [];
    }

    try {
      const document = parse(source) as unknown;
      const loops = asLoops(
        typeof document === 'object' && document !== null
          ? (document as Record<string, unknown>)['loops']
          : undefined
      );
      if (loops.length === 0) console.warn(`loops: ${this.file} defines none`);
      return loops;
    } catch (error) {
      console.warn(`loops: ${this.file} would not parse: ${errorMessage(error)}`);
      return [];
    }
  }
}
