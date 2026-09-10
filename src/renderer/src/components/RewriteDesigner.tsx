/**
 * The Rewrites section on both settings pages: the designs this player
 * keeps, as a list with a switch, a name and what each draws, an editor
 * behind each row (`RewriteEditor`), and the colours a vital wears on every
 * line the client draws. `mudengine-settings` § The Rewrites section is a
 * list, and a design opens in an editor.
 */
import { useCallback, useRef, useState } from 'react';

import Icon from './Icon';
import { NumberField, SelectField } from './FormField';
import RewriteEditor, { ENTITY_WORD, shippedTemplate } from './RewriteEditor';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { fractionOf, percentOf } from '../lib/form';
import type { RewritesUiConfig } from '@shared/config';
import { withEnabled, type RewriteDesign } from '@shared/rewrites';
import type { StatlineFigures } from '@shared/statline';
import { ANSI_COLOURS, isAnsiColour, type ColourBand } from '@shared/template';
import type { TerminalPalette } from '@shared/themes';

export interface RewritesDesignerProps {
  value: RewritesUiConfig;
  onChange(next: RewritesUiConfig): void;
  palette: TerminalPalette;
  /** The character's own figures for the preview, or null for the sample. */
  figures: StatlineFigures | null;
  /** The stem every control's name is built from, so two pages never share an id. */
  idPrefix: string;
}

/** The palette's own names: closed vocabulary, so the words stay in code. */
const COLOUR_OPTIONS = ANSI_COLOURS.map((colour) => ({ value: colour, label: colour }));

/** What a new design starts as: the pack, since it shows the most of what the grammar does. */
function freshDesign(): RewriteDesign {
  return { name: '', entity: 'inventory', enabled: false, template: shippedTemplate('inventory') };
}

