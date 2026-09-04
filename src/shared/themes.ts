/**
 * The theme registry.
 *
 * A theme is data, not CSS: one object supplying every colour-bearing token the
 * chrome needs plus the terminal's 16-colour palette. Adding a theme means
 * adding one entry to `THEMES` — the `Theme` type forces it to be complete, so
 * a new theme cannot silently inherit half of another one's palette and it
 * cannot ship missing a token that some component happens to read.
 *
 * Everything that is *not* colour — shape, motion, density, typography — stays
 * in `tokens.css`. Themes change what the instrument is made of, never how it
 * is laid out, and never anything the terminal grid depends on.
 *
 * This module must stay dependency-free: main validates against it, the
 * renderer applies it.
 */

/** Whether a theme reads as light or dark. Drives `color-scheme` and `system`. */
export type Appearance = 'light' | 'dark';

/** Built-in theme identifiers. Extend by adding to `THEMES` below. */
export type ThemeId =
  | 'dark'
  | 'light'
  | 'one-dark'
  | 'dracula'
  | 'nord'
  | 'gruvbox-dark'
  | 'solarized-dark'
  | 'monokai'
  | 'tokyo-night'
  | 'solarized-light'
  | 'github-light'
  | 'one-light'
  | 'gruvbox-light'
  | 'catppuccin-latte'
  | 'rose-pine-dawn'
  | 'ayu-light';

/** What the user may ask for: a specific theme, or "follow the OS". */
export type ThemePreference = ThemeId | 'system';

/**
 * The terminal's 16 ANSI colours plus its ground.
 *
 * Structurally an xterm.js `ITheme`, declared here rather than imported so this
 * module stays importable from the main process.
 *
 * Note the greyscale axis inverts between light and dark themes. On a light
 * ground, colour 0 (`black`) has to *be* the paper — otherwise every
 * `ESC[40m` the server emits paints a dark band across the page — and
 * `brightWhite` becomes the strongest ink rather than the lightest. That is how
 * every credible light terminal theme handles it, and it is why the palette is
 * per-theme data rather than a single palette with a swapped background.
 */
export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * Every colour-bearing chrome token, keyed by its CSS custom property name
 * without the leading dashes. A `Record` of a closed key union rather than a
 * loose map, so the compiler rejects an incomplete theme.
 */
export interface ChromeTokens {
  /** Deepest ground: the app background behind the bento grid. */
  'ink-void': string;
  /** Card fill base. `--glass-fill` mixes transparency into this. */
  'ink-card': string;
  /** Raised control fill: inputs, buttons, chips. */
  'ink-raised': string;
  /** Hairline borders. */
  'ink-line': string;
  /** Heavy brutalist outlines, and the scrollbar thumb. */
  'ink-edge': string;

  'text-hi': string;
  text: string;
  /** Muted text at rest. Read through `--text-lo`; see the note below. */
  'text-lo-normal': string;
  /** Muted text while the stream is under pressure — a step quieter still. */
  'text-lo-quiet': string;

  accent: string;
  ok: string;
  pending: string;
  danger: string;
  marker: string;
  /**
   * Ink laid over a filled accent. Dark-on-tinted in dark themes, white-on-
   * tinted in light ones, because light themes darken their accents to stay
   * readable as text.
   */
  'on-accent': string;

  /** Complete CSS values, not colours: the glass recipe differs per theme. */
  'glass-rim': string;
  'glass-shadow': string;
  /**
   * Elevation. Dark themes lift a surface mostly by lightening it and use
   * shadow only to separate edges; light themes do the reverse. Keeping both
   * as per-theme CSS values is what lets one set of components read correctly
   * either way.
   */
  'elev-1': string;
  'elev-2': string;
  /** Backdrop behind the command palette. */
  scrim: string;
}

export interface Theme {
  id: ThemeId;
  /** Shown in the command palette. */
  label: string;
  appearance: Appearance;
  chrome: ChromeTokens;
  terminal: TerminalPalette;
}

