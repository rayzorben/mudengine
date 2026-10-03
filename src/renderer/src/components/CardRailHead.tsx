import type { PointerEvent } from 'react';

import CardPicker from './CardPicker';
import Icon from './Icon';
import { useExtensions } from '../hooks/useExtensions';
import type { AutoLayoutApi, CardId } from '../lib/cards';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { version } from '../../../../package.json';

export interface CardRailHeadProps {
  /** Cards currently put away; the chip is drawn only while there are some. */
  away: CardId[];
  onAdd(id: CardId): void;
  onFloat(id: CardId): void;
  onGrab?(id: CardId, event: PointerEvent<HTMLElement>): void;
  dragging?: boolean;
  /** Draw the client's own mark at the right of the row (`ui.showLogo`). */
  showLogo: boolean;
  /** Auto layout, and the undo of it while there is an arrangement kept. */
  autoLayout: AutoLayoutApi;
}

/**
 * The row at the head of the card rail: the put-away chip, auto layout and
 * its undo, and the mark.
 *
 * The mark was a line-high glyph at the left of the status rail, where it was
 * the smallest thing on the smallest line in the window. Here it has the band
 * the chip already fills (`--topbar-h`), so it is drawn at nearly that height
 * without the row taking any height it did not already have — unless nothing
 * is put away, when the row is the mark's alone.
 *
 * The mark sits at the far right with the version to its left; the tooltip
 * carries both either way, from the same `package.json` main reports
 * (`appVersion`).
 */
export default function CardRailHead({
  away: put,
  showLogo,
  autoLayout,
  ...picker
}: CardRailHeadProps) {
  // The extension card is offered only where an extension draws one.
  const installed = useExtensions().length > 0;
  const away = installed ? put : put.filter((id) => id !== 'extension');
  const name = t('app.windowTitle');
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
      {showLogo && (
        <span className="app-mark" title={t('app.markTooltip', { name, version })}>
          <span className="app-mark-version">{t('app.markVersion', { version })}</span>
          <span aria-hidden="true" className="app-mark-glyph" />
        </span>
      )}
    </div>
  );
}
