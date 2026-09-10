/**
 * The status line the player designs, on both settings pages.
 *
 * A layout of `{tags}`, the bands that colour a figure by its share of
 * maximum, and the line as it will be drawn — by the same `renderStatline`
 * the console uses, so the preview and the prompt row cannot disagree. Drawn
 * against the console's own palette rather than the chrome's, because that is
 * where it will be read. `mudengine-ui` § The status line the player designs
 * is drawn at write time, in the prompt row.
 */
import Icon from './Icon';
import { CheckField, NumberField, SelectField, TextField } from './FormField';
import { t } from '../lib/i18n';
import { fractionOf, percentOf } from '../lib/form';
import {
  FIGURE_TAGS,
  renderStatline,
  STATLINE_MAX_CELLS,
  type StatlineDesign,
  type StatlineFigures
} from '@shared/statline';
import { ANSI_COLOURS, isAnsiColour, type ColourBand, type Segment } from '@shared/template';
import type { TerminalPalette } from '@shared/themes';

/**
 * Figures for a page with no character in the realm — the Global page, or a
 * character that is not connected. Plausible rather than round, so the bands
 * have something to colour and a wide layout shows its width.
 */
export const SAMPLE_FIGURES: StatlineFigures = {
  hp: 120,
  hpMax: 156,
  mana: 17,
  manaMax: 28,
  exp: 1386670,
  need: 14402,
  wealth: 2350,
  state: null,
  level: 12,
  room: 'Town Square',
  lives: 9,
  expSession: 12500
};

/** The palette's own names: closed vocabulary, so the words stay in code. */
const COLOUR_OPTIONS = ANSI_COLOURS.map((colour) => ({ value: colour, label: colour }));

const asTags = (names: readonly string[]): string => names.map((name) => `{${name}}`).join(' ');

export interface StatlineDesignerProps {
  value: StatlineDesign;
  onChange(next: StatlineDesign): void;
  palette: TerminalPalette;
  /** The character's own figures, or null to draw the sample. */
  figures: StatlineFigures | null;
  /** The stem every control's name is built from, so two pages never share an id. */
  idPrefix: string;
}

export default function StatlineDesigner({
  value,
  onChange,
  palette,
  figures,
  idPrefix
}: StatlineDesignerProps): React.JSX.Element {
  const drawn = renderStatline(value, figures ?? SAMPLE_FIGURES);
  const cells = drawn?.cells ?? 0;
  const tooWide = cells > STATLINE_MAX_CELLS;
  return (
    <fieldset className="settings-menus">
      <legend>{t('settings.statline.designLegend')}</legend>
      <CheckField
        checked={value.enabled}
        hint={t('settings.statline.enabledHint')}
        label={t('settings.statline.enabledLabel')}
        name={`${idPrefix}-enabled`}
        onChange={(enabled) => onChange({ ...value, enabled })}
      />
      <TextField
        hint={t('settings.statline.layoutHint')}
        label={t('settings.statline.layoutLabel')}
        name={`${idPrefix}-layout`}
        onChange={(layout) => onChange({ ...value, layout })}
        spellCheck={false}
        value={value.layout}
        wide
      />
      <span className="settings-label">{t('settings.statline.previewLabel')}</span>
      <Preview palette={palette} segments={drawn?.segments ?? []} />
      {tooWide ? (
        <p className="settings-warn">
          {t('settings.statline.tooWide', { cells, max: STATLINE_MAX_CELLS })}
        </p>
      ) : (
        <p className="settings-note">
          {t('settings.statline.cells', { cells, max: STATLINE_MAX_CELLS })}
        </p>
      )}
      <p className="settings-note">
        {t('settings.statline.tagsNote', {
          figures: asTags(FIGURE_TAGS),
          colours: asTags(ANSI_COLOURS),
          hex: '{#ff8800}',
          background: '{bg:blue}',
          attributes: asTags(['bold', 'dim', 'reset'])
        })}
      </p>
      <Bands
        bands={value.bands.hp}
        idPrefix={`${idPrefix}-hp`}
        label={t('settings.statline.bandsHp')}
        onChange={(hp) => onChange({ ...value, bands: { ...value.bands, hp } })}
      />
      <Bands
        bands={value.bands.mana}
        idPrefix={`${idPrefix}-mana`}
        label={t('settings.statline.bandsMana')}
        onChange={(mana) => onChange({ ...value, bands: { ...value.bands, mana } })}
      />
    </fieldset>
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
      <p className="settings-note">{t('settings.statline.bandsHint')}</p>
      {bands.map((band, index) => (
        <div className="settings-control-row statline-band" key={index}>
          <NumberField
            label={t('settings.statline.bandFromLabel')}
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
            label={t('settings.statline.bandColourLabel')}
            name={`${idPrefix}-band-${index}-colour`}
            onChange={(colour) => {
              if (!isAnsiColour(colour)) return;
              onChange(bands.map((entry, at) => (at === index ? { ...entry, colour } : entry)));
            }}
            options={COLOUR_OPTIONS}
            value={band.colour}
          />
          <button
            aria-label={t('settings.statline.bandRemoveAria', { number: index + 1 })}
            className="quiet"
            onClick={() => onChange(bands.filter((_, at) => at !== index))}
            type="button"
          >
            <Icon name="close" /> {t('settings.statline.bandRemove')}
          </button>
        </div>
      ))}
      <button
        className="quiet add-step"
        onClick={() => onChange([...bands, { atLeast: 0, colour: 'white' }])}
        type="button"
      >
        <Icon name="plus" /> {t('settings.statline.addBand')}
      </button>
    </>
  );
}

/** The line as the console will draw it: the palette's colours, one row, never wrapped. */
function Preview({
  segments,
  palette
}: {
  segments: readonly Segment[];
  palette: TerminalPalette;
}): React.JSX.Element {
  const colourOf = (colour: string | null): string | undefined =>
    colour === null ? undefined : isAnsiColour(colour) ? palette[colour] : colour;
  return (
    <output
      className="statline-preview"
      style={{ background: palette.background, color: palette.foreground }}
    >
      {segments.length === 0
        ? t('settings.statline.previewEmpty')
        : segments.map((segment, index) => (
            <span
              key={index}
              style={{
                background: colourOf(segment.bg),
                color: colourOf(segment.fg),
                fontWeight: segment.bold ? 700 : undefined,
                opacity: segment.dim ? 0.6 : undefined
              }}
            >
              {segment.text}
            </span>
          ))}
    </output>
  );
}
