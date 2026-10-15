/**
 * What the settings screen reads off a character in the realm: the maxima its
 * percentages are of, the two facts that decide whether `pickLocks` and
 * `useMeditate` act (todo 50), and the settings an extension has in force over
 * the character's own (todo 118). Read off the live view, never the settings
 * snapshot, and all null (none laid) for a character that is not in the realm.
 */
import { holdsMeditate } from '@shared/abilities';
import type { AutomationSnapshot } from '@shared/automation';
import type { CharacterState } from '@shared/character';
import type { LaidSetting } from '@shared/extensions';
import { holdsPicklocks } from '@shared/walk';
import { t } from './i18n';

export interface LiveSheet {
  hpMax: number | null;
  manaMax: number | null;
  /** The stat sheet's `Picklocks`. */
  picklocks: number | null;
  /** Whether an `abil` list shows Meditate (`holdsMeditate`). */
  meditate: boolean | null;
  /** What extensions have in force over the character's own settings. */
  laid: readonly LaidSetting[];
}

export const NO_SHEET: LiveSheet = {
  hpMax: null,
  manaMax: null,
  picklocks: null,
  meditate: null,
  laid: []
};

export function liveSheetOf(
  view: { character: CharacterState; automation: AutomationSnapshot } | undefined
): LiveSheet {
  if (view === undefined) return NO_SHEET;
  const { character, automation } = view;
  return {
    hpMax: character.vitals.hpMax,
    manaMax: character.vitals.manaMax,
    picklocks: character.progress.picklocks,
    meditate: holdsMeditate(character.abilities),
    laid: automation.laid
  };
}

/** The settings each extension has in force, one sentence per extension. */
export function laidSays(laid: readonly LaidSetting[]): string[] {
  const by = new Map<string, string[]>();
  for (const { by: title, path, value } of laid) {
    const shown = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
    by.set(title, [
      ...(by.get(title) ?? []),
      t('settings.extensions.laidSetting', { path, value: shown })
    ]);
  }
  return [...by].map(([title, settings]) =>
    t('settings.extensions.laid', { title, settings: settings.join(', ') })
  );
}

/** Which way `pickLocks` goes for this character, and why. */
export function picklocksSays(picklocks: number | null): string {
  const holds = holdsPicklocks(picklocks);
  if (holds === null) return t('settings.movement.picklocksSays.unknown');
  return holds
    ? t('settings.movement.picklocksSays.held', { figure: String(picklocks) })
    : t('settings.movement.picklocksSays.lacking');
}

/** Which way `useMeditate` goes for this character, and why. */
export function meditateSays(meditate: boolean | null): string {
  if (meditate === null) return t('settings.health.meditateSays.unknown');
  return meditate
    ? t('settings.health.meditateSays.held')
    : t('settings.health.meditateSays.lacking');
}