/**
 * Dark — tonal, not black.
 *
 * Surfaces step up in lightness rather than being separated by outlines, which
 * is what keeps a dark UI readable without turning into black-and-white. The
 * accents keep the hue lineage of the terminal's EGA set so chrome and content
 * still rhyme, but at roughly two-thirds the saturation: full-strength `#55ffff`
 * next to a black slate is a glare source, not an accent. See
 * docs/ui-design.md §3.3 and §5.
 */
const DARK: Theme = {
  id: 'dark',
  label: 'Dark',
  appearance: 'dark',
  chrome: {
    'ink-void': '#12151a',
    'ink-card': '#1a1f26',
    'ink-raised': '#222933',
    'ink-line': '#2a323d',
    'ink-edge': '#3a4452',

    'text-hi': '#dbe1e9',
    text: '#a9b3c1',
    'text-lo-normal': '#7f8996',
    'text-lo-quiet': '#69727e',

    accent: '#6fd3de',
    ok: '#6fcf8b',
    pending: '#e8b468',
    danger: '#ef7d7d',
    marker: '#c79ae8',
    'on-accent': '#0c1116',

    'glass-rim': 'inset 0 1px 0 rgb(255 255 255 / 6%)',
    'glass-shadow': '0 6px 24px rgb(0 0 0 / 32%)',
    'elev-1': '0 1px 2px rgb(0 0 0 / 30%)',
    'elev-2': '0 3px 10px rgb(0 0 0 / 34%)',
    scrim: 'rgb(10 13 18 / 58%)'
  },
  /**
   * The classic IBM PC 16-colour palette. xterm.js defaults to a modern scheme
   * whose dark yellow renders brown-grey; MajorMUD's colour-coded output is far
   * easier to read against the original CGA/VGA values.
   */
  terminal: {
    background: '#000000',
    foreground: '#aaaaaa',
    cursor: '#aaaaaa',
    cursorAccent: '#000000',
    selectionBackground: '#264f78',
    black: '#000000',
    red: '#aa0000',
    green: '#00aa00',
    yellow: '#aa5500',
    blue: '#0000aa',
    magenta: '#aa00aa',
    cyan: '#00aaaa',
    white: '#aaaaaa',
    brightBlack: '#555555',
    brightRed: '#ff5555',
    brightGreen: '#55ff55',
    brightYellow: '#ffff55',
    brightBlue: '#5555ff',
    brightMagenta: '#ff55ff',
    brightCyan: '#55ffff',
    brightWhite: '#ffffff'
  }
};

/**
 * Light — soft warm greys, in the register of a modern editor's light theme.
 *
 * Low contrast between *surfaces* and high contrast only where text needs it.
 * Borders are barely there; separation comes from a half-step of tone and a
 * shadow you have to look for.
 *
 * Two deliberate departures from a naive inversion:
 *
 * 1. **Accents darken.** They are used both as chip fills and as running text
 *    (`.link-card`, the rate readout). Bright EGA cyan is unreadable as text on
 *    paper, so each accent keeps its hue and drops its lightness to ~5:1
 *    against the card, and `on-accent` flips to near-white.
 * 2. **The terminal's greyscale axis inverts**, per the note on
 *    `TerminalPalette`. Colour 0 is the paper so `ESC[40m` stays invisible.
 */