export default function RewritesDesigner({
  value,
  onChange,
  palette,
  figures,
  idPrefix
}: RewritesDesignerProps): React.JSX.Element {
  const [editing, setEditing] = useState<number | null>(null);
  /** The control that opened the editor, handed the caret back when it closes. */
  const opener = useRef<HTMLElement | null>(null);

  const designs = value.designs;
  const setDesigns = (next: RewriteDesign[]): void => onChange({ ...value, designs: next });

  const open = (index: number, from: HTMLElement | null): void => {
    opener.current = from;
    setEditing(index);
  };
  const close = useCallback(() => {
    setEditing(null);
    // A dialog drawn over a dialog hands the caret back to the one that
    // asked: the row's pencil, if it is still on screen.
    const back = opener.current;
    opener.current = null;
    if (back !== null && back.isConnected) back.focus();
  }, []);

  const add = (event: React.MouseEvent<HTMLButtonElement>): void => {
    setDesigns([...designs, freshDesign()]);
    open(designs.length, event.currentTarget);
  };
  const remove = (index: number): void => {
    if (editing === index) setEditing(null);
    setDesigns(designs.filter((_, at) => at !== index));
  };

  const edited = editing === null ? undefined : designs[editing];

  return (
    <>
      <fieldset className="settings-menus">
        <legend>{t('settings.rewrites.listLegend')}</legend>
        <p className="settings-note">{t('settings.rewrites.note')}</p>
        {designs.length === 0 ? (
          <p className="settings-note">{t('settings.rewrites.empty')}</p>
        ) : (
          <ul className="settings-loops rewrite-list">
            {designs.map((design, index) => {
              const name = design.name.length > 0 ? design.name : ENTITY_WORD[design.entity];
              return (
                <li data-on={design.enabled ? 'true' : 'false'} key={index}>
                  <input
                    aria-label={t('settings.rewrites.enabledAria', { name })}
                    checked={design.enabled}
                    onChange={(event) =>
                      setDesigns(withEnabled(designs, index, event.target.checked))
                    }
                    type="checkbox"
                  />
                  <span className="rewrite-name">{name}</span>
                  <span className="hint">{ENTITY_WORD[design.entity]}</span>
                  <button
                    aria-label={t('settings.rewrites.editAria', { name })}
                    className="quiet"
                    onClick={(event) => open(index, event.currentTarget)}
                    title={t('settings.rewrites.editTitle')}
                    type="button"
                  >
                    <Icon name="edit" />
                  </button>
                  <button
                    aria-label={t('settings.rewrites.removeAria', { name })}
                    className="quiet"
                    onClick={() => remove(index)}
                    title={t('settings.rewrites.removeTitle')}
                    type="button"
                  >
                    <Icon name="close" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <button className="quiet add-step" onClick={add} onMouseDown={keepFocus} type="button">
          <Icon name="plus" />
          <span>{t('settings.rewrites.add')}</span>
        </button>
      </fieldset>

      <fieldset className="settings-menus">
        <legend>{t('settings.rewrites.bandsLegend')}</legend>
        <p className="settings-note">{t('settings.rewrites.bandsNote')}</p>
        <Bands
          bands={value.bands.hp}
          idPrefix={`${idPrefix}-hp`}
          label={t('settings.rewrites.bandsHp')}
          onChange={(hp) => onChange({ ...value, bands: { ...value.bands, hp } })}
        />
        <Bands
          bands={value.bands.mana}
          idPrefix={`${idPrefix}-mana`}
          label={t('settings.rewrites.bandsMana')}
          onChange={(mana) => onChange({ ...value, bands: { ...value.bands, mana } })}
        />
      </fieldset>

      {editing !== null && edited !== undefined && (
        <RewriteEditor
          bands={value.bands}
          figures={figures}
          idPrefix={`${idPrefix}-${editing}`}
          onChange={(next) =>
            setDesigns(designs.map((design, at) => (at === editing ? next : design)))
          }
          onClose={close}
          palette={palette}
          value={edited}
        />
      )}
    </>
  );
}

/**
 * One vital's bands, each a floor and a colour with a remove beside them — a
 * control row, not a field grid, because a button dressed as a field would
 * have the label removing the band. The sentence about them is written out
 * rather than hung off a mark: a mark nothing points at describes nothing.
 */
function Bands({
  bands,
  idPrefix,
  label,
  onChange
}: {
  bands: readonly ColourBand[];
  idPrefix: string;
  label: string;
  onChange(next: ColourBand[]): void;
}): React.JSX.Element {
  return (
    <>
      <span className="settings-label">{label}</span>
      {bands.map((band, index) => (
        <div className="settings-control-row statline-band" key={index}>
          <NumberField
            label={t('settings.rewrites.bandFromLabel')}
            name={`${idPrefix}-band-${index}-from`}
            onChange={(typed) =>
              onChange(
                bands.map((entry, at) =>
                  at === index ? { ...entry, atLeast: fractionOf(typed) } : entry
                )
              )
            }
            value={percentOf(band.atLeast)}
          />
          <SelectField
            label={t('settings.rewrites.bandColourLabel')}
            name={`${idPrefix}-band-${index}-colour`}
            onChange={(colour) => {
              if (!isAnsiColour(colour)) return;
              onChange(bands.map((entry, at) => (at === index ? { ...entry, colour } : entry)));
            }}
            options={COLOUR_OPTIONS}
            value={band.colour}
          />
          <button
            aria-label={t('settings.rewrites.bandRemoveAria', { number: index + 1 })}
            className="quiet"
            onClick={() => onChange(bands.filter((_, at) => at !== index))}
            type="button"
          >
            <Icon name="close" /> {t('settings.rewrites.bandRemove')}
          </button>
        </div>
      ))}
      <button
        className="quiet add-step"
        onClick={() => onChange([...bands, { atLeast: 0, colour: 'white' }])}
        type="button"
      >
        <Icon name="plus" /> {t('settings.rewrites.addBand')}
      </button>
    </>
  );
}
