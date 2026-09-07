import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';

import Icon from './Icon';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';

/**
 * The one standing mark that says a panel can be moved.
 *
 * The same six dots a card and a tab wear, in the same place, always drawn and
 * quiet until pointed at — an affordance you have to find by hovering is one
 * most people never find.
 *
 * **It is the handle, not the whole heading.** A card's heading is its handle
 * because a card's heading is never anything else; a panel's carries the face
 * pills — `PLAYER  EQUIPMENT  ACCESS` — and a press anywhere on it that turned
 * into a drag would make choosing a face a gamble on how still somebody's hand
 * is. That is the reasoning a tab's grip already records.
 */
function PopoverGrip({ onGrab }: { onGrab(event: ReactPointerEvent<HTMLElement>): void }) {
  return (
    <span
      aria-hidden="true"
      className="card-grip popover-grip"
      onPointerDown={onGrab}
      title={t('cards.popover.moveHint')}
    />
  );
}

interface PopoverControlsProps {
  pinned: boolean;
  onPin(): void;
  onClose(): void;
}

/**
 * Pin, then close — the two glyphs a card's action column ends with, in the
 * same order, because these panels are kept and dismissed the way a card is
 * and a control learned on one should be the same control here.
 *
 * What is deliberately absent is the settings gear and the copy glyph: a panel
 * has no settings of its own, and copying is on its right-click menu.
 *
 * **Both are always drawn**, rather than quiet-until-hover as on a card. A
 * panel over the game has to be visibly dismissable and there is no card edge
 * for the pointer to find the glyph on — and a panel nobody knows can be
 * pinned is one that closes on the next click for ever.
 */
function PopoverControls({ pinned, onPin, onClose }: PopoverControlsProps) {
  const pinLabel = pinned ? t('cards.popover.unpinHint') : t('cards.popover.pinHint');
  return (
    <>
      <button
        aria-pressed={pinned}
        className={`card-action popover-pin${pinned ? ' on' : ''}`}
        onClick={onPin}
        // Clicked, never typed into: the caret belongs to the game.
        onMouseDown={keepFocus}
        title={pinLabel}
        type="button"
      >
        {/*
          One glyph per state rather than one glyph for both. A pin that looks
          identical whether pressing it will pin or release is the failure the
          `unpin` icon was drawn for on the card's own column.
        */}
        <Icon name={pinned ? 'unpin' : 'pin'} />
        <span className="sr-only">{pinLabel}</span>
      </button>
      <button
        aria-label={t('cards.chrome.close')}
        className="card-action card-close"
        onClick={onClose}
        onMouseDown={keepFocus}
        title={t('cards.chrome.close')}
        type="button"
      >
        <Icon name="close" />
      </button>
    </>
  );
}

export interface PopoverHeadProps extends PopoverControlsProps {
  /** The title, or a trail of face pills — whatever this panel's heading is. */
  children: ReactNode;
  /** Drawn right of the heading, before the controls. */
  badge?: ReactNode;
  onGrab(event: ReactPointerEvent<HTMLElement>): void;
}

/**
 * A panel's heading row: grip, heading, badge, pin, close.
 *
 * One component so a second slide-out cannot come out a different shape from
 * the first — the same rule that put `placePopover`, `scrollMovesAnchor` and
 * the `.popover` base rule in one place each. All three panels use it,
 * including the Reference one: its heading is the *name*, so
 * `ReferenceDetail` takes `heading={false}` there rather than this taking the
 * grip and the controls into that row. Two name rows, one of them scrolling
 * under the other, would say the same word twice and only sometimes.
 *
 * The grip and the controls are therefore not exported: nothing outside this
 * file assembles a heading of its own, and a second assembly is how the second
 * slide-out comes out a different shape.
 */
export default function PopoverHead({
  children,
  badge = null,
  onGrab,
  pinned,
  onPin,
  onClose
}: PopoverHeadProps) {
  return (
    <header className="popover-head">
      <PopoverGrip onGrab={onGrab} />
      <h2>{children}</h2>
      {badge}
      <PopoverControls onClose={onClose} onPin={onPin} pinned={pinned} />
    </header>
  );
}

/**
 * The corner somebody drags to resize a panel.
 *
 * The same mark, in the same corner, as a card's and a float's, so it is
 * learned once. Double-click puts the panel back to the size it was fitted to
 * the name at — a card's grip resets the same way.
 */
export function PopoverSizer({
  onSize,
  onReset
}: {
  onSize(event: ReactPointerEvent<HTMLElement>): void;
  onReset(): void;
}) {
  return (
    <span
      aria-hidden="true"
      className="float-grip popover-sizer"
      onDoubleClick={onReset}
      onPointerDown={onSize}
      title={t('cards.popover.resizeHint')}
    />
  );
}
