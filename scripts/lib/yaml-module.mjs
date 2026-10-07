/**
 * A `.yaml` import is its parsed value, parsed when the module is built.
 *
 * `locales/ui.en.yaml` is the one such import (`src/main/app/i18n.ts`,
 * `src/renderer/src/lib/i18n.ts`). Parsing its 300 KB with `yaml` cost each
 * side about 200ms of every launch (2026-10-06); `JSON.parse` of the same
 * value is a few. One function, used by the Vite plugin (the bundle and the
 * tests) and by the Node hook (`yaml-hook.mjs`, the scripts), so the bundle,
 * the tests and the scripts agree on what the import is. A file that does not parse fails the build.
 */
import { parse } from 'yaml';

/**
 * A `.yaml` module: the dev server's own queries (`?import`, `?t=` on a hot
 * update) included, an asset query (`?raw`, `?url`) not.
 */
export function isYaml(id) {
  const [file = '', query = ''] = id.split('?');
  return /\.ya?ml$/.test(file) && !/(^|&)(raw|url|inline)(=|&|$)/.test(query);
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
