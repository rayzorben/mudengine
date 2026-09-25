import { useEffect, useState, type PointerEvent } from 'react';

import Icon from './Icon';
import Popup from './Popup';
import { cardLabel, type CardId } from '../lib/cards';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';

export interface CardPickerProps {
  /** Cards currently put away. */
  cards: CardId[];
  /** Put one back on the rail, at the foot of it. */
  onAdd(id: CardId): void;
  /** Bring one out over the console instead. */
  onFloat(id: CardId): void;
  /**
   * A row picked up rather than clicked.
   *
   * A put-away card is still a card, and dragging it onto the console floats
   * it there — or into the rail, where it lands. Clicking still docks it at the
   * foot of the rail; the two are told apart by whether the pointer travelled,
   * which is the drag machine's own rule.
   */
  onGrab?(id: CardId, event: PointerEvent<HTMLElement>): void;
  /**
   * Whether a drag is actually running.
   *
   * The list closes when one goes live, because it is drawn in a portal over
   * the very rail the card is being dragged into: a drop target the player
   * cannot see is a drop they have to undo. It is not enough to close on the
   * press — that would unmount the row before its own click could fire, which
   * is the click that docks it.
   */
  dragging?: boolean;
}

/**
 * The put-away cards, behind one control at the head of the rail.
 *
 * **It was a chip per card, wrapping.** A rail with six cards put away — which
 * is what a rail *ships* with, since Inventory, Talk, Gang, Banks, Combat Stats
 * and the loop builder are all `DEFAULT_AWAY` — spent three rows of the window
 * on a stack of buttons above the instrument, and every card closed after that
 * added another. The head of the rail is one band tall beside the tab rail and
 * the toolbar strip (`npm run smoke` measures the three against each other);
 * a control that grows downwards out of it pushes every card on the rail down
 * with it.
 *
 * So it is one chip that says how many, and the cards live in a list under it.
 * Present only while something is actually put away, exactly as the chips were:
 * a control that disappears when there is nothing to do with it, rather than a
 * permanent row of chrome above the instrument.
 *
 * **Two ways out of every row, because there are two places to put a card.**
 * The row itself docks it on the rail — the click the chips already had — and a
 * glyph at its end brings it out over the console as a float. That second one
 * had no affordance at all before: floating a card meant knowing it could be
 * dragged there.
 */
export default function CardPicker({ cards, onAdd, onFloat, onGrab, dragging }: CardPickerProps) {
  const [open, setOpen] = useState<HTMLElement | null>(null);

  /*
   * A card dragged out of the list is on its way to the rail underneath it.
   * The drag machine hit-tests by measuring the lanes as laid out, so the
   * portal does not block the drop — but it does cover it, and a gap opening
   * where the player cannot see it is the one thing the drop indicator exists
   * to prevent.
   */
  useEffect(() => {
    if (dragging) setOpen(null);
  }, [dragging]);

  if (cards.length === 0) return null;

  return (
    <div className="card-picker">
      <button
        aria-expanded={open !== null}
        aria-haspopup="menu"
        className="chip"
        data-card-picker="true"
        // Toggled: the chip is the way out of the list as well as the way in,
        // and `Popup` deliberately does not count a press on its own anchor as
        // a click-away.
        onClick={(event) => setOpen((shown) => (shown ? null : event.currentTarget))}
        // The rail takes no typed input, so it never takes the caret.
        onMouseDown={keepFocus}
        title={t('cards.picker.tooltip')}
        type="button"
      >
        {/*
          One key and not a plural pair: `3 put away` and `1 put away` are the
          same sentence in English, and a pair whose halves are identical is two
          strings to keep in step for nothing.
        */}
        <span>{t('cards.picker.away', { cardCount: cards.length })}</span>
        <Icon name={open !== null ? 'chevronUp' : 'chevronDown'} />
      </button>

      {open !== null && (
        <Popup
          at={open}
          className="picker-menu"
          label={t('cards.picker.menuLabel')}
          onDismiss={() => setOpen(null)}
          role="menu"
        >
          {cards.map((id) => (
            /*
              One row, two controls. `role="none"` on the wrapper so the menu's
              children are still its items: the row is a layout, not a thing to
              choose.
            */
            <div className="picker-row" key={id} role="none">
              <button
                className="entry"
                data-card-chip={id}
                onClick={() => {
                  onAdd(id);
                  setOpen(null);
                }}
                onMouseDown={keepFocus}
                // A row is a handle as well as a button, so the drag machine is
                // told this press is both (`fromControl`).
                onPointerDown={onGrab ? (event) => onGrab(id, event) : undefined}
                role="menuitem"
                title={
                  onGrab
                    ? t('cards.picker.railTooltipDraggable', { cardLabel: cardLabel(id) })
                    : t('cards.picker.railTooltip', { cardLabel: cardLabel(id) })
                }
                type="button"
              >
                <Icon name="plus" />
                <span>{cardLabel(id)}</span>
              </button>
              <button
                aria-label={t('cards.picker.floatTooltip', { cardLabel: cardLabel(id) })}
                className="picker-float"
                data-card-float-chip={id}
                onClick={() => {
                  onFloat(id);
                  setOpen(null);
                }}
                onMouseDown={keepFocus}
                role="menuitem"
                title={t('cards.picker.floatTooltip', { cardLabel: cardLabel(id) })}
                type="button"
              >
                <Icon name="popout" />
              </button>
            </div>
          ))}
        </Popup>
      )}
    </div>
  );
}