const LIGHT: Theme = {
  id: 'light',
  label: 'Light',
  appearance: 'light',
  chrome: {
    'ink-void': '#f2f1ee',
    'ink-card': '#fbfaf8',
    'ink-raised': '#ffffff',
    'ink-line': '#e5e2dc',
    'ink-edge': '#cfcbc3',

    'text-hi': '#25282e',
    text: '#4a4f58',
    'text-lo-normal': '#6b7079',
    'text-lo-quiet': '#878d96',

    accent: '#0f7b86',
    ok: '#2f7d3a',
    pending: '#96650d',
    danger: '#b3403a',
    marker: '#7a4fa8',
    'on-accent': '#ffffff',

    'glass-rim': 'inset 0 1px 0 rgb(255 255 255 / 80%)',
    'glass-shadow': '0 6px 22px rgb(40 34 22 / 8%)',
    'elev-1': '0 1px 2px rgb(40 34 22 / 8%)',
    'elev-2': '0 3px 10px rgb(40 34 22 / 10%)',
    scrim: 'rgb(242 241 238 / 62%)'
  },
  terminal: {
    background: '#fdfcfa',
    foreground: '#4a515e',
    cursor: '#25282e',
    cursorAccent: '#fdfcfa',
    selectionBackground: '#cfe0f0',
    black: '#fdfcfa',
    red: '#b3403a',
    green: '#2f7d3a',
    yellow: '#96650d',
    blue: '#2f52ad',
    magenta: '#7a4fa8',
    cyan: '#0f7b86',
    white: '#4a515e',
    brightBlack: '#c9c5bd',
    brightRed: '#cc5a52',
    brightGreen: '#3f9a4b',
    brightYellow: '#b3801c',
    brightBlue: '#4569c4',
    brightMagenta: '#9268c0',
    brightCyan: '#1a93a0',
    brightWhite: '#25282e'
  }
};

/**
 * The editor themes people already have their eyes trained on.
 *
 * Seven dark and seven light, each derived from the scheme's own ground, ink
 * and five accents, with every text-bearing token then *fitted*: lightness is
 * nudged toward the ink until the pair clears 4.5:1 on the card, which the
 * registry test enforces. Surfaces step from the scheme's ground exactly as
 * the two house themes do (§3.3), so a theme is a palette, never a layout.
 *
 * Chrome only, for now. Every one shares the house terminal palette of its
 * appearance: the console is not a design surface, and its own theming is a
 * separate conversation (TODO.md, "themes").
 */
