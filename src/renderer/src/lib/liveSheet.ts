/**
 * What the settings screen reads off a character in the realm: the maxima its
 * percentages are of, and the two facts that decide whether `pickLocks` and
 * `useMeditate` act (todo 50). Read off the live view, never the settings
 * snapshot, and all null for a character that is not in the realm.
 */
import { holdsMeditate } from '@shared/abilities';
import type { CharacterState } from '@shared/character';
import { holdsPicklocks } from '@shared/walk';
import { t } from './i18n';

export interface LiveSheet {
  hpMax: number | null;
  manaMax: number | null;
  /** The stat sheet's `Picklocks`. */
  picklocks: number | null;
  /** Whether an `abil` list shows Meditate (`holdsMeditate`). */
  meditate: boolean | null;
}

export const NO_SHEET: LiveSheet = { hpMax: null, manaMax: null, picklocks: null, meditate: null };

export function liveSheetOf(character: CharacterState | undefined): LiveSheet {
  if (character === undefined) return NO_SHEET;
  return {
    hpMax: character.vitals.hpMax,
    manaMax: character.vitals.manaMax,
    picklocks: character.progress.picklocks,
    meditate: holdsMeditate(character.abilities)
  };
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
