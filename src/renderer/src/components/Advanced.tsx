import { useState } from 'react';
import Icon from './Icon';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';

export interface AdvancedProps {
  /** What is behind it, in one short phrase: "the wire", "pacing". */
  label?: string;
  children: React.ReactNode;
}

/**
 * The settings most people should never have to see, behind one press.
 *
 * `cp437` is the example that made the case: it is the *right* answer for every
 * realm this client speaks to, it cannot be chosen well by somebody who does
 * not already know what it is, and it sat in the middle of the form somebody
 * opens to type a password. A field like that costs every visit a little
 * attention and repays it on almost none.
 *
 * Three rules, and they are why this is a disclosure rather than a separate
 * page:
 *
 * - **Nothing is hidden that a beginner might need.** What goes in here is
 *   what has a right answer already: encodings, timeouts, pacing, scrollback.
 *   A threshold that decides whether a character runs away is not advanced,
 *   however unfamiliar the word.
 * - **It is in the section it belongs to**, not gathered into one Advanced
 *   page of unrelated things. Somebody looking for the encoding is looking at
 *   the realm, and a page that collected every difficult setting would be a
 *   page nobody could find anything in.
 * - **Closed by default, and it says what it holds.** A disclosure labelled
 *   "Advanced" and nothing else is a dare rather than an offer.
 *
 * State is deliberately local and not remembered: it is a *view* of one form
 * that is open now, and a section that came back open because it was open a
 * fortnight ago would defeat the point of closing it.
 */
export default function Advanced({ label, children }: AdvancedProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div className="settings-advanced" data-open={open ? 'true' : 'false'}>
      <button
        aria-expanded={open}
        className="quiet settings-advanced-toggle"
        onClick={() => setOpen(!open)}
        onMouseDown={keepFocus}
        type="button"
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} />
        <span>
          {label === undefined
            ? t('settings.advanced.togglePlain')
            : t('settings.advanced.toggle', { label })}
        </span>
      </button>
      {open && <div className="settings-advanced-body">{children}</div>}
    </div>
  );
}
