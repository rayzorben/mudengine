/**
 * The main process's copy of the UI dictionary, loaded once at startup.
 *
 * Main composes user-facing sentences of its own — connection notices, walk
 * and safety reports, migration announcements, the quit dialog — and they are
 * copy like any label in the renderer, so they come from the same
 * `locales/ui.en.yaml`. The import is the file's value, parsed when the
 * chunk is built (`scripts/lib/yaml-module.mjs`), so there is no runtime file
 * to resolve and no YAML parse at launch; a file that will not parse fails
 * the build.
 *
 * A dictionary whose values are not all strings falls back to an empty one
 * rather than refusing to boot: every string then renders as its own key,
 * visibly broken and loudly reported, with the client still able to connect.
 * The coverage test keeps that state from shipping; see
 * `src/renderer/src/lib/i18n.ts` for the renderer's identical decision.
 */
import { asUiDict, makeT, rendersFrom, type UiDict } from '../../shared/i18n';
import source from '../../../locales/ui.en.yaml';

function loadDict(): UiDict {
  const dict = asUiDict(source);
  if (dict === null) {
    console.error('[ui copy] locales/ui.en.yaml is not a dictionary of strings');
    return {};
  }
  return dict;
}

export const t = makeT(loadDict(), (problem) => console.error(`[ui copy] ${problem}`));

/**
 * Whether `text` is a sentence `key` renders, whatever filled it. A key with no
 * copy recognises nothing and is reported once by `t`, never thrown: a broken
 * dictionary still boots (above).
 */
export function isSaidBy(key: string, text: string): boolean {
  const template = t(key);
  return template !== key && rendersFrom(template, text);
}
