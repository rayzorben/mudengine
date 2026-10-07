/**
 * Serves `.yaml` imports to Node the way the Vite plugin serves them to the
 * bundle: as the parsed value (`yaml-module.mjs`).
 *
 * `src/main/app/i18n.ts` imports `locales/ui.en.yaml`, and every probe in
 * `scripts/` reaches it through `SessionManager`, which speaks. Under `tsx`
 * the import died with `ERR_UNKNOWN_FILE_EXTENSION ".yaml"`, so this hook
 * answers it. Synchronous, for `module.registerHooks` (`register` is
 * deprecated from Node 23).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isYaml, yamlModule } from './yaml-module.mjs';

export function load(url, context, next) {
  if (!isYaml(url)) return next(url, context);
  return {
    format: 'module',
    source: yamlModule(readFileSync(fileURLToPath(url), 'utf8')),
    shortCircuit: true
  };
}
