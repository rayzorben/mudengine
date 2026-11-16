import { useState } from 'react';

import Icon from './Icon';
import { HalfSwitch, ThemePicks } from './ThemeSwatches';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { UseTheme } from '../lib/theme';
import type { Appearance } from '@shared/themes';

export interface ThemePickerProps {
  themes: Pick<UseTheme, 'theme' | 'preference' | 'choose'>;
  onClose(): void;
}

/**
 * The client's theme, chosen by looking (the user, 2026-11-15): a panel at the
 * top middle of the window with the Dark/Light switch and every theme of that half. A
 * click wears the theme at once, and the panel stays up for the next one.
 *
 * No scrim, since the client behind it is what is being looked at. It takes no
 * typed input, so it never takes the caret: the game is played while it is up,
 * and Escape is bound at the window. A pick is remembered as a palette pick is.
 * See `mudengine-ui` › *The visual language is Material + liquid glass*.
 */
export default function ThemePicker({ themes, onClose }: ThemePickerProps) {
  const [half, setHalf] = useState<Appearance>(themes.theme.appearance);
  const followsSystem = themes.preference === 'system';

  return (
    <div
      aria-label={t('themePicker.title')}
      className="surface theme-picker"
      data-theme-picker
      onMouseDown={keepFocus}
      role="dialog"
    >
      <header className="theme-picker-head">
        <span className="card-settings-head">{t('themePicker.title')}</span>
        <HalfSwitch half={half} onChange={setHalf} />
        <button className="quiet" onClick={onClose} title={t('themePicker.close')} type="button">
          <Icon name="close" />
        </button>
      </header>
      <div className="card-palettes" role="group">
        <ThemePicks
          chosen={followsSystem ? undefined : themes.theme.id}
          half={half}
          onPick={themes.choose}
        />
      </div>
      <button
        aria-pressed={followsSystem}
        className="palette-half theme-picker-system"
        data-active={followsSystem ? 'true' : undefined}
        onClick={() => themes.choose('system')}
        type="button"
      >
        {t('themePicker.system')}
      </button>
    </div>
  );
}
