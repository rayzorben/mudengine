/**
 * Finding the extensions installed in the home (todo 84): every folder under
 * `extensions/` holding a `manifest.json` that names it, and the ES module
 * the manifest points at, imported once at startup. A folder that is not an
 * extension is passed over; one that claims to be and cannot load is said,
 * never a crash, and the client carries on without it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { t } from '../app/i18n';
import { isWithin } from '../app/browse';
import { asManifest, type ExtensionManifest } from '../../shared/extensions';
import { errorMessage } from '../../shared/values';
import type { Extension } from './api';

export interface LoadedExtension {
  manifest: ExtensionManifest;
  /** The extension's own folder, symbolic links followed. */
  dir: string;
  module: Extension;
}

function isExtension(value: unknown): value is Extension {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { session?: unknown }).session === 'function'
  );
}

/** One folder's extension, or why it is not one; null for a folder that does not claim to be. */
async function loadOne(dir: string): Promise<LoadedExtension | string | null> {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) return null;
  const folder = path.basename(dir);
  let manifest: ExtensionManifest | null;
  try {
    manifest = asManifest(JSON.parse(fs.readFileSync(file, 'utf8')), folder);
  } catch (error) {
    return t('extensions.badManifest', { name: folder, error: errorMessage(error) });
  }
  if (manifest === null) return t('extensions.notAManifest', { name: folder });
  const real = fs.realpathSync(dir);
  const main = path.resolve(real, manifest.main);
  // A manifest naming a file outside its own folder is not loaded.
  if (!isWithin(real, main) || !fs.existsSync(main)) {
    return t('extensions.noMain', { name: folder, file: manifest.main });
  }
  try {
    const module = (await import(pathToFileURL(main).href)) as Record<string, unknown>;
    const found = isExtension(module) ? module : module['default'];
    if (!isExtension(found)) return t('extensions.notAnExtension', { name: folder });
    return { manifest, dir: real, module: found };
  } catch (error) {
    return t('extensions.loadFailed', { name: folder, error: errorMessage(error) });
  }
}

/**
 * Every extension under `root`, in folder order, and what was said about the
 * folders that failed. An absent `root` is no extensions and nothing said.
 */
export async function loadExtensions(
  root: string
): Promise<{ loaded: LoadedExtension[]; problems: string[] }> {
  const loaded: LoadedExtension[] = [];
  const problems: string[] = [];
  if (!fs.existsSync(root)) return { loaded, problems };
  const folders = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    const result = await loadOne(path.join(root, folder));
    if (result === null) continue;
    if (typeof result === 'string') problems.push(result);
    else loaded.push(result);
  }
  return { loaded, problems };
}

/**
 * A file of an extension's card page, or null where the path leaves the
 * page's folder or names nothing there. What both the window's `mudext:`
 * scheme and web mode's `/ext/` route serve from.
 */
export function pageFile(
  extensions: readonly LoadedExtension[],
  name: string,
  relative: string
): string | null {
  const found = extensions.find((each) => each.manifest.name === name);
  if (found === undefined || found.manifest.ui === undefined) return null;
  const root = path.resolve(found.dir, found.manifest.ui);
  const file = path.resolve(root, relative.length === 0 ? 'index.html' : relative);
  if (!isWithin(root, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  // And not by a link out of it.
  return isWithin(fs.realpathSync(root), fs.realpathSync(file)) ? file : null;
}
