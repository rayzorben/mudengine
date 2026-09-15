import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import Icon from './Icon';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';

/**
 * One jump target inside a section: a fieldset, named by its own legend.
 *
 * `id` is what `scrollToFieldset` looks for — the `data-fieldset` attribute on
 * the fieldset itself — so the rail and the form agree by a written-down name
 * rather than by counting fieldsets, which would go wrong the moment one is
 * conditionally drawn.
 */
export interface NavFieldset {
  id: string;
  label: string;
}

export interface NavSection {
  id: string;
  label: string;
  /** Empty for a section whose fields sit directly in it, like Character. */
  fieldsets: readonly NavFieldset[];
}

/** One row of the character or realm picker, as its dropdown draws it. */
export interface NavChoice {
  id: string;
  name: string;
  /** The realm this character plays, or why its file could not be read. */
  detail: string;
  accent?: string;
  broken?: boolean;
}

export interface SettingsNavProps {
  sections: readonly NavSection[];
  section: string;
  onSection(id: string): void;
  /**
   * The picker above the sections, or nothing where the page has one file.
   *
   * MudEngine and Global edit the options file, so a picker there would be a
   * control that never does anything — the same reason `.settings-body`
   * collapses to one column on those two pages.
   */
  picker?: {
    label: string;
    choices: readonly NavChoice[];
    /** The chosen row, or the sentinel for *new*, which draws as the add row. */
    chosen: string | null;
    onChoose(id: string): void;
    /** The *new character* / *new realm* row at the foot of the list. */
    addId: string;
    addLabel: string;
  };
}

/**
 * The settings screen's own navigation: which file, then which part of it.
 *
 * The sections used to be a horizontal strip of crumbs above the fields, which
 * worked while there were six and stopped working at twelve — the strip wrapped
 * to two rows, and a fieldset *inside* a section had no address at all, so
 * finding *Monsters* meant knowing it was under Combat and then scrolling for
 * it. This is that strip turned on its side, with the fieldsets under each
 * section as jump targets of their own (todo 02).
 *
 * **Reading order is outside-in**: which character, then which part of that
 * character, then the fields. So the picker sits above the sections in the same
 * column rather than beside them — the two questions are asked in the order
 * they are answered, and the form keeps the whole of the other column.
 *
 * **The picker is a dropdown rather than a list** because the sections are the
 * thing being navigated now and a list of four characters above a list of
 * twelve sections is two lists competing for one column. Its rows keep
 * everything the list showed — the accent dot, the name, the realm under it —
 * since that is what tells one row from another.
 */
