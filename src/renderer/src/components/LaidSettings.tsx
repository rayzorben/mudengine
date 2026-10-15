/**
 * Above a character's settings, while an extension has its own values in force
 * over the player's (todo 118): one line per extension naming each setting and
 * the value in force, so the field below is not read as the one acting.
 */
import { laidSays } from '../lib/liveSheet';
import type { LaidSetting } from '@shared/extensions';

export default function LaidSettings({ laid }: { laid: readonly LaidSetting[] }) {
  return laidSays(laid).map((line) => (
    <p className="settings-warn" key={line}>
      {line}
    </p>
  ));
}
