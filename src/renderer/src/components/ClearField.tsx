import Icon from './Icon';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';

export interface ClearFieldProps {
  /**
   * What is typed in the field this wraps.
   *
   * The control is drawn only while there is something to clear: a permanently
   * lit clear is a control that does nothing most of the time, and one that
   * appears is also how the field says it is filtering.
   */
  query: string;
  /** Empties it. The same thing the field's own Escape does to the query. */
  onClear(): void;
  /** What the field is called, so the button can say what it clears. */
  label: string;
  /** The `<input>` itself, and anything the field already drew beside it. */
  children: React.ReactNode;
}

/**
 * The clear inside a find field.
 *
 * Every field that narrows a listing gets one — the tables' find, the Talk and
 * Gang cards' (the same `FindField`), the palette, the route panel's room
 * search, the loop builder's finder, the loops modal and the loop picker.
 * Nothing that holds a *value* does: a health percentage cleared to nothing is
 * a setting with no answer, and the × would be offering to break it.
 *
 * Escape already cleared and handed the caret back in one press, which is the
 * keyboard's way and stays the faster one. What it is not is *visible*: a field
 * with words in it and no way out that can be seen is one people retype over
 * instead, and the room-name and find fields are exactly where somebody arrives
 * with the mouse already in their hand.
 *
 * Two things it deliberately does not do:
 *
 * - **It does not move the caret.** `keepFocus` on `mousedown` means clearing
 *   from the mouse leaves the keyboard exactly where it was — in the field if
 *   it was there, at the game if it was not. A clear that grabbed the keyboard
 *   would break the focus policy from the one direction nobody expects.
 * - **It reserves its space whether or not it is drawn.** The button is always
 *   in the layout and merely `visibility: hidden` while the field is empty, so
 *   a field does not change width the first time somebody types in it — and,
 *   unlike the overlay this replaced, the caret can never run under the glyph.
 *   The overlay needed `padding-inline-end` on the input to keep clear of the
 *   text, and every one of the seven fields sets its own padding at equal or
 *   higher specificity: `.table-find input { padding: 0 }` won, and
 *   `npm run smoke` measured the result.
 */
export default function ClearField({
  query,
  onClear,
  label,
  children
}: ClearFieldProps): React.JSX.Element {
  return (
    <div className="field-hold">
      {children}
      {/*
        Always rendered, hidden while there is nothing to clear. `hidden` would
        take it out of the layout — which is the width change this exists to
        avoid — so it keeps its box and loses its paint and its pointer.
      */}
      <button
        aria-hidden={query.length === 0}
        aria-label={t('field.clear', { label })}
        className="quiet field-clear"
        data-empty={query.length === 0 ? 'true' : 'false'}
        onClick={onClear}
        onMouseDown={keepFocus}
        tabIndex={query.length === 0 ? -1 : 0}
        title={t('field.clear', { label })}
        type="button"
      >
        <Icon name="clearCircle" />
      </button>
    </div>
  );
}
