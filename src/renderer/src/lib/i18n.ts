/**
 * The renderer's copy of the UI dictionary, loaded once at startup.
 *
 * `locales/ui.en.yaml` is inlined into the bundle as its parsed value
 * (`scripts/lib/yaml-module.mjs`), so there is no file read, no YAML parse,
 * no IPC round trip and no async gap: the words exist before the first
 * render, which is what lets `t` be a plain import instead of a
 * context threaded through every component. A single static dictionary needs
 * none of the machinery a switchable locale would — and building that
 * machinery for a locale that cannot be switched would be dead weight the
 * moment it shipped.
 *
 * A file that will not parse fails the build. One whose values are not all
 * strings falls back to an empty one rather than throwing: every string then
 * renders as its own key, visibly broken, loudly reported, and still leaving
 * the client usable enough to see what happened.
 * `i18n-coverage.test.ts` keeps that state from ever shipping.
 */
import { asUiDict, makeT, type UiDict } from '@shared/i18n';
import source from '../../../../locales/ui.en.yaml';

function loadDict(): UiDict {
  const dict = asUiDict(source);
  if (dict === null) {
    console.error('[ui copy] locales/ui.en.yaml is not a dictionary of strings');
    return {};
  }
  return dict;
}

export const t = makeT(loadDict(), (problem) => console.error(`[ui copy] ${problem}`));