export default function SettingsNav({
  sections,
  section,
  onSection,
  picker
}: SettingsNavProps): React.JSX.Element {
  /*
   * Where the next press wants the form left, held until the form is drawn.
   *
   * The scroll cannot happen in the handler: a press may change the section,
   * and the fields of a section that is not shown are not in the DOM at all
   * (each is drawn behind `shown === '...'`), so there is nothing to scroll to
   * until React has committed. The press states the destination; the layout
   * effect below acts on it, before the browser paints.
   */
  const [wanted, setWanted] = useState<Destination | null>(null);

  useLayoutEffect(() => {
    if (wanted === null) return;
    setWanted(null);
    if (wanted.kind === 'top') scrollFormToTop();
    else scrollToFieldset(wanted.id);
  }, [wanted]);

  return (
    <nav aria-label={t('settings.nav.label')} className="settings-nav">
      {picker && <NavPicker {...picker} />}
      <ul className="settings-nav-sections">
        {sections.map((entry) => {
          const active = entry.id === section;
          return (
            <li key={entry.id}>
              <button
                aria-current={active ? 'true' : undefined}
                className="settings-nav-section"
                data-active={active ? 'true' : 'false'}
                data-section={entry.id}
                onClick={() => {
                  onSection(entry.id);
                  /*
                    A section press lands at the top of that section. Without
                    this, switching from a section somebody had scrolled down
                    opens the next one part-way through -- the form is one
                    scroller and it keeps its offset across the swap.
                  */
                  setWanted({ kind: 'top' });
                }}
                onMouseDown={keepFocus}
                type="button"
              >
                {entry.label}
              </button>
              {/*
                The fieldsets of the section being shown, and only that one.
                Every section's expanded at once is the strip's problem again
                in a taller shape: forty rows in a column, most of them about a
                section nobody is looking at.

                So *Health > When to use an item* is two presses, not one -- but
                the second press is a real jump now, and it is a jump the rail
                can make from any section, because the handler states the
                section as well as the fieldset.
              */}
              {active && entry.fieldsets.length > 1 && (
                <ul className="settings-nav-fieldsets">
                  {entry.fieldsets.map((fieldset) => (
                    <li key={fieldset.id}>
                      <button
                        className="settings-nav-fieldset"
                        data-fieldset={fieldset.id}
                        onClick={() => {
                          onSection(entry.id);
                          setWanted({ kind: 'fieldset', id: fieldset.id });
                        }}
                        onMouseDown={keepFocus}
                        type="button"
                      >
                        {fieldset.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Which character or realm is being edited, as a themed dropdown.
 *
 * Not a native `<select>`, for `NameCombo`'s reason: the browser paints one in
 * its own chrome — light rows in a dark client, its own font — and a row here
 * is two lines with a coloured dot, which a native option cannot draw at all.
 *
 * Closes on Escape without letting the press reach the dialog, which owns its
 * own Escape: one press must not both close this and close settings.
 */
function NavPicker({
  label,
  choices,
  chosen,
  onChoose,
  addId,
  addLabel
}: NonNullable<SettingsNavProps['picker']>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // A press anywhere else closes it. On `pointerdown` rather than `click` so
  // the list is gone before whatever was pressed takes focus.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const current = choices.find((entry) => entry.id === chosen) ?? null;
  const showing = chosen === addId ? addLabel : (current?.name ?? label);

  return (
    <div className="settings-nav-picker" data-open={open ? 'true' : 'false'} ref={box}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label}
        className="settings-nav-chosen"
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !open) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }}
        type="button"
      >
        {current && <span className="dot" data-accent={current.accent} />}
        <span className="settings-entry">
          <span className="settings-name">{showing}</span>
          {current && <span className="hint">{current.detail}</span>}
        </span>
        <Icon name="chevronDown" />
      </button>
      {open && (
        <ul className="settings-nav-choices" role="listbox">
          {choices.map((entry) => (
            <li key={entry.id}>
              <button
                aria-selected={entry.id === chosen}
                data-active={entry.id === chosen ? 'true' : 'false'}
                data-broken={entry.broken ? 'true' : undefined}
                onClick={() => {
                  onChoose(entry.id);
                  setOpen(false);
                }}
                onMouseDown={keepFocus}
                role="option"
                type="button"
              >
                <span className="dot" data-accent={entry.accent} />
                {/*
                  Two rows, name over realm — the list's own shape, kept. Side
                  by side they competed for one line and the clipping fell on
                  the name, which is the only part that tells one row from
                  another.
                */}
                <span className="settings-entry">
                  <span className="settings-name">{entry.name}</span>
                  <span className="hint">{entry.detail}</span>
                </span>
              </button>
            </li>
          ))}
          <li>
            <button
              className="settings-add"
              data-active={chosen === addId ? 'true' : 'false'}
              onClick={() => {
                onChoose(addId);
                setOpen(false);
              }}
              onMouseDown={keepFocus}
              type="button"
            >
              {addLabel}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

/**
 * Where a nav press leaves the form: at the top of the section, or at one of
 * its fieldsets. A union rather than a nullable id with a sentinel in it, so
 * *the top* cannot collide with a fieldset somebody names later.
 */
type Destination = { kind: 'top' } | { kind: 'fieldset'; id: string };

/** The form's own scroller, which is what both destinations move. */
function settingsForm(): Element | null {
  return document.querySelector('.settings-form');
}

/** A section press lands at its first field, not part-way down the last one. */
function scrollFormToTop(): void {
  settingsForm()?.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * Brings a fieldset into view inside the form's own scroller.
 *
 * By `data-fieldset` rather than by index: a section whose fieldsets are drawn
 * conditionally — Combat's three behind its switch — would otherwise scroll to
 * whichever fieldset happened to be third today.
 *
 * **`fieldset[data-fieldset]`, not `[data-fieldset]`**: the rail's own buttons
 * carry the attribute too, and they are earlier in the document, so the bare
 * selector scrolled the *rail* to the row that had just been pressed and left
 * the form where it was. The form and the rail agree by a written-down name,
 * and the name is on two different elements by design.
 *
 * A press that finds nothing does nothing, which is the right answer for a
 * fieldset the form is not drawing right now.
 */
function scrollToFieldset(id: string): void {
  const target = settingsForm()?.querySelector(`fieldset[data-fieldset="${CSS.escape(id)}"]`);
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
