import type { PointerEvent } from 'react';

import { cardLabel, type CardId } from '../hooks/useCardLayout';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';

export interface CardPickerProps {
  /** Cards currently put away. */
  cards: CardId[];
  onAdd(id: CardId): void;
  /**
   * A chip picked up rather than clicked.
   *
   * A put-away card is still a card, and dragging its chip onto the console
   * floats it there — or into the rail, where it lands. Clicking still docks
   * it at the foot of the rail; the two are told apart by whether the pointer
   * travelled, which is the drag machine's own rule.
   */
  onGrab?(id: CardId, event: PointerEvent<HTMLElement>): void;
}

/**
 * Putting a card back, at the top of the rail where its gap is.
 *
 * Present only while something is actually put away, so it is a control that
 * disappears when there is nothing to do with it rather than a permanent row of
 * chrome above the instrument. The palette offers the same thing for anyone who
 * would rather not reach for the mouse.
 */
export default function CardPicker({ cards, onAdd, onGrab }: CardPickerProps) {
  if (cards.length === 0) return null;

  return (
    <div className="card-picker">
      {cards.map((id) => (
        <button
          className="chip"
          data-card-chip={id}
          key={id}
          onClick={() => onAdd(id)}
          // The rail takes no typed input, so it never takes the caret.
          onMouseDown={keepFocus}
          onPointerDown={onGrab ? (event) => onGrab(id, event) : undefined}
          title={
            onGrab
              ? t('cards.picker.tooltipDraggable', { cardLabel: cardLabel(id) })
              : t('cards.picker.tooltip', { cardLabel: cardLabel(id) })
          }
          type="button"
        >
          {t('cards.picker.addChip', { cardLabel: cardLabel(id) })}
        </button>
      ))}
    </div>
  );
}
