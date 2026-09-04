import { memo, type ReactNode } from 'react';

/**
 * The icon set, drawn rather than typed.
 *
 * Every menu in this client is a column of sentences, and a column of sentences
 * is read word by word — which is the slowest way to find something you already
 * know the shape of. A glyph in front of each row is what turns "read the list"
 * into "look for the one with the clipboard", and it is the difference between
 * a palette somebody scans and a palette somebody reads.
 *
 * **Inline SVG, one stroke weight, `currentColor`.** Not an icon font and not a
 * dependency: a font is a second thing to load before the chrome is legible,
 * and a set pulled in whole costs a megabyte to use thirty glyphs from. Taking
 * the colour from the text means an entry that is greyed out, in danger red, or
 * highlighted takes its icon with it — a two-tone icon would need a rule per
 * state and would drift from the one it sits beside.
 *
 * The grid is 24 units and the strokes are open paths, so the same glyph reads
 * at 14px in a menu and at 18px on a button without being redrawn.
 */
export type IconName =
  | 'settings'
  | 'server'
  | 'play'
  | 'stop'
  | 'pause'
  | 'skip'
  | 'reverse'
  | 'loop'
  | 'user'
  | 'users'
  | 'popout'
  | 'popin'
  | 'route'
  | 'search'
  | 'activity'
  | 'jumpDown'
  | 'layout'
  | 'density'
  | 'terminal'
  | 'theme'
  | 'columns'
  | 'folder'
  | 'fileText'
  | 'split'
  | 'close'
  | 'copy'
  | 'more'
  | 'trash'
  | 'paste'
  | 'edit'
  | 'plus'
  | 'check'
  | 'login'
  | 'reset'
  | 'pin'
  | 'unpin'
  | 'help'
  | 'chevronDown'
  | 'chevronRight'
  | 'chevronUp'
  | 'undo'
  | 'redo'
  /*
   * The toolbar's vocabulary. One glyph per automation switch, because the
   * toolbar is a row of glyphs with no labels on it — the label is the
   * tooltip and the accessible name, and the kebab's menu spells every one of
   * them out. `Command` and `MenuItem` already require an icon for the reason
   * this row is: labels that stop starting in the same column.
   */
  | 'logout'
  | 'bolt'
  | 'sword'
  | 'shield'
  | 'shirt'
  | 'shirtOff'
  | 'shirtWorn'
  | 'crosshair'
  | 'run'
  | 'unplug'
  | 'coins'
  | 'door'
  | 'key'
  | 'hammer'
  | 'eye'
  | 'eyeOff'
  | 'heart'
  | 'moon'
  | 'at'
  | 'broadcast'
  | 'flame'
  | 'bag';

