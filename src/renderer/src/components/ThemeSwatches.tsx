/**
 * The pieces a theme is chosen with: a swatch, the Dark/Light switch, and one
 * half of the registry as buttons. Shared by a card's own palette
 * (`CardSettings`) and the client's theme picker (`ThemePicker`). See
 * `mudengine-ui` › *The visual language is Material + liquid glass*.
 */
import { t } from '../lib/i18n';
import {
  APPEARANCES,
  themesOfAppearance,
  THEMES,
  type Appearance,
  type ThemeId
} from '@shared/themes';

/**
 * A palette as a small picture of itself.
 *
 * The colours are read from the theme it previews, so the swatch always shows
 * the palette a card wears; a hand-picked set would be a second copy of the
 * registry's literals. The three dots are the accents a card uses (`accent`,
 * `ok`, `danger`) over the fill, under a bar of the ink.
 */
export function Swatch({ theme }: { theme: ThemeId }) {
  const { chrome } = THEMES[theme];
  return (
    <span
      aria-hidden="true"
      className="swatch"
      style={{ background: chrome['ink-card'], borderColor: chrome['ink-line'] }}
    >
      <span className="swatch-ink" style={{ background: chrome['text-hi'] }} />
      <span className="swatch-dots">
        <span style={{ background: chrome.accent }} />
        <span style={{ background: chrome.ok }} />
        <span style={{ background: chrome.danger }} />
      </span>
    </span>
  );
}

/** What each half of the registry is called on the switch between them. */
const HALF_LABELS: Record<Appearance, string> = {
  dark: t('cards.settings.halves.dark'),
  light: t('cards.settings.halves.light')
};

/** The Dark/Light switch over a grid that shows one half at a time. */
export function HalfSwitch({
  half,
  onChange
}: {
  half: Appearance;
  onChange(half: Appearance): void;
}) {
  return (
    <span aria-label={t('cards.settings.halvesLabel')} className="card-palette-halves" role="group">
      {APPEARANCES.map((option) => (
        <button
          aria-pressed={half === option}
          className="palette-half"
          data-active={half === option ? 'true' : undefined}
          data-half={option}
          key={option}
          onClick={() => onChange(option)}
          type="button"
        >
          {HALF_LABELS[option]}
        </button>
      ))}
    </span>
  );
}

/** One half of the registry, a button per theme, for a `.card-palettes` grid. */
export function ThemePicks({
  half,
  chosen,
  onPick
}: {
  half: Appearance;
  /** The one worn now, or undefined when none of them is. */
  chosen: ThemeId | undefined;
  onPick(theme: ThemeId): void;
}) {
  return (
    <>
      {themesOfAppearance(half).map((id) => (
        <button
          aria-pressed={chosen === id}
          className="palette-pick"
          data-active={chosen === id ? 'true' : undefined}
          data-theme-pick={id}
          key={id}
          onClick={() => onPick(id)}
          // The theme's own name, which stays in code with the rest of the
          // closed-union vocabulary rendered as itself.
          title={THEMES[id].label}
          type="button"
        >
          <Swatch theme={id} />
          <span className="palette-name">{THEMES[id].label}</span>
        </button>
      ))}
    </>
  );
}
