import type { MarkIcon } from '@shared/types';

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

export const MARK_GLYPH: Record<MarkIcon, string> = {
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
  ),

  /*
   * The equip gate on a line the client drew (`ui.rewrites`): the pack card's
   * own three glyphs, as strings. A shirt to put on, a filled shirt in use,
   * a struck-through shirt this character may not wear.
   */
  wear: svg(
    '<path d="M8.6 3.2 4.2 5.6l1.6 4 2-.9v9.1h8.4v-9.1l2 .9 1.6-4-4.4-2.4Z"/><path d="M8.6 3.2A3.4 3.4 0 0 0 12 6.3a3.4 3.4 0 0 0 3.4-3.1"/>'
  ),
  worn: svg(
    '<path d="M8.6 3.2 4.2 5.6l1.6 4 2-.9v9.1h8.4v-9.1l2 .9 1.6-4-4.4-2.4Z" fill="currentColor"/>'
  ),
  blocked: svg(
    '<path d="M8.6 3.2 4.2 5.6l1.6 4 2-.9v9.1h8.4v-9.1l2 .9 1.6-4-4.4-2.4Z"/><path d="M8.6 3.2A3.4 3.4 0 0 0 12 6.3a3.4 3.4 0 0 0 3.4-3.1"/><path d="m3.5 3.5 17 17"/>'
  ),

  /*
   * Where a thing is worn, one picture per slot word the listing prints.
   * Drawn simply on purpose: at the console's cell height a glyph is a
   * silhouette, and a detail that does not survive twelve pixels is noise.
   */
  /* A sword, point up. */
  weapon: svg(
    '<path d="M12 2.4 14 6.4v7.6h-4V6.4Z"/><path d="M7.4 14.4h9.2"/><path d="M12 14.4v5"/><path d="M9.7 20.4h4.6"/>'
  ),
  /* A shield. */
  offhand: svg(
    '<path d="M12 3 5 5.8v5.4c0 4.4 3 8.2 7 9.8 4-1.6 7-5.4 7-9.8V5.8Z"/><path d="M12 7v9"/>'
  ),
  /* A helm: a dome with a slit. */
  head: svg('<path d="M5 13a7 7 0 0 1 14 0v5H5Z"/><path d="M8 13h8"/><path d="M12 13v5"/>'),
  /* A glove. */
  hands: svg(
    '<path d="M7 11V5.5a1.5 1.5 0 0 1 3 0V10"/><path d="M10 9.5V4.5a1.5 1.5 0 0 1 3 0V10"/><path d="M13 9.5V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M16 11V8a1.5 1.5 0 0 1 3 0v6a6 6 0 0 1-6 6h-2a6 6 0 0 1-6-6v-3a1.5 1.5 0 0 1 3 0"/>'
  ),
  /* A ring with a stone. */
  finger: svg('<circle cx="12" cy="14" r="5.5"/><path d="M9.5 6.5 12 3l2.5 3.5-2.5 2.2Z"/>'),
  /* A boot. */
  feet: svg('<path d="M7 4h6v8l6 3v4H5v-6a2 2 0 0 1 2-2Z"/><path d="M13 12H7"/>'),
  /* An arm in a sleeve: a bracer. */
  arms: svg('<path d="M8 5h8l1 6-1 8H8L7 11Z"/><path d="M7.5 9h9"/><path d="M7.5 15h9"/>'),
  /* A cloak, hung from the shoulders. */
  back: svg('<path d="M12 3c-2 0-4 1.2-5 3L4 20h16L17 6c-1-1.8-3-3-5-3Z"/><path d="M12 3v17"/>'),
  /* An amulet on a cord. */
  neck: svg('<path d="M5 5c2 5 5 8 7 9 2-1 5-4 7-9"/><circle cx="12" cy="17" r="3"/>'),
  /* A pair of legs: trousers. */
  legs: svg('<path d="M7 4h10l1 16h-5l-1-9-1 9H6Z"/>'),
  /* A belt with a buckle. */
  waist: svg('<path d="M3 9h18v6H3Z"/><path d="M9 9v6M15 9v6"/><path d="M10.5 12h3"/>'),
  /* The shirt, plain. */
  torso: svg('<path d="M8.6 3.2 4.2 5.6l1.6 4 2-.9v9.1h8.4v-9.1l2 .9 1.6-4-4.4-2.4Z"/>'),
  /* A bracelet: a band on a wrist. */
  wrist: svg(
    '<path d="M8 3h8"/><path d="M9 3v4M15 3v4"/><ellipse cx="12" cy="13" rx="6" ry="4.5"/><path d="M9 21h6"/>'
  ),
  /* An earring: a hook and a drop. */
  ears: svg('<path d="M10 4a3 3 0 0 1 4 3v5"/><circle cx="14" cy="16" r="3.5"/>'),
  /* A mask. */
  face: svg(
    '<path d="M4 8c3-1 5-1 8-1s5 0 8 1v3c0 5-4 8-8 8s-8-3-8-8Z"/><path d="M8 12h3M13 12h3"/>'
  ),
  /* A flame: the readied light. */
  readied: svg(
    '<path d="M12 21.5c-3.9 0-6.5-2.6-6.5-6.2 0-3.2 2.3-5.5 3.6-7.4.6 1.3 1.4 2.2 2.4 2.6.2-3 1.4-5.9 3.3-8 .5 3.2 3.7 5.4 3.7 9.3 0 3.9-2.7 7.7-6.5 9.7Z"/>'
  ),
  /* A bag: kit worn somewhere the listing calls only `Worn`. */
  kit: svg('<path d="M5 8.5h14l-1 12H6l-1-12Z"/><path d="M9 8.5V7a3 3 0 0 1 6 0v1.5"/>'),

  /*
   * What can be done with a thing, beside the equip gate: a downward arrow
   * onto a floor for putting it down, and the same struck through for one the
   * realm will not let go of (`Items.Not Droppable`), which is the equip
   * gate's own way of saying *no*.
   */
  drop: svg('<path d="M12 3v11"/><path d="m7.5 10 4.5 4 4.5-4"/><path d="M4 19h16"/>'),
  kept: svg(
    '<path d="M12 3v11"/><path d="m7.5 10 4.5 4 4.5-4"/><path d="M4 19h16"/><path d="m3.5 3.5 17 17"/>'
  )
};
