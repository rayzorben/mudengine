/**
 * The client's own mark (`ui.showLogo`), at the head of the character tabs and
 * the size of a character's circle, so on the hidden rail it sits above the
 * circles. Its tooltip carries the name, version, commit and build time, from
 * the same `package.json` and stamp main reports (`appVersion`).
 */
import { t } from '../lib/i18n';
import { version } from '../../../../package.json';
import { BUILD, versionWithCommit } from '@shared/build';

const MARK_NAME = t('app.windowTitle');
const FULL_VERSION = versionWithCommit(version, BUILD, t);

/** Fixed for the life of the window. */
const MARK_TOOLTIP =
  BUILD.builtAt === null
    ? t('app.markTooltip', { name: MARK_NAME, version: FULL_VERSION })
    : t('app.markTooltipBuilt', {
        name: MARK_NAME,
        version: FULL_VERSION,
        built: new Date(BUILD.builtAt).toLocaleString()
      });

export default function AppMark() {
  return <span className="app-mark" role="img" aria-label={MARK_NAME} title={MARK_TOOLTIP} />;
}
