import { useState, type FormEvent } from 'react';

import { errorMessage } from '@shared/values';

import Icon from './Icon';
import Popup from './Popup';
import type {
  LayoutFileOutcome,
  LayoutFilesApi,
  NamedLayout,
  NamedLayoutsApi
} from '../lib/cardLayouts';
import { LAYOUT_NAME_MAX } from '../lib/cardLayouts';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';

export interface LayoutMenuProps {
  named: NamedLayoutsApi;
  files: LayoutFilesApi;
}

/** What the last file action said, for the line at the foot of the menu. */
type Said = { tone: 'ok' | 'error'; text: string } | null;

function said(outcome: LayoutFileOutcome | null): Said {
  if (outcome === null) return null;
  switch (outcome.kind) {
    case 'saved':
      return { tone: 'ok', text: t('cards.layouts.savedFile', { file: outcome.file }) };
    case 'loaded':
      return { tone: 'ok', text: t('cards.layouts.loaded', { layoutName: outcome.name }) };
    case 'refused':
      return { tone: 'error', text: outcome.error };
    default: {
      const never: never = outcome;
      return never;
    }
  }
}

/**
 * The saved card layouts, behind one chip at the head of the rail beside
 * Auto layout. The chip says which saved layout the cards stand in, if one;
 * a row puts the cards where that layout has them. Under the rows: a name and
 * Save for where the cards are now, and the layout to and from a file.
 */
export default function LayoutMenu({ named, files }: LayoutMenuProps) {
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<Said>(null);

  const run = (work: () => Promise<LayoutFileOutcome | null>): void => {
    setBusy(true);
    setLine(null);
    work()
      .then((outcome) => setLine(said(outcome)))
      .catch((error: unknown) => setLine({ tone: 'error', text: errorMessage(error) }))
      .finally(() => setBusy(false));
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    named.save(typed);
    setTyped('');
  };

  const choose = (entry: NamedLayout): void => {
    named.apply(entry.name);
    setOpen(null);
  };

  return (
    <div className="layout-menu">
      <button
        aria-expanded={open !== null}
        aria-haspopup="dialog"
        className="chip"
        data-action="layouts"
        // The chip is the way out as well as the way in (`CardPicker`).
        onClick={(event) => {
          const chip = event.currentTarget;
          setOpen((shown) => (shown ? null : chip));
        }}
        onMouseDown={keepFocus}
        title={t('cards.layouts.tooltip')}
        type="button"
      >
        <Icon name="columns" />
        <span>{named.shown ?? t('cards.layouts.label')}</span>
        <Icon name={open !== null ? 'chevronUp' : 'chevronDown'} />
      </button>

      {open !== null && (
        <Popup
          at={open}
          className="picker-menu layouts-menu"
          label={t('cards.layouts.menuLabel')}
          onDismiss={() => setOpen(null)}
          role="dialog"
        >
          {named.layouts.length === 0 && <p className="hint">{t('cards.layouts.none')}</p>}
          {named.layouts.map((entry) => {
            const shown = entry.name === named.shown;
            return (
              <div className="picker-row" data-layout={entry.name} key={entry.name}>
                <button
                  aria-pressed={shown}
                  className="entry"
                  onClick={() => choose(entry)}
                  onMouseDown={keepFocus}
                  title={
                    shown
                      ? t('cards.layouts.shownTooltip', { layoutName: entry.name })
                      : t('cards.layouts.applyTooltip', { layoutName: entry.name })
                  }
                  type="button"
                >
                  <Icon name={shown ? 'check' : 'columns'} />
                  <span>{entry.name}</span>
                </button>
                <button
                  aria-label={t('cards.layouts.fileTooltip', { layoutName: entry.name })}
                  className="picker-float"
                  data-action="layout-file"
                  disabled={busy}
                  onClick={() => run(() => files.save(entry))}
                  onMouseDown={keepFocus}
                  title={t('cards.layouts.fileTooltip', { layoutName: entry.name })}
                  type="button"
                >
                  <Icon name="download" />
                </button>
                <button
                  aria-label={t('cards.layouts.removeTooltip', { layoutName: entry.name })}
                  className="picker-float"
                  data-action="layout-remove"
                  onClick={() => named.remove(entry.name)}
                  onMouseDown={keepFocus}
                  title={t('cards.layouts.removeTooltip', { layoutName: entry.name })}
                  type="button"
                >
                  <Icon name="trash" />
                </button>
              </div>
            );
          })}

          <form className="layouts-save" onSubmit={submit}>
            <input
              aria-label={t('cards.layouts.nameLabel')}
              maxLength={LAYOUT_NAME_MAX}
              onChange={(event) => setTyped(event.currentTarget.value)}
              placeholder={t('cards.layouts.namePlaceholder')}
              spellCheck={false}
              type="text"
              value={typed}
            />
            <button
              className="quiet"
              data-action="layout-save"
              disabled={typed.trim().length === 0}
              title={t('cards.layouts.saveTooltip')}
              type="submit"
            >
              {t('cards.layouts.save')}
            </button>
          </form>

          <button
            className="entry"
            data-action="layout-save-file"
            disabled={busy}
            onClick={() => run(() => files.saveShown(typed || (named.shown ?? '')))}
            onMouseDown={keepFocus}
            title={t('cards.layouts.saveFileTooltip')}
            type="button"
          >
            <Icon name="download" />
            <span>{t('cards.layouts.saveFile')}</span>
          </button>
          <button
            className="entry"
            data-action="layout-load-file"
            disabled={busy}
            onClick={() => run(files.load)}
            onMouseDown={keepFocus}
            title={t('cards.layouts.loadFileTooltip')}
            type="button"
          >
            <Icon name="folder" />
            <span>{t('cards.layouts.loadFile')}</span>
          </button>

          {line !== null && (
            <p className="layouts-said" data-tone={line.tone} role="status">
              {line.text}
            </p>
          )}
        </Popup>
      )}
    </div>
  );
}
