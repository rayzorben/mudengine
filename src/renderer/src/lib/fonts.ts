/**
 * Font-stack helpers for the renderer.
 *
 * The console is a character grid, not a text flow. Its correctness depends on
 * every glyph occupying exactly one cell: the game draws maps, frames and stat
 * columns by counting characters, and a proportional face shears all three.
 * `measurePitch` is how that assumption gets checked against what the browser
 * actually resolved, rather than what the config asked for.
 */

import { tuning } from './tuning';

/**
 * Characters chosen for maximum width divergence in a proportional face.
 * In any monospace font they measure identically; in a proportional one 'W' is
 * typically 3–4x 'i'. The CP437 block is included because a modern text font
 * may be monospace for Latin and still fall back to a differently-sized face
 * for box-drawing — the exact failure that corrupts MajorMUD's banners.
 */
const PROBES = ['i', 'W', 'M', '.', '█'] as const;

let canvas: HTMLCanvasElement | null = null;

function context(): CanvasRenderingContext2D | null {
  if (!canvas) canvas = document.createElement('canvas');
  return canvas.getContext('2d');
}

export interface PitchReport {
  /** True if every probe glyph measured the same advance width. */
  monospace: boolean;
  /** The widest probe, for reporting which glyph broke the grid. */
  widest: string;
  narrowest: string;
}

/**
 * Measures the resolved font's advance widths.
 *
 * Returns `monospace: true` when measurement is unavailable — a headless or
 * canvas-less context should not produce a spurious warning.
 */
export function measurePitch(fontStack: string, sizePx: number): PitchReport {
  const ctx = context();
  if (!ctx) return { monospace: true, widest: '', narrowest: '' };

  ctx.font = `${sizePx}px ${fontStack}`;

  let widest: string = PROBES[0];
  let narrowest: string = PROBES[0];
  let max = -Infinity;
  let min = Infinity;

  for (const probe of PROBES) {
    const width = ctx.measureText(probe).width;
    if (width > max) {
      max = width;
      widest = probe;
    }
    if (width < min) {
      min = width;
      narrowest = probe;
    }
  }

  if (!Number.isFinite(max) || max <= 0) return { monospace: true, widest: '', narrowest: '' };

  return { monospace: (max - min) / max <= tuning().fontTolerance, widest, narrowest };
}