const EDITOR_THEMES: Record<Exclude<ThemeId, 'dark' | 'light'>, Theme> = {
  'one-dark': {
    id: 'one-dark',
    label: 'One Dark',
    appearance: 'dark',
    chrome: {
      'ink-void': '#282c34',
      'ink-card': '#30353e',
      'ink-raised': '#393e4a',
      'ink-line': '#404754',
      'ink-edge': '#525a6b',
      'text-hi': '#c8cdd5',
      text: '#abb2bf',
      'text-lo-normal': '#9ba0a2',
      'text-lo-quiet': '#8a8f92',
      accent: '#61afef',
      ok: '#98c379',
      pending: '#e5c07b',
      danger: '#e6848d',
      marker: '#cc84e0',
      'on-accent': '#282c34',
      'glass-rim': 'inset 0 1px 0 rgb(255 255 255 / 6%)',
      'glass-shadow': '0 6px 24px rgb(0 0 0 / 32%)',
      'elev-1': '0 1px 2px rgb(0 0 0 / 30%)',
      'elev-2': '0 3px 10px rgb(0 0 0 / 34%)',
      scrim: 'rgb(40 44 52 / 58%)'
    },
    terminal: DARK.terminal
  },
  dracula: {
    id: 'dracula',
    label: 'Dracula',
    appearance: 'dark',
    chrome: {
      'ink-void': '#282a36',
      'ink-card': '#303240',
      'ink-raised': '#383b4c',
      'ink-line': '#404356',
      'ink-edge': '#51556e',
      'text-hi': '#ffffff',
      text: '#f8f8f2',
      'text-lo-normal': '#afb0b0',
      'text-lo-quiet': '#9b9c9e',
      accent: '#8be9fd',
      ok: '#50fa7b',
      pending: '#f1fa8c',
      danger: '#ff6e6e',
      marker: '#bd93f9',
      'on-accent': '#282a36',
      'glass-rim': 'inset 0 1px 0 rgb(255 255 255 / 6%)',
      'glass-shadow': '0 6px 24px rgb(0 0 0 / 32%)',
      'elev-1': '0 1px 2px rgb(0 0 0 / 30%)',
      'elev-2': '0 3px 10px rgb(0 0 0 / 34%)',
      scrim: 'rgb(40 42 54 / 58%)'
    },
    terminal: DARK.terminal
  },
  nord: {
    id: 'nord',
    label: 'Nord',
    appearance: 'dark',
    chrome: {
      'ink-void': '#2e3440',
      'ink-card': '#353c4a',
      'ink-raised': '#3e4656',
      'ink-line': '#454f61',
      'ink-edge': '#576278',
      'text-hi': '#f9fafb',
      text: '#d8dee9',
      'text-lo-normal': '#a2a9b2',
      'text-lo-quiet': '#9197a1',
      accent: '#88c0d0',
      ok: '#a3be8c',
      pending: '#ebcb8b',
      danger: '#d4999b',
      marker: '#c0a0b9',
      'on-accent': '#2e3440',
      'glass-rim': 'inset 0 1px 0 rgb(255 255 255 / 6%)',
      'glass-shadow': '0 6px 24px rgb(0 0 0 / 32%)',
      'elev-1': '0 1px 2px rgb(0 0 0 / 30%)',
      'elev-2': '0 3px 10px rgb(0 0 0 / 34%)',
      scrim: 'rgb(46 52 64 / 58%)'
    },
    terminal: DARK.terminal
  },
  'gruvbox-dark': {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    appearance: 'dark',
    chrome: {
      'ink-void': '#282828',
      'ink-card': '#313131',
      'ink-raised': '#3b3b3b',
      'ink-line': '#444444',
      'ink-edge': '#585858',
      'text-hi': '#f6eeda',
      text: '#ebdbb2',
      'text-lo-normal': '#a79c82',
      'text-lo-quiet': '#948b74',
      accent: '#83a598',
      ok: '#b8bb26',
      pending: '#fabd2f',
      danger: '#fb7061',
      marker: '#d3869b',
      'on-accent': '#282828',
      'glass-rim': 'inset 0 1px 0 rgb(255 255 255 / 6%)',
      'glass-shadow': '0 6px 24px rgb(0 0 0 / 32%)',
      'elev-1': '0 1px 2px rgb(0 0 0 / 30%)',
      'elev-2': '0 3px 10px rgb(0 0 0 / 34%)',
      scrim: 'rgb(40 40 40 / 58%)'
    },
    terminal: DARK.terminal
  },
  'solarized-dark': {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    appearance: 'dark',
    chrome: {
      'ink-void': '#002b36',
      'ink-card': '#003948',
      'ink-raised': '#00495c',
      'ink-line': '#00586e',
      'ink-edge': '#007897',
      'text-hi': '#bdc3c3',
      text: '#a8afaf',
      'text-lo-normal': '#8ca1a5',
      'text-lo-quiet': '#778f94',
      accent: '#2eb1a8',
      ok: '#91a800',
      pending: '#c99900',
      danger: '#ef7e7e',
      marker: '#989ad4',
      'on-accent': '#002b36',
      'glass-rim': 'inset 0 1px 0 rgb(255 255 255 / 6%)',
      'glass-shadow': '0 6px 24px rgb(0 0 0 / 32%)',
      'elev-1': '0 1px 2px rgb(0 0 0 / 30%)',
      'elev-2': '0 3px 10px rgb(0 0 0 / 34%)',
      scrim: 'rgb(0 43 54 / 58%)'
    },
    terminal: DARK.terminal
  },
  monokai: {
    id: 'monokai',
    label: 'Monokai',
    appearance: 'dark',
    chrome: {
      'ink-void': '#272822',
      'ink-card': '#30322a',
      'ink-raised': '#3b3d34',
      'ink-line': '#45463c',
      'ink-edge': '#5a5c4f',
      'text-hi': '#ffffff',
      text: '#f8f8f2',
      'text-lo-normal': '#afafa9',
      'text-lo-quiet': '#9b9b95',
      accent: '#66d9ef',
      ok: '#a6e22e',
      pending: '#e6db74',
      danger: '#f96c9c',
      marker: '#b186ff',
      'on-accent': '#272822',
      'glass-rim': 'inset 0 1px 0 rgb(255 255 255 / 6%)',
      'glass-shadow': '0 6px 24px rgb(0 0 0 / 32%)',
      'elev-1': '0 1px 2px rgb(0 0 0 / 30%)',
      'elev-2': '0 3px 10px rgb(0 0 0 / 34%)',
      scrim: 'rgb(39 40 34 / 58%)'
    },
    terminal: DARK.terminal
  },
  'tokyo-night': {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    appearance: 'dark',
    chrome: {
      'ink-void': '#1a1b26',
      'ink-card': '#212331',
      'ink-raised': '#2a2b3d',
      'ink-line': '#313347',
      'ink-edge': '#414460',
      'text-hi': '#ccd0e6',
      text: '#a9b1d6',
      'text-lo-normal': '#868ba2',
      'text-lo-quiet': '#767a8f',
      accent: '#7dcfff',
      ok: '#9ece6a',
      pending: '#e0af68',
      danger: '#f7768e',
      marker: '#bb9af7',
      'on-accent': '#1a1b26',
      'glass-rim': 'inset 0 1px 0 rgb(255 255 255 / 6%)',
      'glass-shadow': '0 6px 24px rgb(0 0 0 / 32%)',
      'elev-1': '0 1px 2px rgb(0 0 0 / 30%)',
      'elev-2': '0 3px 10px rgb(0 0 0 / 34%)',
      scrim: 'rgb(26 27 38 / 58%)'
    },
    terminal: DARK.terminal
  },
  'solarized-light': {
    id: 'solarized-light',
    label: 'Solarized Light',
    appearance: 'light',
    chrome: {
      'ink-void': '#fcf1d2',
      'ink-card': '#fdf6e3',
      'ink-raised': '#fef9ed',
      'ink-line': '#faeabd',
      'ink-edge': '#f7da8d',
      'text-hi': '#425358',
      text: '#52656c',
      'text-lo-normal': '#657170',
      'text-lo-quiet': '#7c8581',
      accent: '#207970',
      ok: '#687600',
      pending: '#8d6900',
      danger: '#d72825',
      marker: '#6065c1',
      'on-accent': '#ffffff',
      'glass-rim': 'inset 0 1px 0 rgb(255 255 255 / 80%)',
      'glass-shadow': '0 6px 22px rgb(40 34 22 / 8%)',
      'elev-1': '0 1px 2px rgb(40 34 22 / 8%)',
      'elev-2': '0 3px 10px rgb(40 34 22 / 10%)',
      scrim: 'rgb(252 241 210 / 62%)'
    },
    terminal: LIGHT.terminal
  },
  'github-light': {
    id: 'github-light',
    label: 'GitHub Light',
    appearance: 'light',
    chrome: {
      'ink-void': '#f6f6f6',
      'ink-card': '#ffffff',
      'ink-raised': '#ffffff',
      'ink-line': '#ebebeb',
      'ink-edge': '#d1d1d1',
      'text-hi': '#0e1012',
      text: '#24292f',
      'text-lo-normal': '#66696d',
      'text-lo-quiet': '#7d8083',
      accent: '#0969da',
      ok: '#1a7f37',
      pending: '#9a6700',
      danger: '#cf222e',
      marker: '#8250df',
      'on-accent': '#ffffff',
      'glass-rim': 'inset 0 1px 0 rgb(255 255 255 / 80%)',
      'glass-shadow': '0 6px 22px rgb(40 34 22 / 8%)',
      'elev-1': '0 1px 2px rgb(40 34 22 / 8%)',
      'elev-2': '0 3px 10px rgb(40 34 22 / 10%)',
      scrim: 'rgb(246 246 246 / 62%)'
    },
    terminal: LIGHT.terminal
  },
  'one-light': {
    id: 'one-light',
    label: 'One Light',
    appearance: 'light',
    chrome: {
      'ink-void': '#f1f1f1',
      'ink-card': '#fafafa',
      'ink-raised': '#ffffff',
      'ink-line': '#e6e6e6',
      'ink-edge': '#cccccc',
      'text-hi': '#212226',
      text: '#383a42',
      'text-lo-normal': '#707176',
      'text-lo-quiet': '#85868a',
      accent: '#2266f2',
      ok: '#3a7e39',
      pending: '#946601',
      danger: '#d73024',
      marker: '#a626a4',
      'on-accent': '#ffffff',
      'glass-rim': 'inset 0 1px 0 rgb(255 255 255 / 80%)',
      'glass-shadow': '0 6px 22px rgb(40 34 22 / 8%)',
      'elev-1': '0 1px 2px rgb(40 34 22 / 8%)',
      'elev-2': '0 3px 10px rgb(40 34 22 / 10%)',
      scrim: 'rgb(241 241 241 / 62%)'
    },
    terminal: LIGHT.terminal
  },
  'gruvbox-light': {
    id: 'gruvbox-light',
    label: 'Gruvbox Light',
    appearance: 'light',
    chrome: {
      'ink-void': '#faedb6',
      'ink-card': '#fbf1c7',
      'ink-raised': '#fcf3d1',
      'ink-line': '#f8e7a1',
      'ink-edge': '#f5dc71',
      'text-hi': '#211f1e',
      text: '#3c3836',
      'text-lo-normal': '#6f6a5e',
      'text-lo-quiet': '#847e6e',
      accent: '#076678',
      ok: '#6f6c0c',
      pending: '#926110',
      danger: '#9d0006',
      marker: '#8f3f71',
      'on-accent': '#ffffff',
      'glass-rim': 'inset 0 1px 0 rgb(255 255 255 / 80%)',
      'glass-shadow': '0 6px 22px rgb(40 34 22 / 8%)',
      'elev-1': '0 1px 2px rgb(40 34 22 / 8%)',
      'elev-2': '0 3px 10px rgb(40 34 22 / 10%)',
      scrim: 'rgb(250 237 182 / 62%)'
    },
    terminal: LIGHT.terminal
  },
  'catppuccin-latte': {
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    appearance: 'light',
    chrome: {
      'ink-void': '#e4e7ee',
      'ink-card': '#eff1f5',
      'ink-raised': '#f5f6f9',
      'ink-line': '#d6dbe5',
      'ink-edge': '#b7c0d2',
      'text-hi': '#37394b',
      text: '#4c4f69',
      'text-lo-normal': '#686a7b',
      'text-lo-quiet': '#7c7e8d',
      accent: '#1460f5',
      ok: '#2e7c22',
      pending: '#946110',
      danger: '#d20f39',
      marker: '#8839ef',
      'on-accent': '#ffffff',
      'glass-rim': 'inset 0 1px 0 rgb(255 255 255 / 80%)',
      'glass-shadow': '0 6px 22px rgb(40 34 22 / 8%)',
      'elev-1': '0 1px 2px rgb(40 34 22 / 8%)',
      'elev-2': '0 3px 10px rgb(40 34 22 / 10%)',
      scrim: 'rgb(228 231 238 / 62%)'
    },
    terminal: LIGHT.terminal
  },
  'rose-pine-dawn': {
    id: 'rose-pine-dawn',
    label: 'Rosé Pine Dawn',
    appearance: 'light',
    chrome: {
      'ink-void': '#f6ebdf',
      'ink-card': '#faf4ed',
      'ink-raised': '#fcf9f5',
      'ink-line': '#f1e0cd',
      'ink-edge': '#e6c8a5',
      'text-hi': '#413d5b',
      text: '#575279',
      'text-lo-normal': '#6f6b87',
      'text-lo-quiet': '#848096',
      accent: '#286983',
      ok: '#427681',
      pending: '#9b6111',
      danger: '#a75269',
      marker: '#7b659b',
      'on-accent': '#ffffff',
      'glass-rim': 'inset 0 1px 0 rgb(255 255 255 / 80%)',
      'glass-shadow': '0 6px 22px rgb(40 34 22 / 8%)',
      'elev-1': '0 1px 2px rgb(40 34 22 / 8%)',
      'elev-2': '0 3px 10px rgb(40 34 22 / 10%)',
      scrim: 'rgb(246 235 223 / 62%)'
    },
    terminal: LIGHT.terminal
  },
  'ayu-light': {
    id: 'ayu-light',
    label: 'Ayu Light',
    appearance: 'light',
    chrome: {
      'ink-void': '#f1f1f1',
      'ink-card': '#fafafa',
      'ink-raised': '#ffffff',
      'ink-line': '#e6e6e6',
      'ink-edge': '#cccccc',
      'text-hi': '#44474b',
      text: '#5c6166',
      'text-lo-normal': '#6f7177',
      'text-lo-quiet': '#84868b',
      accent: '#1576b2',
      ok: '#5a7c00',
      pending: '#9d630d',
      danger: '#df0f0f',
      marker: '#8b5ac4',
      'on-accent': '#ffffff',
      'glass-rim': 'inset 0 1px 0 rgb(255 255 255 / 80%)',
      'glass-shadow': '0 6px 22px rgb(40 34 22 / 8%)',
      'elev-1': '0 1px 2px rgb(40 34 22 / 8%)',
      'elev-2': '0 3px 10px rgb(40 34 22 / 10%)',
      scrim: 'rgb(241 241 241 / 62%)'
    },
    terminal: LIGHT.terminal
  }
};

