/**
 * The main process's copy of the UI dictionary, loaded once at startup.
 *
 * Main composes user-facing sentences of its own — connection notices, walk
 * and safety reports, migration announcements, the quit dialog — and they are
 * copy like any label in the renderer, so they come from the same
 * `locales/ui.en.yaml`. `?raw` inlines the file into the built main chunk, the
 * way `electron.vite.config.ts` already bundles `yaml` itself, so there is no
 * runtime file to resolve and nothing to go missing from a packaged build.
 *
 * A dictionary that fails to parse falls back to an empty one rather than
 * refusing to boot: every string then renders as its own key — visibly broken
 * and loudly reported, with the client still able to connect. The coverage
 * test keeps that state from shipping; see `src/renderer/src/lib/i18n.ts` for
 * the renderer's identical decision.
 */
import { parse } from 'yaml';
import { asUiDict, makeT, type UiDict } from '../../shared/i18n';
import source from '../../../locales/ui.en.yaml?raw';

function loadDict(): UiDict {
  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (error) {
    console.error('[ui copy] locales/ui.en.yaml does not parse:', error);
    return {};
  }
  const dict = asUiDict(parsed);
  if (dict === null) {
    console.error('[ui copy] locales/ui.en.yaml is not a dictionary of strings');
    return {};
  }
  return dict;
}

export const t = makeT(loadDict(), (problem) => console.error(`[ui copy] ${problem}`));
