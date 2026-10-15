/**
 * The door a console's gear opens onto the settings screen (todo 119): a
 * character and the decision whose settings it narrows to. Which settings
 * those are is `fieldSettingsOf` (`@shared/decisionSettings`, todo 118); each
 * field names the setting it edits (`FormField`'s `setting`), so the screen
 * finds them by `data-setting`.
 */
import type { DecisionKind } from '@shared/decisionSettings';
import type { SessionId } from '@shared/ipc';

/** A character's settings, opened on what decided one line in its console. */
export interface SettingsFocus {
  character: SessionId;
  decision: DecisionKind;
}

/** What the settings screen opens on: a character or a page by name, a decision, or wherever it was. */
export type SettingsDoor = string | SettingsFocus | null;

/** The character or page a door names, or null for wherever it was. */
export function doorTarget(door: SettingsDoor): string | null {
  return door !== null && typeof door === 'object' ? door.character : door;
}

/** The decision a door opens on, the same object while the door is. */
export function doorFocus(door: SettingsDoor): SettingsFocus | null {
  return door !== null && typeof door === 'object' ? door : null;
}
