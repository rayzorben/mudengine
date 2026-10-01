/**
 * Extensions (todo 84): programs this client does not ship, found at startup
 * in the home's `extensions/<name>/` folder. What both processes share about
 * them: the manifest, what the window is told of each, and the settings one
 * lays over a character's own.
 */
import type { AutomationConfig } from './config';
import { isRecord } from './values';

/**
 * The scheme the desktop window loads an extension's card page from:
 * `mudext://<name>/index.html`. Web mode serves the same files at `/ext/<name>/`.
 */
export const EXTENSION_SCHEME = 'mudext';

/**
 * What an extension may be called: its folder's name, and the host part of
 * its page's address, which the window reads in lower case.
 */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** `extensions/<name>/manifest.json`. */
export interface ExtensionManifest {
  /** The folder's own name (lower case, digits and hyphens), and every key the extension is known by. */
  name: string;
  /** What its card is called. */
  title: string;
  /** Its main-process module, relative to the folder: an ES module exporting `session`. */
  main: string;
  /** The folder its card's page is in (with an `index.html`), relative to the folder; absent for no card. */
  ui?: string;
}

/** A manifest as read from disk, or null where it is not one. */
export function asManifest(value: unknown, folder: string): ExtensionManifest | null {
  if (!isRecord(value)) return null;
  const { name, title, main, ui } = value;
  if (name !== folder || typeof name !== 'string' || !NAME.test(name)) return null;
  if (typeof title !== 'string' || typeof main !== 'string') return null;
  if (ui !== undefined && typeof ui !== 'string') return null;
  return ui === undefined ? { name, title, main } : { name, title, main, ui };
}

/** What the window is told of an installed extension. */
export interface ExtensionInfo {
  name: string;
  title: string;
  /** Where its card's page is served, or null for none. */
  page: string | null;
}

/**
 * One setting under `automation` and its value: `[['combat', 'attack'], 'kic']`.
 * An extension lays a list of them over the character's settings while it
 * runs, and may write them into the character's file when the player keeps
 * them, so the two cannot disagree.
 */
export type LayerWrite = readonly [path: readonly string[], value: unknown];

/**
 * The table a path's last key is set in, where every key before it names a
 * table and the last names a setting the client has; else null. The one test
 * of whether a write is laid (`withLayer`) or written (`setAutomationValues`):
 * the settings' shape is the client's, and an extension does not grow it.
 */
function holderOf(
  config: AutomationConfig,
  path: readonly string[]
): Record<string, unknown> | null {
  const last = path[path.length - 1];
  if (last === undefined) return null;
  // Own keys only: `constructor` and `__proto__` are on every object and are no setting.
  let at: unknown = config;
  for (const key of path.slice(0, -1))
    at = isRecord(at) && Object.hasOwn(at, key) ? at[key] : undefined;
  return isRecord(at) && Object.hasOwn(at, last) ? at : null;
}

/** The writes naming a setting the client does not have: none is laid, and none may be kept. */
export function unknownWrites(
  config: AutomationConfig,
  writes: readonly LayerWrite[]
): LayerWrite[] {
  return writes.filter(([path]) => holderOf(config, path) === null);
}

/** The settings with the writes laid over them, a copy; a write `unknownWrites` names is skipped. */
export function withLayer(
  config: AutomationConfig,
  writes: readonly LayerWrite[]
): AutomationConfig {
  if (writes.length === 0) return config;
  const out = structuredClone(config);
  for (const [path, value] of writes) {
    const holder = holderOf(out, path);
    if (holder !== null) holder[path[path.length - 1]!] = structuredClone(value);
  }
  return out;
}
