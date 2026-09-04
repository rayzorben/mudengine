/**
 * Serves `<file>?raw` imports to Node the way Vite serves them to the bundle.
 *
 * `src/main/app/i18n.ts` inlines `locales/ui.en.yaml` with a `?raw` import so
 * the built main chunk carries the dictionary and reads no file at runtime.
 * Node has no such thing: under `tsx` the import resolved and then died at
 * load with `ERR_UNKNOWN_FILE_EXTENSION ".yaml"` — which took every probe in
 * `scripts/` down with it the day the dictionary was extracted, because each
 * one imports `SessionManager` and `SessionManager` speaks. A hook, and not a
 * change to how main loads the file: the bundle's way is right for the bundle,
 * and the scripts are the only other place the source is executed unbundled.
 *
 * Synchronous, for `module.registerHooks` (`register` is deprecated from Node
 * 23): `resolve` strips the query, lets the chain find the file, and puts the
 * query back; `load` answers the marked URL with the file's text as a default
 * export.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAW = '?raw';

export function resolve(specifier, context, next) {
  if (!specifier.endsWith(RAW)) return next(specifier, context);
  const resolved = next(specifier.slice(0, -RAW.length), context);
  return { ...resolved, url: `${resolved.url}${RAW}`, shortCircuit: true };
}

export function load(url, context, next) {
  if (!url.endsWith(RAW)) return next(url, context);
  const text = readFileSync(fileURLToPath(url.slice(0, -RAW.length)), 'utf8');
  return {
    format: 'module',
    source: `export default ${JSON.stringify(text)};`,
    shortCircuit: true
  };
}
