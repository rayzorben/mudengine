/**
 * How a pack's load (`loadOf`) is drawn wherever it is drawn: the parts in
 * order, their names, each part's width against the maximum, and what is
 * left free. The game view's load bar and the cards' `PackLoad` both read it,
 * so the two drawings cannot name a part differently.
 */
import { t } from './i18n';
import type { Load } from './packGroups';

export type LoadPart = 'worn' | 'carried' | 'rest';
export const LOAD_PARTS: readonly LoadPart[] = ['worn', 'carried', 'rest'];

export const LOAD_PART_LABEL: Readonly<Record<LoadPart, string>> = {
  worn: t('game.pack.loadWorn'),
  carried: t('game.pack.loadCarried'),
  rest: t('game.pack.loadRest')
};

/** What the character could still carry; never below none. */
export function loadFree(load: Load): number {
  return Math.max(0, load.max - load.now);
}
