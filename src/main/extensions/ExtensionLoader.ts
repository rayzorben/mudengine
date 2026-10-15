/**
 * Finding the extensions installed in the home (todo 84): every folder under
 * `extensions/` holding a `manifest.json` that names it, and the ES module
 * the manifest points at, imported once at startup unless the options file's
 * `extensions:` switches it off (todo 118). A folder that is not an
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

/**
 * One folder's extension; its manifest alone where the player switched it off,
 * so its code is never imported; why it is not one; or null for a folder that
 * does not claim to be.
 */
async function loadOne(
  dir: string,
  on: (name: string) => boolean
): Promise<LoadedExtension | ExtensionManifest | string | null> {
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
  if (!on(manifest.name)) return manifest;
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

/** What startup found under the extensions folder. */
export interface FoundExtensions {
  loaded: LoadedExtension[];
  /** Installed and switched off in the options file (`extensions:`), never imported. */
  off: ExtensionManifest[];
  /** What was said about the folders that failed. */
  problems: string[];
}

/**
 * Every extension under `root`, in folder order: those `on` answers yes for
 * loaded, the rest named and left alone. An absent `root` is no extensions and
 * nothing said.
 */
export async function loadExtensions(
  root: string,
  on: (name: string) => boolean
): Promise<FoundExtensions> {
  const loaded: LoadedExtension[] = [];
  const off: ExtensionManifest[] = [];
  const problems: string[] = [];
  if (!fs.existsSync(root)) return { loaded, off, problems };
  const folders = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    const result = await loadOne(path.join(root, folder), on);
    if (result === null) continue;
    if (typeof result === 'string') problems.push(result);
    else if ('module' in result) loaded.push(result);
    else off.push(result);
  }
  return { loaded, off, problems };
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
