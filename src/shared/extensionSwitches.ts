/**
 * The `extensions:` block (todo 118): a switch per installed extension, keyed
 * by its folder's name. A name the block does not state is on, as every
 * installed extension loaded before the switch; a new folder is therefore
 * found and loaded with nothing to write, and the file only ever holds the
 * player's own answers. Read once at startup, so a change takes effect the
 * next time the client starts. Dependency-free, like the rest of `src/shared`.
 */
import { isRecord } from './values';

/** On or off per extension name; an absent name is on. */
export type ExtensionSwitches = Readonly<Record<string, boolean>>;

export const DEFAULT_EXTENSION_SWITCHES: ExtensionSwitches = {};

/** The block as read: every stated `name: true|false`; anything else is dropped. */
export function normalizeExtensionSwitches(raw: unknown): ExtensionSwitches {
  if (!isRecord(raw)) return DEFAULT_EXTENSION_SWITCHES;
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
  );
}

/** Whether the extension of this name is switched on: absent is on. */
export function extensionOn(switches: ExtensionSwitches, name: string): boolean {
  return switches[name] !== false;
}
