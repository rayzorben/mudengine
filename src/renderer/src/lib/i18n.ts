/**
 * The renderer's copy of the UI dictionary, loaded once at startup.
 *
 * `?raw` inlines `locales/ui.en.yaml` into the bundle at build time, so there
 * is no file read, no IPC round trip and no async gap: the words exist before
 * the first render, which is what lets `t` be a plain import instead of a
 * context threaded through every component. A single static dictionary needs
 * none of the machinery a switchable locale would — and building that
 * machinery for a locale that cannot be switched would be dead weight the
 * moment it shipped.
 *
 * A dictionary that fails to parse falls back to an empty one rather than
 * throwing: every string then renders as its own key — visibly broken, loudly
 * reported, and still leaving the client usable enough to see what happened.
 * `i18n-coverage.test.ts` keeps that state from ever shipping.
 */
import { parse } from 'yaml';
import { asUiDict, makeT, type UiDict } from '@shared/i18n';
import source from '../../../../locales/ui.en.yaml?raw';

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
