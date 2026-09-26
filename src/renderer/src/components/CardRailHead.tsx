import type { PointerEvent } from 'react';

import CardPicker from './CardPicker';
import type { CardId } from '../lib/cards';
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
}

/**
 * The row at the head of the card rail: the put-away chip, and the mark.
 *
 * The mark was a line-high glyph at the left of the status rail, where it was
 * the smallest thing on the smallest line in the window. Here it has the band
 * the chip already fills (`--topbar-h`), so it is drawn at nearly that height
 * without the row taking any height it did not already have — unless nothing
 * is put away, when the row is the mark's alone.
 *
 * The version sits beside it while the rail is wide enough and wraps out of
 * sight when it is not (`.app-mark` clips to one line); the tooltip carries it
 * either way, from the same `package.json` main reports (`appVersion`).
 */
export default function CardRailHead({ away, showLogo, ...picker }: CardRailHeadProps) {
  if (away.length === 0 && !showLogo) return null;
  const name = t('app.windowTitle');
  return (
    <div className="card-rail-head">
      <CardPicker cards={away} {...picker} />
      {showLogo && (
        <span className="app-mark" title={t('app.markTooltip', { name, version })}>
          <span aria-hidden="true" className="app-mark-glyph" />
          <span className="app-mark-version">{t('app.markVersion', { version })}</span>
        </span>
      )}
    </div>
  );
}