export const THEMES: Record<ThemeId, Theme> = {
  dark: DARK,
  light: LIGHT,
  ...EDITOR_THEMES
};

/** Registration order; drives the palette's cycle order. Dark first, then light. */
export const THEME_IDS: readonly ThemeId[] = [
  'dark',
  'one-dark',
  'dracula',
  'nord',
  'gruvbox-dark',
  'solarized-dark',
  'monokai',
  'tokyo-night',
  'light',
  'solarized-light',
  'github-light',
  'one-light',
  'gruvbox-light',
  'catppuccin-latte',
  'rose-pine-dawn',
  'ayu-light'
];

/** Everything selectable in the options file, `system` included. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', ...THEME_IDS];

/**
 * The themes that read the same way round as a given one, in registration
 * order.
 *
 * A card may wear a palette of its own (`CardSettings.theme`), and the offer
 * has to be *within the mode the client is in*: a Dracula card on a GitHub
 * Light rail is not an accent, it is a hole. Filtering the registry is the
 * whole of it — every entry here is already a popular editor theme with its
 * contrast asserted, so a card palette needs no second colour vocabulary and
 * cannot ship illegible.
 */
export function themesOfAppearance(appearance: Appearance): readonly ThemeId[] {
  return THEME_IDS.filter((id) => THEMES[id].appearance === appearance);
}

export const DEFAULT_THEME: ThemeId = 'dark';

export function isThemeId(value: unknown): value is ThemeId {
  // `in` walks the prototype chain, so it would accept 'toString' and
  // 'constructor' — and `THEMES['toString']` is a function, not a theme. An
  // own-property check is what makes this safe to run against config input.
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(THEMES, value);
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || isThemeId(value);
}

/**
 * Resolves a preference to a concrete theme.
 *
 * `system` maps to the first registered theme whose appearance matches the OS,
 * so adding a light theme that should win under `prefers-color-scheme: light`
 * is a matter of registration order rather than another branch here.
 */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): Theme {
  if (preference !== 'system') return THEMES[preference];

  const wanted: Appearance = prefersDark ? 'dark' : 'light';
  const match = THEME_IDS.find((id) => THEMES[id].appearance === wanted);
  return THEMES[match ?? DEFAULT_THEME];
}
