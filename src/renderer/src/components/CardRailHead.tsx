import type { PointerEvent } from 'react';

import CardPicker from './CardPicker';
import Icon from './Icon';
import ViewSwitch from './ViewSwitch';
import { useExtensions } from '../hooks/useExtensions';
import type { AutoLayoutApi, CardId } from '../lib/cards';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';

export interface CardRailHeadProps {
  /** Cards currently put away; the chip is drawn only while there are some. */
  away: CardId[];
  onAdd(id: CardId): void;
  onFloat(id: CardId): void;
  onGrab?(id: CardId, event: PointerEvent<HTMLElement>): void;
  dragging?: boolean;
  /** Auto layout, and the undo of it while there is an arrangement kept. */
  autoLayout: AutoLayoutApi;
  /** Into the game view (todo 04). */
  onGameView(): void;
}

/**
 * The row at the head of the card rail: the put-away chip, auto layout and
 * its undo, and the switch into the game view. The client's mark leads the
 * character tabs (`AppMark`).
 */
export default function CardRailHead({
  away: put,
  autoLayout,
  onGameView,
  ...picker
}: CardRailHeadProps) {
  // The extension card is offered only where an extension draws one.
  const installed = useExtensions().length > 0;
  const away = installed ? put : put.filter((id) => id !== 'extension');
  return (
    <div className="card-rail-head">
      <CardPicker cards={away} {...picker} />
      <button
        className="chip"
        data-action="auto-layout"
        onClick={autoLayout.run}
        // The rail takes no typed input, so it never takes the caret.
        onMouseDown={keepFocus}
        title={t('cards.autoLayout.tooltip')}
        type="button"
      >
        <Icon name="layout" />
        <span>{t('cards.autoLayout.label')}</span>
      </button>
      {autoLayout.canUndo && (
        <button
          aria-label={t('cards.autoLayout.undo')}
          className="chip"
          data-action="undo-auto-layout"
          onClick={autoLayout.undo}
          onMouseDown={keepFocus}
          title={t('cards.autoLayout.undoTooltip')}
          type="button"
        >
          <Icon name="undo" />
        </button>
      )}
      <ViewSwitch className="chip" game={false} onToggle={onGameView} />
    </div>
  );
}
