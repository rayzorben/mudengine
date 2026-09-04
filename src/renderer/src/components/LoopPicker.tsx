import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import Icon from './Icon';
import { useListNavigation } from '../hooks/useListNavigation';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { Loop } from '@shared/loops';

export interface LoopPickerProps {
  /** Every loop the client ships, or an empty shelf while it is being read. */
  catalogue: Loop[];
  /** Names this character already walks, so a row can say it is taken. */
  chosen: ReadonlySet<string>;
  /** Add this loop, or take it back off. */
  onToggle(loop: Loop): void;
  /** Put the shelf away — the button, and Escape. */
  onDone(): void;
  /** Whether the catalogue has arrived yet. */
  loading: boolean;
}

/**
 * The shelf of shipped loops, as a filtered checklist.
 *
 * Four hundred and twenty of MegaMUD's own loops ship with the client
 * (`resources/loops/megamud.yaml`), and until now the only way to use one was
 * to open that file, find a loop among the others, and paste forty lines of
 * YAML into a character. That is the same failure as a command nobody can find:
 * a feature reachable only by somebody who already knows it exists.
 *
 * Three decisions worth stating, because none of them is the obvious one:
 *
 * - **A row toggles rather than adds.** The picker is a checklist of the shelf
 *   and the character's list is what is checked, so the same gesture that put a
 *   loop on takes it off — and choosing one that is already there cannot
 *   quietly add a second copy under the same name.
 * - **A taken row stays in the list.** Hiding it would make the list shift under
 *   the cursor at the moment of a click, which is how somebody adds the loop
 *   below the one they meant.
 * - **Nothing is dropped from the list.** No "top 40 matches" — a loop
 *   missing from a list that looks complete reads as a loop the client does
 *   not have. Four hundred rows are nothing to a browser and the field narrows
 *   them in a keystroke.
 *
 * Identity is the **name**, which is how a loop is addressed everywhere else in
 * the client: the palette starts one by name and `loopNamed` finds it by name.
 * Two loops called the same thing are already ambiguous to everything that
 * runs them, so they are one here too.
 *
 * A filtered list, so it uses `useListNavigation` like every other one — type to
 * narrow, arrow to choose, Enter to take it. It holds the caret while it is
 * open, and therefore owns its own Escape.
 */
export default function LoopPicker({
  catalogue,
  chosen,
  onToggle,
  onDone,
  loading
}: LoopPickerProps) {
  const [query, setQuery] = useState('');
  const fieldRef = useRef<HTMLInputElement>(null);

  // The field is the whole point of opening this, so it takes the caret. The
  // settings dialog is already a surface that holds it, so nothing is being
  // stolen from the game that was not borrowed already.
  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  const matches = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return catalogue;
    // Every term has to appear, in any order: the names are `Area: Room-map
    // room`, so `sewer newhaven` and `newhaven sewer` are the same question.
    return catalogue.filter((loop) => {
      const name = loop.name.toLowerCase();
      return terms.every((term) => name.includes(term));
    });
  }, [catalogue, query]);

  const nav = useListNavigation<Loop>({ items: matches, onChoose: onToggle, onCancel: onDone });

  /*
   * Escape belongs to whatever holds the caret, and while this is open that is
   * this. The settings dialog handles Escape on the way past, so without this
   * one keystroke would put the shelf away *and* close the whole screen — a key
   * doing something bigger than it looks.
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') event.stopPropagation();
    nav.onKeyDown(event);
  };

  // The dictionary holds the sentence whole; the <code> around the YAML path is
  // presentation, so the string is split around the path it names.
  const [emptyHead, emptyTail] = t('settings.loopPicker.emptyCatalogue').split('automation.loops');

  return (
    <div className="loop-picker">
      <div className="loop-picker-head">
        <label className="loop-search">
          <Icon name="search" />
          <input
            aria-label={t('settings.loopPicker.searchAriaLabel')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              // A count is asserted only once it has actually been read.
              loading
                ? t('settings.loopPicker.searchPlaceholderLoading')
                : t('settings.loopPicker.searchPlaceholder', { count: catalogue.length })
            }
            ref={fieldRef}
            spellCheck={false}
            value={query}
          />
        </label>
        <button className="quiet" onClick={onDone} onMouseDown={keepFocus} type="button">
          {t('settings.loopPicker.done')}
        </button>
      </div>

      {loading ? (
        <p className="settings-note">{t('settings.loopPicker.loading')}</p>
      ) : catalogue.length === 0 ? (
        /* An empty shelf is a package missing its data, not a mistake somebody
           made. It says what is still possible rather than only what is not. */
        <p className="settings-note">
          {emptyHead}
          <code>automation.loops</code>
          {emptyTail}
        </p>
      ) : matches.length === 0 ? (
        <p className="settings-note">{t('settings.loopPicker.noMatches', { query })}</p>
      ) : (
        <ul className="loop-options" ref={nav.listRef as React.RefObject<HTMLUListElement>}>
          {matches.map((loop, index) => {
            const taken = chosen.has(loop.name);
            return (
              <li key={loop.name}>
                <button
                  aria-pressed={taken}
                  data-active={nav.isActive(index) ? 'true' : 'false'}
                  data-taken={taken ? 'true' : 'false'}
                  onClick={() => onToggle(loop)}
                  onMouseDown={keepFocus}
                  onMouseEnter={() => nav.point(index)}
                  type="button"
                >
                  <Icon name={taken ? 'check' : 'plus'} />
                  <span className="loop-name">{loop.name}</span>
                  <span className="hint">
                    {loop.stops.length === 1
                      ? t('settings.loopPicker.stopsCount.one', { count: loop.stops.length })
                      : t('settings.loopPicker.stopsCount.many', { count: loop.stops.length })}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
