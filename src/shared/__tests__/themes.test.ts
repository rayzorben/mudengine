import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THEME,
  isThemeId,
  isThemePreference,
  resolveTheme,
  THEME_IDS,
  THEME_PREFERENCES,
  themesOfAppearance,
  THEMES,
  type Theme
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
