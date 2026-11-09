/**
 * The auto-drop list (`automation.drop.items`) read and changed one item at a
 * time: by `AutoDrop`, which sheds what it names, by the item panel's
 * Auto-drop choice and by the pack rewrite's `{item.action.autoDrop}`. One
 * reading, so the panel, the console and the drop cannot disagree about a
 * name. `mudengine-automation` › `parts/gear.md`.
 */
import { bareName } from './items';
import { nameAnswersTo } from './world';

/**
 * Whether the list names this thing. An entry is a prefix matched by the
 * server's rule for a typed name (`nameAnswersTo`), because the `drop` it
 * leads to is read by that rule on the other end.
 */
export function dropListNames(list: readonly string[], name: string): boolean {
  const carried = bareName(name);
  return list.some((entry) => nameAnswersTo(carried, bareName(entry)));
}

/**
 * The list with this thing put on or taken off.
 *
 * On adds the realm's spelling only when no entry names it already, so a
 * second click writes nothing. Off removes every entry the thing answers to,
 * since leaving one would keep dropping it.
 */
export function withDropped(list: readonly string[], name: string, on: boolean): string[] {
  if (on) return dropListNames(list, name) ? [...list] : [...list, name.trim()];
  const carried = bareName(name);
  return list.filter((entry) => !nameAnswersTo(carried, bareName(entry)));
}