const ICONS: Record<IconName, ReactNode> = {
  /*
   * The one glyph in the set that is a *control the reader operates on itself*
   * rather than a picture of a thing: it opens the one sentence explaining the
   * field beside it. Drawn small and quiet on purpose — a question mark that
   * competed with the label would be a screen asking to be read rather than
   * used. See docs/terminology.md §1.
   */
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.4 9.2a2.7 2.7 0 0 1 5.2.9c0 1.8-2.6 2.2-2.6 4" />
      <path d="M12 17.4h.01" />
    </>
  ),
  /*
   * A gear, not the sliders this used to be.
   *
   * Sliders are a fair picture of what the screen holds and the wrong picture
   * of what people are looking for: a cog has meant "settings" on every phone
   * and desktop for fifteen years, and an icon is only worth drawing if it is
   * recognised before it is read. Drawn as a ring with eight teeth crossing it
   * rather than as one toothed outline, because a single path with that many
   * corners turns to mush at the 14px this is used at in a menu.
   */
  settings: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <circle cx="12" cy="12" r="7.3" />
      <path d="M12 2.6v2.8M12 18.6v2.8M21.4 12h-2.8M5.4 12H2.6M18.63 5.37l-1.98 1.98M7.35 16.65l-1.98 1.98M18.63 18.63l-1.98-1.98M7.35 7.35L5.37 5.37" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  /*
   * Filled, unlike everything else here. These two are the only glyphs in the
   * set that are a *transport control* rather than a picture of a thing, and
   * every player has met a solid triangle and a solid square in that role for
   * forty years. An outlined one reads as a diagram of a triangle.
   */
  play: <path d="M8 5.5v13l10.5-6.5Z" fill="currentColor" stroke="none" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none" />,
  /*
   * The transport family beside play and stop, filled like them: two bars,
   * a bar with a triangle against it, and a pair of arrows. Filled because an
   * outlined pause is two rectangles and an outlined skip is a diagram; the
   * silhouettes are what forty years of players read.
   */
  pause: (
    <>
      <rect x="6.5" y="5.5" width="4" height="13" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.5" y="5.5" width="4" height="13" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  skip: (
    <>
      <path d="M6 5.5v13l9-6.5Z" fill="currentColor" stroke="none" />
      <rect x="16" y="5.5" width="2.5" height="13" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  reverse: (
    <>
      <path d="M5 9h12l-3-3" />
      <path d="M19 15H7l3 3" />
    </>
  ),
  /*
   * A loop: the route walked round and round, not the walking of it.
   *
   * Distinct from `route` on purpose, which the toolbar's walk control and the
   * palette's own loop rows already use — a shelf of four hundred loops and
   * the button that stops a walk are not the same thing, and two controls one
   * glyph apart on the same strip is the one arrangement a toolbar cannot
   * survive. A closed circuit with an arrowhead on it: the shape says
   * "round again", which is the whole of what a loop is.
   */
  loop: (
    <>
      <path d="M17.5 7.5a7 7 0 1 1-5.5-2.5" />
      <path d="M14 4.5l4 .5-.5 4" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M2.5 20c0-3.1 2.9-5.2 6.5-5.2s6.5 2.1 6.5 5.2" />
      <path d="M16.5 5.4a3.2 3.2 0 0 1 0 5.9" />
      <path d="M18 15.2c2.1.7 3.5 2.2 3.5 4.3" />
    </>
  ),
  popout: (
    <>
      <path d="M19 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4.5" />
      <path d="M14 4h6v6" />
      <path d="M20 4l-7.5 7.5" />
    </>
  ),
  popin: (
    <>
      <path d="M13.5 4H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4.5" />
      <path d="M9 8l-4 4 4 4" />
      <path d="M5 12h10" />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M6 15.5V10a4 4 0 0 1 4-4h5.5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.6-4.6" />
    </>
  ),
  activity: <path d="M3 12h3.5l3-7 4 14 3-7H21" />,
  jumpDown: (
    <>
      <path d="M12 4v11" />
      <path d="M7.5 10.5L12 15l4.5-4.5" />
      <path d="M5 19h14" />
    </>
  ),
  // A disclosure chevron, one stroke each way: which way a collapsed thing opens.
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  // And upward, for reordering a priority list: the row moves the way it points.
  chevronUp: <path d="M6 15l6-6 6 6" />,
  /*
   * Stepping back and forward: an arrow that turns round on itself, mirrored.
   * The pair has to read as one control seen twice, so they are the same curve
   * and the same head, reflected -- an undo drawn as a circular arrow beside a
   * redo drawn as a straight one is two ideas where there is one.
   */
  undo: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h9a6 6 0 0 1 0 12h-3" />
    </>
  ),
  redo: (
    <>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9h-9a6 6 0 0 0 0 12h3" />
    </>
  ),
  layout: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  density: <path d="M4 6h16M4 10h16M4 14h10M4 18h10" />,
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9.5l3 2.5-3 2.5M12.5 15H17" />
    </>
  ),
  theme: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" />
    </>
  ),
  columns: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  folder: (
    <path d="M4 7a2 2 0 0 1 2-2h3.2l2 2.5H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
  ),
  fileText: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </>
  ),
  split: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 12h18" />
    </>
  ),
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  /* Three dots down, the kebab: where a card's actions fold past four. */
  more: (
    <>
      <circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  /* A bin, for striking a record out. */
  trash: (
    <>
      <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5" />
      <path d="M10 10.5v6M14 10.5v6" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      {/* The sheet behind, as the two edges of it that show. */}
      <path d="M15 4.5H6.5a2 2 0 0 0-2 2v9" />
    </>
  ),
  paste: (
    <>
      <path d="M9 5h6v2.5H9z" />
      <path d="M15 5.8h2A2 2 0 0 1 19 7.8V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7.8a2 2 0 0 1 2-2h2" />
    </>
  ),
  edit: (
    <>
      <path d="M4.5 19.5l.9-3.5a2 2 0 0 1 .5-.9l9.3-9.3a2.1 2.1 0 0 1 3 3l-9.3 9.3a2 2 0 0 1-.9.5Z" />
      <path d="M13.5 7l3.5 3.5" />
    </>
  ),
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  /* On a shelf row that is already taken: what is chosen, not what to press. */
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  login: (
    <>
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
      <path d="M10 8l4 4-4 4" />
      <path d="M14 12H4" />
    </>
  ),
  /* The same doorway with the arrow pointing the other way. */
  logout: (
    <>
      <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
      <path d="M16 8l4 4-4 4" />
      <path d="M20 12H10" />
    </>
  ),
  /*
   * The master switch. A bolt because it is what every interface has meant by
   * "this acts on its own" for a decade, and because it has to be told apart
   * from every other glyph on the row at 16px.
   */
  bolt: <path d="M13.5 2.5 5 13.5h5.5L10 21.5 19 10.5h-5.5Z" />,
  /*
   * Upright, with a crossguard, rather than the diagonal blade every icon set
   * draws. Measured on a real toolbar at 16px: the diagonal one read as a
   * *pencil* — the crossguard is the only part of a sword that says sword, and
   * a diagonal blade puts it where the eye reads a pen's grip.
   */
  sword: (
    <>
      <path d="M12 2.4 14 6.4v7.6h-4V6.4Z" />
      <path d="M7.4 14.4h9.2" />
      <path d="M12 14.4v5" />
      <path d="M9.7 20.4h4.6" />
    </>
  ),
  shield: <path d="M12 2.8 4.8 5.6v5.5c0 4.4 3 8.2 7.2 10.1 4.2-1.9 7.2-5.7 7.2-10.1V5.6Z" />,
  /*
   * Kit, for putting it back on.
   *
   * A garment with a collar rather than a helm or a boot: the button restores
   * *every* slot, and a glyph naming one of them would read as a control over
   * that slot. Drawn as the outline plus two shoulder strokes, which is what
   * keeps it from turning to mush at the 14px a menu row uses — the same
   * lesson the settings cog records.
   */
  shirt: (
    <>
      <path d="M8.6 3.2 4.2 5.6l1.6 4 2-.9v9.1h8.4v-9.1l2 .9 1.6-4-4.4-2.4Z" />
      <path d="M8.6 3.2A3.4 3.4 0 0 0 12 6.3a3.4 3.4 0 0 0 3.4-3.1" />
    </>
  ),
  /**
   * Kit this character may not put on.
   *
   * The shirt with the slash `eyeOff` already uses, rather than a second
   * negation of its own: one stroke through a glyph is how this client says
   * *not this*, and two conventions for it would be two things to learn. The
   * body is trimmed where the stroke crosses it so the slash reads as a mark
   * over the shirt rather than as another seam in it.
   */
  shirtOff: (
    <>
      <path d="M8.6 3.2 4.2 5.6l1.6 4 2-.9v9.1h8.4v-9.1l2 .9 1.6-4-4.4-2.4Z" />
      <path d="M8.6 3.2A3.4 3.4 0 0 0 12 6.3a3.4 3.4 0 0 0 3.4-3.1" />
      <path d="m3.5 3.5 17 17" />
    </>
  ),
  /**
   * Kit that is **on**, and the control that takes it off again.
   *
   * `shirt` solid rather than a glyph of its own, and that is the second answer
   * to this. The first was a cuirass — pauldrons, a chest band, a plate that
   * tapers — and rasterised at the 14px a table row actually gives a glyph it
   * read as a **circle with a bar through it**: at that size the pauldrons
   * merged into the body and the chest band became a strike, which is this
   * client's own mark for *not this*. A green refusal on every worn row is the
   * opposite of what it had to say. Two more silhouettes were drawn and
   * measured the same way; a neck notch turned the outline into a heart, and a
   * square-shouldered plate into a rectangle.
   *
   * Filled against outlined is what survives, because it is a difference in
   * ink rather than in detail — the same reason `play` and `stop` are solid.
   * It also says the true thing: the item is the *same* kit as the row above
   * it, and what differs is that this one is in use. And it does not spend the
   * distinction on colour, which is the one channel a reader may not have.
   *
   * The stroke is kept under the fill so the solid glyph has the outline's
   * exact bounds; dropping it would make every worn row's mark visibly smaller
   * than the one beside it.
   */
  shirtWorn: (
    <path d="M8.6 3.2 4.2 5.6l1.6 4 2-.9v9.1h8.4v-9.1l2 .9 1.6-4-4.4-2.4Z" fill="currentColor" />
  ),
  crosshair: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.4" />
      <path d="M12 1.8v3.4M12 18.8v3.4M1.8 12h3.4M18.8 12h3.4" />
    </>
  ),
  /* Somebody leaving at speed: the escape, not the disconnect. */
  run: (
    <>
      <circle cx="14.6" cy="4.4" r="1.9" />
      <path d="M13.8 21.5 11 16.2l3.2-2.8-1-4.6-3.3 2-1.6 3" />
      <path d="m11 16.2-3.6 1.4-1.6 3.9" />
      <path d="m13.4 8.8 3.4 1.4 2.6-1.1" />
    </>
  ),
  unplug: (
    <>
      <path d="M8.6 3.5v4.3M15.4 3.5v4.3" />
      <path d="M6 7.8h12v3.1a6 6 0 0 1-6 6 6 6 0 0 1-6-6Z" />
      <path d="M12 16.9v3.6" />
      <path d="m3.5 3.5 17 17" />
    </>
  ),
  /*
   * Two overlapping discs and nothing else. The four-path stack every icon set
   * draws for this — two ellipses joined by their cylinder walls — collapses
   * into a smudge at 16px; two circles at that size still read as coins.
   */
  coins: (
    <>
      <circle cx="8.6" cy="15.4" r="5.6" />
      <circle cx="15.4" cy="8.6" r="5.6" />
    </>
  ),
  door: (
    <>
      <path d="M5.5 21V4.4a1.4 1.4 0 0 1 1.4-1.4h10.2a1.4 1.4 0 0 1 1.4 1.4V21" />
      <path d="M3.5 21h17" />
      <path d="M14.6 12.3h.01" />
    </>
  ),
  key: (
    <>
      <circle cx="7.4" cy="16.6" r="3.4" />
      <path d="m9.9 14.2 8.3-8.3" />
      <path d="m15.6 8.5 2 2M18.2 5.9l2.3 2.3" />
    </>
  ),
  hammer: (
    <>
      <path d="m14.6 6.8-9.1 9.1a2 2 0 0 0 0 2.9 2 2 0 0 0 2.9 0l9.1-9.1" />
      <path d="M12.4 4.6 10.2 6.8l4.4 4.4 2.2-2.2" />
      <path d="m16.8 2.4 4.8 4.8" />
    </>
  ),
  eye: (
    <>
      <path d="M2.2 12S5.7 5.5 12 5.5 21.8 12 21.8 12 18.3 18.5 12 18.5 2.2 12 2.2 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M4.2 8.1C2.9 9.6 2.2 12 2.2 12S5.7 18.5 12 18.5c1.5 0 2.8-.3 3.9-.8" />
      <path d="M9.2 5.9A9.5 9.5 0 0 1 12 5.5c6.3 0 9.8 6.5 9.8 6.5s-1 1.9-2.8 3.5" />
      <path d="M10 10a2.8 2.8 0 0 0 4 4" />
      <path d="m3.5 3.5 17 17" />
    </>
  ),
  heart: (
    <path d="M12 20.3s-7.8-4.6-7.8-9.7a4.3 4.3 0 0 1 7.8-2.5 4.3 4.3 0 0 1 7.8 2.5c0 5.1-7.8 9.7-7.8 9.7Z" />
  ),
  moon: <path d="M20.4 14.3A8.6 8.6 0 0 1 9.7 3.6a8.6 8.6 0 1 0 10.7 10.7Z" />,
  // A torch's flame: the light switch. One outer tongue and a smaller inner
  // one, because a single outline reads as a leaf at 14px.
  flame: (
    <>
      <path d="M12 21.5c-3.9 0-6.5-2.6-6.5-6.2 0-3.2 2.3-5.5 3.6-7.4.6 1.3 1.4 2.2 2.4 2.6.2-3 1.4-5.9 3.3-8 .5 3.2 3.7 5.4 3.7 9.3 0 3.9-2.7 7.7-6.5 9.7Z" />
      <path d="M12 21.5c-1.9 0-3.1-1.4-3.1-3.2 0-1.9 1.4-2.8 3.1-4.9 1.7 2.1 3.1 3 3.1 4.9 0 1.8-1.2 3.2-3.1 3.2Z" />
    </>
  ),
  // A shopping bag: the supplies switch, and the errand it turns on.
  bag: (
    <>
      <path d="M5 8.5h14l-1 12H6l-1-12Z" />
      <path d="M9 8.5V7a3 3 0 0 1 6 0v1.5" />
    </>
  ),
  at: (
    <>
      <circle cx="12" cy="12" r="3.6" />
      <path d="M15.6 8.4v4.8a2.7 2.7 0 0 0 5.4 0V12a9 9 0 1 0-3.5 7.1" />
    </>
  ),
  broadcast: (
    <>
      <circle cx="12" cy="12" r="2" />
      <path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 15.5a5 5 0 0 0 0-7" />
      <path d="M5.8 5.8a8.8 8.8 0 0 0 0 12.4M18.2 18.2a8.8 8.8 0 0 0 0-12.4" />
    </>
  ),
  pin: (
    <>
      <path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z" />
      <path d="M12 15v5" />
    </>
  ),
  /*
   * The same pin, struck through. A toggle that draws one glyph for both
   * states says what the control *is* and never which way it will go, so the
   * card's action column and the palette's row both had a pin that looked
   * identical whether pressing it would pin or release — the label underneath
   * was the only thing that differed, and on the palette's icon-only button
   * there is no label to read.
   *
   * A strike-through rather than a second, cleverer pin: it is the one
   * negation mark that reads at the 14px a menu row uses, and it is what every
   * other client draws for this. The slash is a separate path so it inherits
   * `currentColor` with the rest and needs no rule of its own.
   */
  unpin: (
    <>
      <path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z" />
      <path d="M12 15v5" />
      <path d="M4 4l16 16" />
    </>
  ),
  reset: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4.5V10h-5.5" />
    </>
  )
};

export interface IconProps {
  name: IconName;
  /** Overrides the size the surrounding control gives it. */
  size?: number;
}

/**
 * Always decorative. Every icon in this client sits beside a label that says
 * the same thing in words — §6 of the design language forbids stating anything
 * by appearance alone — so it is hidden from assistive technology rather than
 * given a name that would be read out twice.
 */
function Icon({ name, size }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      focusable="false"
      viewBox="0 0 24 24"
      {...(size === undefined ? {} : { style: { width: size, height: size } })}
    >
      {ICONS[name]}
    </svg>
  );
}

/*
 * Memoised on its two strings. There are fifty-odd of these on screen at once
 * and each is a handful of SVG elements; measured with `npm run profile:ui`
 * (2026-09-04), they were the single most re-rendered component in the window
 * — nine hundred renders in five idle seconds — every one producing the same
 * paths as the last.
 */
export default memo(Icon);
