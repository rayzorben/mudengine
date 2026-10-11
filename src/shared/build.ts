/**
 * Which commit this build was made from, stamped in when it is built
 * (`scripts/lib/build-stamp.mjs`), so a running client says what it holds.
 * Code run from source (tests, scripts) is unstamped and reads as unknown.
 */
import type { UiLookup } from './i18n';

export interface BuildStamp {
  /** The short hash of HEAD, or null where the build could not tell. */
  commit: string | null;
  /** Built with uncommitted changes to tracked files. */
  dirty: boolean;
  /** When it was built (ISO 8601), or null where unstamped. */
  builtAt: string | null;
}

declare const __BUILD_STAMP__: BuildStamp | undefined;

export const BUILD: BuildStamp =
  typeof __BUILD_STAMP__ === 'undefined'
    ? { commit: null, dirty: false, builtAt: null }
    : __BUILD_STAMP__;

/** The version with its commit, a dirty build marked `-dirty` as its Azure image tag is. */
export function versionWithCommit(version: string, stamp: BuildStamp, t: UiLookup): string {
  const commit =
    stamp.commit === null
      ? t('app.commitUnknown')
      : `${stamp.commit}${stamp.dirty ? '-dirty' : ''}`;
  return t('app.versionWithCommit', { version, commit });
}
