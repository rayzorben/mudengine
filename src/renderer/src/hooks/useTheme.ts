import { useCallback, useEffect, useState } from 'react';

import { useOverridablePreference } from './usePreference';
import {
  consoleThemeFor,
  DEFAULT_THEME,
  isThemePreference,
  resolveTheme,
  THEME_PREFERENCES,
  type Theme,
  type ThemeId,
  type ThemePreference
} from '@shared/themes';

const STORAGE_KEY = 'mudengine.theme';

/**
 * Applies a theme to the document.
 *
 * Chrome tokens are written as inline custom properties on the root element,
 * which is why `tokens.css` must never define a token the stylesheet also needs
 * to override: an inline property beats any selector. `--text-lo` is the one
 * such token, and it is deliberately *not* set here — the theme supplies
 * `--text-lo-normal` and `--text-lo-quiet`, and `tokens.css` chooses between
 * them so the stream-pressure rule keeps working.
 */
function apply(theme: Theme, consoleTheme: Theme): void {
  const root = document.documentElement;

  for (const [token, value] of Object.entries(theme.chrome)) {
    root.style.setProperty(`--${token}`, value);
  }

  // The terminal frame is the terminal's own ground, so it is derived from the
  // palette rather than duplicated as a chrome token that could drift from it —
  // and from the *console's* palette, which under a light theme need not be the
  // chrome's (`ConsoleUiConfig`). A light slate around a dark console would be
  // exactly the drift this line exists to prevent.
  root.style.setProperty('--ink-slate', consoleTheme.terminal.background);

  // Tells the engine which way native widgets, scrollbars and form controls
  // should render. Without it a light theme keeps dark scrollbars.
  root.style.colorScheme = theme.appearance;

  root.dataset['theme'] = theme.id;
  root.dataset['appearance'] = theme.appearance;
}

export interface UseTheme {
  /** The resolved theme: chrome tokens plus the terminal palette. */
  theme: Theme;
  /**
   * The theme the **console** wears, which is `theme` unless a light chrome was
   * asked to leave the console dark. Read for its `terminal` palette only.
   */
  consoleTheme: Theme;
  /** What was asked for, which may be `system`. */
  preference: ThemePreference;
  /** Advances through system -> each registered theme, and persists. */
  cycle: () => void;
  /** Pick one by name — the palette's per-theme commands. */
  choose: (preference: ThemePreference) => void;
}

/**
 * The active theme.
 *
 * @param configured The `ui.theme` value from the options file. Cycling from
 *   the palette overrides it and is remembered; editing the file overrides the
 *   override. See `useOverridablePreference`.
 */
export function useTheme(
  configured: ThemePreference = DEFAULT_THEME,
  keepConsoleDark = false,
  consoleDarkTheme: ThemeId = DEFAULT_THEME
): UseTheme {
  const [preference, setPreference] = useOverridablePreference(
    STORAGE_KEY,
    configured,
    isThemePreference
  );

  /**
   * Tracked as state rather than read at render time so that changing the OS
   * appearance repaints a `system` preference live, without a restart.
   */
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event: MediaQueryListEvent): void => setPrefersDark(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);

  const theme = resolveTheme(preference, prefersDark);
  const consoleTheme = consoleThemeFor(theme, keepConsoleDark, consoleDarkTheme);

  useEffect(() => apply(theme, consoleTheme), [theme, consoleTheme]);

  const cycle = useCallback(() => {
    const index = THEME_PREFERENCES.indexOf(preference);
    setPreference(THEME_PREFERENCES[(index + 1) % THEME_PREFERENCES.length] ?? DEFAULT_THEME);
  }, [preference, setPreference]);

  const choose = useCallback((next: ThemePreference) => setPreference(next), [setPreference]);

  return { theme, consoleTheme, preference, cycle, choose };
}
