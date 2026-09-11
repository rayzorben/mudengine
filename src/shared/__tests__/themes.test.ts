import { describe, expect, it } from 'vitest';

import {
  CONSOLE_PALETTES,
  consolePaletteFor,
  consoleThemeFor,
  DEFAULT_CONSOLE_PALETTE,
  DEFAULT_THEME,
  isConsolePalette,
  isTerminalThemeId,
  TERMINAL_THEME_IDS,
  TERMINAL_THEMES,
  terminalThemesOfAppearance,
  isDarkTheme,
  isThemeId,
  isThemePreference,
  resolveTheme,
  THEME_IDS,
  THEME_PREFERENCES,
  themesOfAppearance,
  THEMES,
  type Theme,
  type TerminalPalette
} from '../themes';

const ALL: Theme[] = THEME_IDS.map((id) => THEMES[id]);

/** sRGB relative luminance, per WCAG 2.1. */
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

/**
 * `color-mix(in srgb, a <p>%, b)`, as the engine computes it.
 *
 * sRGB and non-premultiplied, so it is a plain per-channel interpolation of
 * the gamma-encoded bytes — which is what CSS does for two opaque colours in
 * this colour space, and is why the result is not the midpoint of their
 * luminances.
 */
function mix(a: string, b: string, p: number): string {
  const channels = [1, 3, 5].map((at) => {
    const from = Number.parseInt(a.slice(at, at + 2), 16);
    const to = Number.parseInt(b.slice(at, at + 2), 16);
    return Math.round(from * p + to * (1 - p))
      .toString(16)
      .padStart(2, '0');
  });
  return `#${channels.join('')}`;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe('theme registry', () => {
  it('registers every id it lists, and lists every id it registers', () => {
    expect([...THEME_IDS].sort()).toEqual(Object.keys(THEMES).sort());
  });

  it('gives every theme an id matching its key', () => {
    for (const id of THEME_IDS) expect(THEMES[id].id).toBe(id);
  });

  it('offers system plus every theme as a preference', () => {
    expect(THEME_PREFERENCES).toEqual(['system', ...THEME_IDS]);
  });

  it('ships one theme of each appearance, so `system` can always resolve', () => {
    const appearances = new Set(ALL.map((theme) => theme.appearance));
    expect(appearances).toContain('dark');
    expect(appearances).toContain('light');
  });

  it('gives every theme a distinct human label', () => {
    const labels = ALL.map((theme) => theme.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  // The Theme type enforces completeness at compile time; this catches the
  // runtime shape drifting via a cast or a hand-edited literal.
  it('gives every theme the same complete set of chrome tokens', () => {
    const reference = Object.keys(THEMES[DEFAULT_THEME].chrome).sort();
    for (const theme of ALL) {
      expect(Object.keys(theme.chrome).sort(), `${theme.id} chrome`).toEqual(reference);
    }
  });

  it('gives every theme the same complete terminal palette', () => {
    const reference = Object.keys(THEMES[DEFAULT_THEME].terminal).sort();
    for (const theme of ALL) {
      expect(Object.keys(theme.terminal).sort(), `${theme.id} terminal`).toEqual(reference);
    }
  });

  it('leaves no token empty', () => {
    for (const theme of ALL) {
      for (const [token, value] of Object.entries(theme.chrome)) {
        expect(value.trim(), `${theme.id}.${token}`).not.toBe('');
      }
      for (const [token, value] of Object.entries(theme.terminal)) {
        expect(value, `${theme.id}.terminal.${token}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});

describe('theme legibility', () => {
  // Accents are used both as chip backgrounds and as running text, so each one
  // has to clear a text threshold against the card it sits on. This is the
  // check a new theme is most likely to fail.
  const ACCENTS = ['accent', 'ok', 'pending', 'danger', 'marker'] as const;

  it('keeps every accent legible as text on the card fill', () => {
    for (const theme of ALL) {
      for (const key of ACCENTS) {
        const ratio = contrast(theme.chrome[key], theme.chrome['ink-card']);
        expect(ratio, `${theme.id}.${key} on ink-card = ${ratio.toFixed(2)}:1`).toBeGreaterThan(
          4.5
        );
      }
    }
  });

  it('keeps ink on an accent block legible', () => {
    for (const theme of ALL) {
      for (const key of ACCENTS) {
        const ratio = contrast(theme.chrome['on-accent'], theme.chrome[key]);
        expect(ratio, `${theme.id}.on-accent on ${key} = ${ratio.toFixed(2)}:1`).toBeGreaterThan(
          4.5
        );
      }
    }
  });

  /*
   * The Talk card tempers a channel's hue into the card's own ink before
   * drawing a message with it — `color-mix(in srgb, <hue> 55%, var(--text))`,
   * because a whole card of prose at full accent strength is the spraying §9
   * warns about. Contrast is not linear, so "both operands are legible" is not
   * an argument that the mixture is; the accent check above covers `.channel`
   * and `.who` at full strength and covered nothing here.
   *
   * Only the three hues the wire actually assigns (`mudengine-wire`): magenta
   * for gossip and auction, amber for broadcast and gangpath, green for the
   * local channels.
   */
  it('keeps a channel hue tempered into the ink legible as running text', () => {
    const TEMPERED = ['marker', 'pending', 'ok'] as const;
    for (const theme of ALL) {
      for (const key of TEMPERED) {
        const mixed = mix(theme.chrome[key], theme.chrome.text, 0.55);
        const ratio = contrast(mixed, theme.chrome['ink-card']);
        expect(
          ratio,
          `${theme.id}: 55% ${key} into text = ${ratio.toFixed(2)}:1 on ink-card`
        ).toBeGreaterThan(4.5);
      }
    }
  });

  /*
   * The Self card draws an attribute against the range its own race runs:
   * `color-mix(in srgb, var(--accent) <share>, var(--text-lo))`, the share
   * being the figure's place between the race's floor and ceiling. Both ends
   * are checked above and neither argument covers the middle, for the reason
   * the channel hue states: contrast is not linear.
   */
  it('keeps an attribute legible anywhere in its race’s range', () => {
    for (const theme of ALL) {
      for (const share of [0, 0.25, 0.5, 0.75, 1]) {
        const mixed = mix(theme.chrome.accent, theme.chrome['text-lo-normal'], share);
        const ratio = contrast(mixed, theme.chrome['ink-card']);
        expect(
          ratio,
          `${theme.id}: ${share * 100}% accent into text-lo = ${ratio.toFixed(2)}:1 on ink-card`
        ).toBeGreaterThan(4.5);
      }
    }
  });

  it('keeps body and muted text legible on the card fill', () => {
    for (const theme of ALL) {
      for (const key of ['text-hi', 'text', 'text-lo-normal'] as const) {
        const ratio = contrast(theme.chrome[key], theme.chrome['ink-card']);
        expect(ratio, `${theme.id}.${key} = ${ratio.toFixed(2)}:1`).toBeGreaterThan(4.5);
      }
    }
  });

  it('keeps the quiet muted text dimmer than the normal one', () => {
    // Stream pressure should reduce emphasis, never raise it.
    for (const theme of ALL) {
      const normal = contrast(theme.chrome['text-lo-normal'], theme.chrome['ink-card']);
      const quiet = contrast(theme.chrome['text-lo-quiet'], theme.chrome['ink-card']);
      expect(quiet, theme.id).toBeLessThan(normal);
    }
  });

  it('keeps the terminal foreground legible on its own ground', () => {
    for (const theme of ALL) {
      const ratio = contrast(theme.terminal.foreground, theme.terminal.background);
      expect(ratio, `${theme.id} = ${ratio.toFixed(2)}:1`).toBeGreaterThan(4.5);
    }
  });

  it('matches colour 0 to the ground so a black-background run stays invisible', () => {
    // The server paints large areas with ESC[40m. If colour 0 is not the
    // terminal's own ground, a light theme gets a dark band across the page.
    for (const theme of ALL) {
      expect(theme.terminal.black.toLowerCase(), theme.id).toBe(
        theme.terminal.background.toLowerCase()
      );
    }
  });

  it('makes brightWhite the most emphatic ink, whichever way the theme runs', () => {
    for (const theme of ALL) {
      const bright = contrast(theme.terminal.brightWhite, theme.terminal.background);
      const plain = contrast(theme.terminal.white, theme.terminal.background);
      expect(bright, theme.id).toBeGreaterThan(plain);
    }
  });
});

/*
 * A card may wear a palette of its own, and the offer has to be within the mode
 * the client is in: a Dracula card on a GitHub Light rail is not an accent.
 */
describe('themesOfAppearance', () => {
  it('offers only the themes that read the same way round', () => {
    for (const appearance of ['light', 'dark'] as const) {
      const offered = themesOfAppearance(appearance);
      expect(offered.length).toBeGreaterThan(0);
      for (const id of offered) expect(THEMES[id].appearance, id).toBe(appearance);
    }
  });

  it('accounts for every registered theme between the two', () => {
    expect([...themesOfAppearance('dark'), ...themesOfAppearance('light')].sort()).toEqual(
      [...THEME_IDS].sort()
    );
  });

  it('keeps the registry order, so a palette does not move between openings', () => {
    const dark = themesOfAppearance('dark');
    const positions = dark.map((id) => THEME_IDS.indexOf(id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe('resolveTheme', () => {
  it('returns the named theme regardless of the OS setting', () => {
    expect(resolveTheme('light', true).id).toBe('light');
    expect(resolveTheme('dark', false).id).toBe('dark');
  });

  it('follows the OS when asked for system', () => {
    expect(resolveTheme('system', true).appearance).toBe('dark');
    expect(resolveTheme('system', false).appearance).toBe('light');
  });
});

describe('guards', () => {
  it('accepts registered ids and rejects anything else', () => {
    expect(isThemeId('dark')).toBe(true);
    expect(isThemeId('light')).toBe(true);
    expect(isThemeId('system')).toBe(false);
    expect(isThemeId('solarized')).toBe(false);
    expect(isThemeId(null)).toBe(false);
    expect(isThemeId(7)).toBe(false);
  });

  it('does not treat inherited Object properties as themes', () => {
    // `value in THEMES` would otherwise say yes to these.
    expect(isThemeId('toString')).toBe(false);
    expect(isThemeId('constructor')).toBe(false);
  });

  it('accepts system as a preference but not as an id', () => {
    expect(isThemePreference('system')).toBe(true);
    expect(isThemePreference('dark')).toBe(true);
    expect(isThemePreference('nope')).toBe(false);
  });
});

/**
 * The console's own ground when the chrome's is light.
 *
 * Pure and here rather than in the renderer because the terminal frame
 * (`--ink-slate`) is derived from whichever palette this answers with, and the
 * two must not be able to disagree about which one that is.
 */
describe('the console keeping its own ground', () => {
  it('leaves a dark chrome alone: there is nothing to part from', () => {
    expect(consoleThemeFor(THEMES.dracula, true, 'nord').id).toBe('dracula');
    expect(consoleThemeFor(THEMES.dark, true, 'nord').id).toBe('dark');
  });

  it('leaves a light chrome alone when nobody asked', () => {
    expect(consoleThemeFor(THEMES.light, false, 'nord').id).toBe('light');
  });

  it('hands a light chrome the dark palette that was asked for', () => {
    const answer = consoleThemeFor(THEMES['github-light'], true, 'nord');
    expect(answer.id).toBe('nord');
    expect(answer.appearance).toBe('dark');
  });

  it('refuses a light palette for a console asked to stay dark', () => {
    // Not a preference but a contradiction, so it is answered rather than obeyed.
    expect(consoleThemeFor(THEMES.light, true, 'ayu-light' as never).id).toBe(DEFAULT_THEME);
    expect(consoleThemeFor(THEMES.light, true, 'nope' as never).id).toBe(DEFAULT_THEME);
  });

  it('is dark whatever it answers with, for every light theme in the registry', () => {
    for (const id of themesOfAppearance('light')) {
      expect(consoleThemeFor(THEMES[id], true, DEFAULT_THEME).appearance).toBe('dark');
    }
  });
});

describe('isDarkTheme', () => {
  it('accepts only registered dark ids', () => {
    expect(isDarkTheme('dark')).toBe(true);
    expect(isDarkTheme('nord')).toBe(true);
    expect(isDarkTheme('light')).toBe(false);
    expect(isDarkTheme('ayu-light')).toBe(false);
    expect(isDarkTheme('system')).toBe(false);
    expect(isDarkTheme(null)).toBe(false);
  });

  it('agrees with the registry it is offered from', () => {
    // The settings screen offers `themesOfAppearance('dark')` and the file
    // coerces with this; a form must not offer what the file refuses.
    for (const id of themesOfAppearance('dark')) expect(isDarkTheme(id)).toBe(true);
    for (const id of themesOfAppearance('light')) expect(isDarkTheme(id)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * Console palettes
 * ---------------------------------------------------------------------- */

const PALETTES = TERMINAL_THEME_IDS.map((id) => TERMINAL_THEMES[id]);

/** The seven chromatics plus grey, in the order a palette declares them. */
const RAMP = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
const BRIGHT = [
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const;

/** CIE76 in Lab. Enough to say two colours are not the same colour. */
function lab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number
  ];
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function deltaE(a: string, b: string): number {
  const [x, y] = [lab(a), lab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

describe('console palette registry', () => {
  it('registers every id it lists, and lists every id it registers', () => {
    expect([...TERMINAL_THEME_IDS].sort()).toEqual(Object.keys(TERMINAL_THEMES).sort());
  });

  it('gives every palette an id matching its key', () => {
    for (const id of TERMINAL_THEME_IDS) expect(TERMINAL_THEMES[id].id).toBe(id);
  });

  it('offers `theme` plus every palette, in registration order', () => {
    expect(CONSOLE_PALETTES).toEqual(['theme', ...TERMINAL_THEME_IDS]);
    expect(CONSOLE_PALETTES[0]).toBe(DEFAULT_CONSOLE_PALETTE);
  });

  it('ships four dark and three light', () => {
    expect(terminalThemesOfAppearance('dark')).toHaveLength(4);
    expect(terminalThemesOfAppearance('light')).toHaveLength(3);
  });

  it('gives every palette a distinct human label', () => {
    const labels = PALETTES.map((entry) => entry.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('gives every palette the same complete set of colours, all six-digit hex', () => {
    const reference = Object.keys(THEMES[DEFAULT_THEME].terminal).sort();
    for (const entry of PALETTES) {
      expect(Object.keys(entry.palette).sort(), `${entry.id}`).toEqual(reference);
      for (const [key, value] of Object.entries(entry.palette)) {
        expect(value, `${entry.id}.${key}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  // `ESC[40m` fills with colour 0. If it is not the ground, a realm that sets
  // its own background paints a band across a page that already was that
  // colour — which is the whole reason the greyscale axis inverts on light.
  it('makes colour 0 the ground, exactly', () => {
    for (const entry of PALETTES) {
      expect(entry.palette.black, `${entry.id}`).toBe(entry.palette.background);
    }
  });
});

describe('console palette legibility', () => {
  // The point of these seven: `#0000aa` on black is why `blue` was a colour
  // nobody used. Every colour the realm can select has to be readable as text
  // on the ground it will be drawn against — the dim ramp included, which is
  // where the shipped IBM set falls down.
  it('keeps all sixteen legible on their own ground', () => {
    for (const entry of PALETTES) {
      const p: TerminalPalette = entry.palette;
      const keys = ['foreground', ...RAMP, 'brightBlack', ...BRIGHT] as const;
      for (const key of keys) {
        const ratio = contrast(p[key], p.background);
        expect(ratio, `${entry.id}.${key} on its ground = ${ratio.toFixed(2)}:1`).toBeGreaterThan(
          4.5
        );
      }
    }
  });

  it('keeps the six chromatics tellable apart, in both ramps', () => {
    for (const entry of PALETTES) {
      for (const set of [RAMP.slice(0, 6), BRIGHT.slice(0, 6)]) {
        for (let i = 0; i < set.length; i++) {
          for (let j = i + 1; j < set.length; j++) {
            const [a, b] = [set[i] as keyof TerminalPalette, set[j] as keyof TerminalPalette];
            const d = deltaE(entry.palette[a], entry.palette[b]);
            expect(d, `${entry.id} ${a}/${b} dE=${d.toFixed(1)}`).toBeGreaterThan(22);
          }
        }
      }
    }
  });

  // Bold is emphasis whichever way the ground reads. On a light palette that
  // means the bright ramp goes *deeper* than its dim, not lighter — but either
  // way the two have to be different enough that bold says something.
  it('keeps every bright tellable from its own dim', () => {
    for (const entry of PALETTES) {
      for (let i = 0; i < RAMP.length; i++) {
        const [dim, bright] = [
          RAMP[i] as keyof TerminalPalette,
          BRIGHT[i] as keyof TerminalPalette
        ];
        const d = deltaE(entry.palette[dim], entry.palette[bright]);
        expect(d, `${entry.id} ${dim}/${bright} dE=${d.toFixed(1)}`).toBeGreaterThan(12);
      }
    }
  });

  it('keeps a selection readable, and the cursor visible', () => {
    for (const entry of PALETTES) {
      const p = entry.palette;
      expect(
        contrast(p.foreground, p.selectionBackground),
        `${entry.id} selection`
      ).toBeGreaterThan(3);
      expect(contrast(p.cursor, p.background), `${entry.id} cursor`).toBeGreaterThan(3);
    }
  });
});

describe('consolePaletteFor', () => {
  it('defers to the theme the console resolved to when nothing was named', () => {
    for (const id of THEME_IDS) {
      expect(consolePaletteFor(THEMES[id], 'theme')).toBe(THEMES[id].terminal);
    }
  });

  // The default has to be the client exactly as it was, or every existing
  // options file changes what it looks like on the day this shipped.
  it('leaves the shipped default alone', () => {
    const console = consoleThemeFor(THEMES.dark, true, DEFAULT_THEME);
    expect(consolePaletteFor(console, DEFAULT_CONSOLE_PALETTE)).toEqual(THEMES.dark.terminal);
  });

  it('lets a named palette outrank the theme, and `keepDark` with it', () => {
    // A palette the player named is an answer to the question `keepDark` asks,
    // so it wins — including a light palette under a light chrome kept dark.
    const console = consoleThemeFor(THEMES.light, true, 'nord');
    expect(consolePaletteFor(console, 'neon-night')).toBe(TERMINAL_THEMES['neon-night'].palette);
    expect(consolePaletteFor(console, 'parchment')).toBe(TERMINAL_THEMES.parchment.palette);
  });
});

describe('isTerminalThemeId / isConsolePalette', () => {
  it('accepts only registered ids, and `theme` only as a palette choice', () => {
    expect(isTerminalThemeId('neon-night')).toBe(true);
    expect(isTerminalThemeId('theme')).toBe(false);
    expect(isTerminalThemeId('dark')).toBe(false);
    expect(isConsolePalette('theme')).toBe(true);
    expect(isConsolePalette('neon-night')).toBe(true);
    expect(isConsolePalette('dark')).toBe(false);
    expect(isConsolePalette(null)).toBe(false);
  });

  it('refuses what the prototype chain would otherwise answer for', () => {
    expect(isTerminalThemeId('toString')).toBe(false);
    expect(isConsolePalette('constructor')).toBe(false);
  });

  it('agrees with everything the form and the palette offer', () => {
    for (const entry of CONSOLE_PALETTES) expect(isConsolePalette(entry)).toBe(true);
  });
});
