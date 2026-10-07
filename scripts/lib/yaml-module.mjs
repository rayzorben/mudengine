/**
 * A `.yaml` import is its parsed value, parsed when the module is built.
 *
 * `locales/ui.en.yaml` is the one such import (`src/main/app/i18n.ts`,
 * `src/renderer/src/lib/i18n.ts`). Parsing its 300 KB with `yaml` cost each
 * side about 200ms of every launch (2026-10-06); `JSON.parse` of the same
 * value is a few. One function, used by the Vite plugin (the bundle and the
 * tests), by the Node hook (`yaml-hook.mjs`, the scripts) and by an esbuild
 * plugin (an extension's own build), so all of them agree on what the import is. A file that does not parse fails the build.
 */
import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';

/** What a YAML file is called; no `g` flag, so a test keeps no state. */
const YAML_FILE = /\.ya?ml$/;

/**
 * A `.yaml` module: the dev server's own queries (`?import`, `?t=` on a hot
 * update) included, an asset query (`?raw`, `?url`) not.
 */
export function isYaml(id) {
  const [file = '', query = ''] = id.split('?');
  return YAML_FILE.test(file) && !/(^|&)(raw|url|inline)(=|&|$)/.test(query);
}

/** The module source for a YAML file's text. */
export function yamlModule(text) {
  return `export default JSON.parse(${JSON.stringify(JSON.stringify(parse(text)))});`;
}

/** The Vite plugin: every bare `.yaml` import becomes its value. */
export function yamlPlugin() {
  return {
    name: 'mudengine-yaml-module',
    transform(code, id) {
      return isYaml(id) ? { code: yamlModule(code), map: null } : null;
    }
  };
}

/** The esbuild plugin, for a build that bundles these sources outside Vite. */
export function yamlEsbuildPlugin() {
  return {
    name: 'mudengine-yaml-module',
    setup(build) {
      build.onLoad({ filter: YAML_FILE }, async (args) => ({
        contents: yamlModule(await readFile(args.path, 'utf8')),
        loader: 'js'
      }));
    }
  };
}
