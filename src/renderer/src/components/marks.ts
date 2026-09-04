import type { TerminalMark } from '@shared/types';

/**
 * The glyphs the console draws beside a place it recognised.
 *
 * SVG, on the same 24-unit grid and stroke as `Icon.tsx`, and `currentColor`
 * so the theme's text colour carries it — but as *strings*, because these are
 * injected into an element xterm owns (`registerDecoration`) rather than
 * rendered by React. Each sits beside a name that already says what it is,
 * so the element carries the shop's name as its label rather than a second
 * word.
 */
const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const MARK_GLYPH: Record<TerminalMark['icon'], string> = {
  /* A house: a shop is a building you go into. */
  shop: svg(
    '<path d="M4 11.5 12 5l8 6.5"/><path d="M6 10.5V19h12v-8.5"/><path d="M10 19v-5h4v5"/>'
  ),
  /* A bank: a house with a dollar on its front. */
  bank: svg(
    '<path d="M3.5 10.5 12 4l8.5 6.5"/><path d="M6 9.5V20h12V9.5"/><text x="12" y="17.6" text-anchor="middle" font-size="9.5" font-weight="700" font-family="sans-serif" fill="currentColor" stroke="none">$</text>'
  ),
  /* A steeple. */
  temple: svg(
    '<path d="M12 4v4"/><path d="M10 6h4"/><path d="M6 19V12l6-4 6 4v7"/><path d="M4 19h16"/>'
  ),
  /* A bed. */
  inn: svg(
    '<path d="M4 17V8"/><path d="M4 13h16v4"/><path d="M4 17h16"/><path d="M7 10.5h4v2.5H7Z"/>'
  ),
  /* Crossed swords. */
  trainer: svg(
    '<path d="M5 5l14 14M19 5 5 19"/><path d="M5 5h3v3M19 5h-3v3M5 19h3v-3M19 19h-3v-3"/>'
  )
};
