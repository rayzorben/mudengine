/**
 * The theme the window wears and the controls that change it: the shape
 * `useTheme` returns, beneath the hook (todo 733) so `lib/palette.ts` takes a
 * `Pick` of it without importing a hook. See `mudengine-ui` › *The visual
 * language is Material + liquid glass*.
 */
import type { ConsolePalette, TerminalPalette, Theme, ThemePreference } from '@shared/themes';

export interface UseTheme {
  /** The resolved theme: chrome tokens plus the terminal palette. */
  theme: Theme;
  /**
   * The sixteen the **console** paints with: the theme's own palette unless a
   * light chrome was asked to leave the console dark, or the player named one
   * of `TERMINAL_THEMES` outright, which outranks both.
   */
  consolePalette: TerminalPalette;
  /** What was asked for, which may be `theme`. */
  consolePreference: ConsolePalette;
  /** What was asked for, which may be `system`. */
  preference: ThemePreference;
  /** Advances through system -> each registered theme, and persists. */
  cycle: () => void;
  /** Pick one by name — the palette's per-theme commands. */
  choose: (preference: ThemePreference) => void;
  /** Pick a console palette by name — the palette's per-palette commands. */
  chooseConsole: (preference: ConsolePalette) => void;
}
