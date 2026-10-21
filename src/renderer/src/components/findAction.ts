import type { CardAction } from './BentoCard';

/**
 * The search glyph that folds a card's find row out and back.
 *
 * A find field standing open spends a whole row on a question nobody is
 * asking, so the row appears when the glyph asks for it, takes the caret, and
 * hands it back on the way out. The pack (Inventory, and the Self card's PACK
 * face) and the Map card's room fields share it.
 */
export function findAction(
  label: string,
  finding: boolean,
  setFinding: (open: boolean) => void,
  returnFocus?: () => void,
  /** Also on while what the row set up still holds after it folded (the Map card's picked room). */
  holding = false
): CardAction {
  return {
    id: 'find',
    label,
    icon: 'search',
    pressed: finding || holding,
    run: () => {
      if (!finding) {
        setFinding(true);
        return;
      }
      setFinding(false);
      returnFocus?.();
    }
  };
}
