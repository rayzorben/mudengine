import { asLoops, type Loop } from '../../shared/loops';
import { ShippedList } from './ShippedList';

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
export class LoopCatalogue extends ShippedList<Loop> {
  constructor(file: string) {
    super(file, 'loops', asLoops);
  }
}
