/**
 * One sentence, out of the way until it is asked for.
 *
 * The settings screen used to explain itself in prose beside every field, and
 * the prose was all true — which is exactly why it took a year to notice it was
 * the problem. Somebody configuring a MajorMUD client has played MajorMUD; what
 * they want is to find the number, change it, and leave, and four sentences
 * between them and the number is four sentences they read once and then had to
 * scroll past for ever. `docs/terminology.md` has the rule and what it replaced.
 *
 * So the sentence stays, and moves behind a mark:
 *
 * - **Hover, focus and click all open it.** Hover alone is an affordance a
 *   keyboard cannot reach and a touch screen does not have; `title=` is worse
 *   again, because the delay is the OS's and the styling is nobody's.
 * - **It is a `<button>`, not a `<span>` with handlers.** Tab reaches it, Enter
 *   and Space work, and assistive technology is told what it is without a
 *   `role` being asserted by hand.
 * - **`aria-describedby`, so the sentence belongs to the field.** A screen
 *   reader reads the label and then the description, which is the order the
 *   sighted reading has too. That is why the id is required rather than
 *   generated: the *caller* knows which control this describes.
 * - **`Escape` closes it, and does not reach the game.** Every other surface in
 *   this client that takes a key hands it back; this one holds it only while it
 *   is open.
 *
 * Not a tooltip library. It is thirty lines, it is styled by two rules in
 * `index.css`, and the alternative is a dependency that would have to be taught
 * this project's tokens, its theme swap and its focus rules.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import Icon from './Icon';

import { t } from '../lib/i18n';

export interface HintProps {
  /**
   * The id given to the sentence, for `aria-describedby` on the field.
   *
   * Required rather than generated, because the thing being described is the
   * caller's and only the caller knows which element it is.
   */
  id: string;
  /** One sentence. See `docs/terminology.md` §1 for how long that is. */
  children: ReactNode;
}

export function Hint({ id, children }: HintProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<'start' | 'end'>('start');
  const wrap = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  /*
   * How it was opened decides what may close it. A pointer leaving only undoes
   * what a pointer did: a hint opened by click or focus has to survive the
   * glance away while somebody is still reading it, and closes by click-away,
   * blur or Escape instead — otherwise "click" is nothing but hover again.
   */
  const openedBy = useRef<'hover' | 'click' | 'focus' | null>(null);

  /*
   * Which side it hangs from, measured once when it opens.
   *
   * The bubble is up to 34ch wide and a field is now one column of a grid whose
   * column *count* comes from the dialog's width, so there is no field position
   * that is statically known to be safe. The width is the same whichever side
   * it hangs from, which is what lets this decide without first drawing it the
   * wrong way and measuring that.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const mark = wrap.current;
    const node = bubble.current;
    if (mark === null || node === null) return;
    const edge = mark.closest('.settings-form')?.getBoundingClientRect().right ?? window.innerWidth;
    setSide(
      mark.getBoundingClientRect().left + node.getBoundingClientRect().width > edge
        ? 'end'
        : 'start'
    );
  }, [open]);

  /*
   * A click anywhere else closes it — including on the next field's mark, which
   * is the common case: reading two hints in a row should not leave the first
   * one hanging over the second.
   */
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent): void => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  return (
    <span
      className="hint-mark"
      data-side={side}
      onMouseEnter={() => {
        if (!open) openedBy.current = 'hover';
        setOpen(true);
      }}
      onMouseLeave={() => {
        if (openedBy.current === 'hover') setOpen(false);
      }}
      ref={wrap}
    >
      <button
        aria-controls={id}
        aria-expanded={open}
        aria-label={t('settings.hint.ariaLabel')}
        className="hint-button"
        onBlur={() => setOpen(false)}
        onClick={() => {
          if (!open) openedBy.current = 'click';
          setOpen(!open);
        }}
        onFocus={() => {
          if (!open) openedBy.current = 'focus';
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !open) return;
          // Only while it is open: a bare Escape otherwise belongs to whatever
          // else is listening, which on this screen is the dialog.
          event.stopPropagation();
          setOpen(false);
        }}
        type="button"
      >
        <Icon name="help" size={13} />
      </button>
      {/*
        Always rendered, hidden when closed, so `aria-describedby` on the field
        it belongs to always points at something. A description that exists only
        while a popup is open is a description a screen reader never reads.
      */}
      <span className="hint-bubble" hidden={!open} id={id} ref={bubble} role="tooltip">
        {children}
      </span>
    </span>
  );
}
