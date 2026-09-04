import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  type RefObject
} from 'react';

import Icon, { type IconName } from './Icon';
import PopupMenu from './PopupMenu';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { writeClipboard } from '../lib/clipboard';
import CardSettingsPopup from './CardSettings';
import { floatAlphas, type CardId, type CardSettings } from '../hooks/useCardLayout';
import { THEMES, type Appearance, type ThemeId } from '@shared/themes';
import { readable, useCopyMenu } from '../hooks/useCopyMenu';

/**
 * One face of a card.
 *
 * Every face names itself in the heading, and the **first face is ordinarily
 * the card itself** — so it is given the card's own title as its label, and a
 * card called Room whose first tab is also called Room says the word once.
 * Every face after it adds a crumb — `ROOM  FOUND` — a heading that happens to
 * be navigable rather than a strip of chrome underneath one.
 *
 * The label used to be *ignored* at index 0, which enforced that convention and
 * then made the one card it does not fit impossible to write: Navigation is
 * `ROUTE` and `LOOP`, two named activities of which neither is the card, and
 * `NAVIGATION  LOOP` would have named the card on one pill and an activity on
 * the other — two vocabularies in one heading. So the label is drawn wherever
 * it sits and the convention is stated here instead: pass the card's title for
 * face 0 unless the faces are genuinely both something else.
 */
export interface CardTab {
  id: string;
  /** The crumb. For face 0 this is ordinarily the card's own title. */
  label: string;
  content: ReactNode;
  /**
   * This face owns its own scroll region, as `BentoCardProps.paned` does for a
   * card that has one face.
   *
   * A face is not the card, so the card cannot answer this for it: the Room
   * card's own face is a readout that scrolls as a whole, and its Shop face is
   * a table whose find field has to stay put while the stock moves under it.
   * Declaring it on the card would give the readout a scroll region it has no
   * `.scroller` for, which is a face that cannot be scrolled at all.
   */
  paned?: boolean;
  /**
   * What *this face* puts on the clipboard, where the card's own answer would
   * be the wrong one.
   *
   * A card states what somebody would want to send about it, and once it has
   * faces that is a per-face question: the Room card's answer is the room's
   * name and exits, and copying that while the Shop face is on screen would put
   * something the reader cannot see on the clipboard. Optional, because most
   * faces are happy with the card's answer or with the text they show.
   */
  copyText?(): string;
}

/**
 * Something a card can do, drawn as a glyph in its action column.
 *
 * A label as well as a glyph, always: the label is the tooltip and the
 * accessible name, and it is what the overflow menu shows when the column is
 * too short to draw the glyph.
 */
export interface CardAction {
  id: string;
  label: string;
  icon: IconName;
  /**
   * @param anchor The control that ran it, for an action that opens something
   *   beside itself. Every other action ignores it — but a popup measured from
   *   its own anchor is the only kind this client draws, and an action that had
   *   to reach into the DOM for the button it was just pressed on would be a
   *   second way of answering a question the event already answers.
   */
  run(anchor: HTMLElement): void;
  /** Costs something, and says so with the tone — forgetting a record, not copying one. */
  danger?: boolean;
}

export interface BentoCardProps {
  title: string;
  /** Optional right-aligned status chip. */
  badge?: ReactNode;
  /** Let the body scroll internally rather than growing the grid cell. */
  scroll?: boolean;
  /**
   * The card manages its own scroll region rather than scrolling as a whole.
   *
   * For a card with something that must stay put — Talk's filters and reply
   * box, Alerts' filters. The body becomes a flex column and the child marked
   * `.scroller` is the only part that moves. Filters and a reply box that
   * scroll away are reached for exactly when they cannot be.
   */
  paned?: boolean;
  /** Handle on the scroll container, for cards that pin themselves to the end. */
  bodyRef?: RefObject<HTMLDivElement>;
  className?: string;
  /**
   * More than one face for the same subject.
   *
   * For a card that has a *second thing to say* about what it already shows —
   * what the character found leaving this room, beside the room itself. Not
   * for unrelated content: a tab that hides something a player needs is worse
   * than a second card, and the rail can hold cards.
   *
   * The first tab is the one a card opens on, so it must be the answer; the
   * rest are the working.
   */
  tabs?: CardTab[];
  /**
   * Which face is showing, for a card that decides that for itself.
   *
   * Ordinarily a card does not: the player picks a face and it stays picked,
   * which is what the internal state below is. The Navigation card is the
   * exception — starting a loop or planning a route is a decision about *what
   * the character is doing*, and the card that reports it should be showing
   * the half that is happening rather than waiting to be told.
   *
   * By tab **id**, never by index: a card's face list changes shape (the Room
   * card's `Shop` appears with the room), and an index would silently point at
   * a different face when it did. Absent, the card keeps its own state, which
   * is what every other card wants.
   */
  active?: string;
  onActive?(id: string): void;
  /**
   * Lets the player put this card away.
   *
   * Only for cards that are a *choice*: the rail is one player's instrument and
   * what belongs on it differs per character. A card with no `onClose` is one
   * the client insists on.
   */
  onClose?(): void;
  /**
   * What this card puts on the clipboard, when the copy glyph is pressed.
   *
   * Each card knows what of itself somebody would want to send to another
   * person, and in what shape: a room as its name and exits, a pack as one
   * item per line. A card that says nothing gets what it shows, read off the
   * face on screen — which is the same text the right-click menu's *Copy
   * card* has always offered, so the two never disagree.
   */
  copyText?(): string;
  /** Anything else the card can do, after close and copy. */
  actions?: CardAction[];
  /**
   * Which card this is, for the layout to address it by.
   *
   * Published as `data-card` because the drag machine hit-tests the rail by
   * measuring the boxes actually laid out in it. Reading the DOM is the honest
   * answer to "where would this land": a parallel model of the rail's geometry
   * would be a second thing to keep in step with the first.
   */
  cardId?: string;
  /** Makes the heading a drag handle. Cards without one cannot be rearranged. */
  onGrab?(event: PointerEvent<HTMLElement>): void;
  /** True while this card is the one being dragged, so it can say so. */
  dragging?: boolean;
  /**
   * How tall this card is on the rail, as a fraction of the rail, where
   * somebody has dragged it — else the height its stylesheet declares.
   *
   * With `onResize`, the corner grip that changes it: a rail card is a fixed
   * box that never resizes with its contents, and the person looking at it is
   * the one thing allowed to change the box. Only a rail card carries the
   * grip: a float has its own, and a docked strip is sized by its splitter.
   */
  height?: number;
  onResize?(event: PointerEvent<HTMLElement>): void;
  /** Double-click on the grip: back to the card's own height. */
  onResizeReset?(): void;
  /**
   * Hand the keyboard back to the game.
   *
   * A card takes no typed input, so nothing on one moves the caret — except the
   * copy menu, which is navigated by the arrow keys and therefore has to give
   * it back on the way out.
   */
  returnFocus?: () => void;
  /**
   * Set when the card is floating over the console rather than sitting on the
   * rail: how solid it is, and how to change it.
   */
  /**
   * Whether this floating card stays in view whichever character is shown,
   * and the control that says so. Only a float can be pinned: a rail is per
   * character by design, and a pinned float is the deliberate exception.
   */
  pinned?: boolean;
  onPin?(next: boolean): void;
  /**
   * What this card is set to for this character, and how to change it.
   *
   * Part of the rail's concern rather than the card's, like closing and
   * floating: it is stored beside the arrangement, keyed by the same session
   * id, and every card threads it through without reading it.
   *
   * The client's appearance and theme travel with it because the palette
   * picker offers only the half that matches what the client is wearing, and
   * the "follow the client" swatch has to preview the thing it would follow.
   * They are per window rather than per card, and are carried here rather than
   * through a context because this is the one surface that wants them.
   */
  settings?: {
    /** Which card this is, for the option list and its defaults. */
    id: CardId;
    value: CardSettings;
    appearance: Appearance;
    clientTheme: ThemeId;
    onChange(change: Partial<CardSettings>): void;
  };
  translucency?: {
    /** 0–1. One slider, two alphas — see `floatAlphas`. */
    solidity: number;
    onChange(solidity: number): void;
  };
  children?: ReactNode;
}

/**
 * The parts of a card that belong to the *rail*, not to what the card says.
 *
 * Closing, dragging, floating and translucency are all one concern — where this
 * card lives — and every card handles them identically. Naming the bundle once
 * means a card component threads it through opaquely instead of listing five
 * props it never reads, and a sixth added later reaches every card at once.
 */
export type CardChrome = Pick<
  BentoCardProps,
  | 'onClose'
  | 'cardId'
  | 'onGrab'
  | 'dragging'
  | 'height'
  | 'onResize'
  | 'onResizeReset'
  | 'translucency'
  | 'returnFocus'
  | 'pinned'
  | 'onPin'
  | 'settings'
>;

/**
 * The one card shell every bento cell uses.
 *
 * Deliberately over-built for the four cards that existed when it was written:
 * everything since — Vitals, Room, Map, Walk, Automation — arrived into this
 * same grammar rather than inventing its own frame.
 *
 * **The right edge is the card's action column.** Close at the top, copy under
 * it, then whatever the card itself can do, and a kebab when there are more
 * than fit — one place, the same place on every card, so a control is learned
 * once. Before this the close sat in the header and copy was only on the
 * right-click menu, which is an affordance you have to know about.
 */
export default function BentoCard({
  title,
  badge,
  scroll,
  paned,
  bodyRef,
  className,
  tabs,
  active,
  onActive,
  onClose,
  copyText,
  pinned,
  onPin,
  settings,
  actions,
  cardId,
  onGrab,
  dragging,
  height,
  onResize,
  onResizeReset,
  translucency,
  returnFocus,
  children
}: BentoCardProps) {
  const [own, setOwn] = useState(0);
  /*
   * The controlled id wins where it is given and names a face this card still
   * has; otherwise the card's own state, clamped, because a face list can
   * shrink under a stored index. A caller that names a face that has gone gets
   * the first one rather than a blank body.
   */
  const named = active === undefined ? -1 : (tabs?.findIndex((tab) => tab.id === active) ?? -1);
  const at = tabs && tabs.length > 0 ? (named >= 0 ? named : Math.min(own, tabs.length - 1)) : 0;
  const show = (index: number): void => {
    setOwn(index);
    const id = tabs?.[index]?.id;
    if (id !== undefined) onActive?.(id);
  };
  const shown = tabs && tabs.length > 0 ? tabs[at]!.content : children;
  const body = useRef<HTMLDivElement | null>(null);

  /*
   * Right-click to copy, on every card at once.
   *
   * Here rather than per card because every card is one of these: what a player
   * wants to send somebody is a room name, a route, a party member's health or
   * an alert, and adding it card by card would mean the next card built is the
   * one without it.
   */
  const copy = useCopyMenu();
  /*
   * Every entry hands the caret back, not only the ways *out* of the menu.
   *
   * `onDismiss` below covers Escape, Tab and a click away; an entry closes the
   * menu itself, through `useCopyMenu`'s own `dismiss`, and never came through
   * here — so choosing Copy left the caret on a button that then unmounted, and
   * the next thing typed at the game went nowhere. The hook has no business
   * knowing about focus, so the wrapping is here, where the card already knows.
   */
  const copyItems = copy.menu
    ? copy.items(copy.menu).map((item) => ({
        ...item,
        run: () => {
          item.run();
          returnFocus?.();
        }
      }))
    : [];

  /*
   * The copy glyph: what the card chose to say, else what it shows.
   *
   * A heading on the front, so a paste says what it is — a bare `98/400` is a
   * number with nothing to say what it was. The face on screen, not the ones
   * switched off; `readable` reads `innerText`, which honours that.
   */
  const face = tabs && tabs.length > 0 ? tabs[at] : undefined;
  const copyCard = useCallback(() => {
    // The shown face first, then the card, then what is on screen -- so a card
    // with faces cannot copy one of them while displaying another.
    const text = face?.copyText?.() ?? copyText?.() ?? readable(body.current);
    if (text.trim().length === 0) return;
    void writeClipboard(`${title}\n${text}`);
  }, [face, copyText, title]);

  /*
   * What this card is set to, opened from the gear.
   *
   * Held here rather than in a card, because it is every card at once: the
   * column, the copy menu and the kebab are all already `BentoCard`'s, and a
   * gear added card by card would mean the next card built is the one without
   * it.
   */
  const [tuner, setTuner] = useState<HTMLElement | null>(null);

  /**
   * Close, the gear, the pin — then everything else, the card's own last.
   *
   * The three at the top are the ones that are *about the card* and are on
   * every card that can do them, so they are learned once and never move.
   * Copy sits below them because it is the one thing in this column that acts
   * on the card's **contents** rather than on the card, which puts it on the
   * same side of the line as whatever the card itself offers.
   */
  const column: CardAction[] = [
    ...(onClose
      ? [{ id: 'close', label: t('cards.chrome.close'), icon: 'close' as const, run: onClose }]
      : []),
    /*
     * Directly under the close, on every card, so it is learned once — and
     * ahead of copy, which is the one thing in this column that acts on the
     * card's *contents* rather than on the card. The glyph is the cog, because
     * a cog has meant settings on every phone and desktop for fifteen years
     * and an icon is only worth drawing if it is read before the label is.
     */
    ...(settings
      ? [
          {
            id: 'settings',
            label: t('cards.chrome.settings'),
            icon: 'settings' as const,
            // Toggled, like the kebab: the gear is the way out of the panel as
            // well as the way in, and `Popup` deliberately does not count a
            // press on its own anchor as a click-away.
            run: (anchor: HTMLElement) => setTuner((open) => (open ? null : anchor))
          }
        ]
      : []),
    ...(onPin
      ? [
          {
            id: 'pin',
            label: pinned ? t('cards.chrome.unpin') : t('cards.chrome.pin'),
            // The glyph states which way the press goes, as the label does.
            icon: pinned ? ('unpin' as const) : ('pin' as const),
            run: () => onPin(!pinned)
          }
        ]
      : []),
    { id: 'copy', label: t('cards.chrome.copy'), icon: 'copy' as const, run: copyCard },
    ...(actions ?? [])
  ];
  /*
   * How many glyphs fit down the card's right edge — **measured**, never a
   * count.
   *
   * It was a count (`tuning.cardActions`, five), and on a card with room for
   * nine it hid four behind a kebab anyway: the Combat Stats card put *Pin*
   * and *Reset* in a menu with two thirds of its edge empty beside them. A
   * folded control is one that is not there at the moment it is reached for,
   * so folding is worth doing only when the alternative is drawing off the
   * bottom of the card.
   *
   * No pixel constant enters this, which is the standing rule for anything in
   * the layout path: a card is resizable, floatable, and `App.tsx` overwrites
   * the typography tokens at runtime from the options file, so a height
   * decided at build time is wrong for somebody. The button's height and the
   * column's gap come from the laid-out elements, and the room comes from the
   * card — with the same inset left at the bottom as the column already has
   * at the top, which is read off the two boxes rather than named.
   */
  const frame = useRef<HTMLElement | null>(null);
  const side = useRef<HTMLDivElement | null>(null);
  const [fits, setFits] = useState<number | null>(null);

  const measure = useCallback(() => {
    const column = side.current;
    const card = frame.current;
    if (!column || !card) return;
    const button = column.querySelector<HTMLElement>('.card-action');
    if (!button) return;
    const step = button.getBoundingClientRect().height;
    if (step <= 0) return;
    const gap = Number.parseFloat(getComputedStyle(column).rowGap) || 0;
    const box = card.getBoundingClientRect();
    const inset = column.getBoundingClientRect().top - box.top;
    const room = box.height - inset * 2;
    /*
     * Nothing to measure is not "no room": a card that is put away, on another
     * character's rail or simply not laid out yet reports zero, and folding
     * everything on that would hide a whole column for a card nobody can see
     * anyway — and leave it hidden if the observer never fires. Left as it was,
     * which is all of them.
     */
    if (room <= 0) return;
    // The last glyph needs no gap after it, so the gap is added to both sides
    // of the division rather than subtracted from the room.
    setFits(Math.max(1, Math.floor((room + gap) / (step + gap))));
  }, []);

  /*
   * Re-measured whenever the card changes size — dragged bigger as a float,
   * the rail's splitter moved, the window resized — and whenever the number of
   * actions changes, because a card may gain or lose one. `ResizeObserver` on
   * the card and not on the column: the column is absolutely positioned, so
   * its own size follows what this decides and watching it would be a loop.
   */
  useLayoutEffect(() => {
    measure();
    const card = frame.current;
    if (!card || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, [measure, column.length]);

  /*
   * Unmeasured — the first paint, and a test environment with no layout — draws
   * them all. The column is invisible until the card is pointed at, so a fold
   * decided one frame later is never seen; erring the other way would hide
   * controls on every card that was never measured.
   */
  const visible = fits ?? column.length;
  const folded = column.length > visible;
  /*
   * **Close is always drawn**, even where the arithmetic says one glyph fits
   * and the kebab would take that slot. A card can be dragged to a tenth of
   * the workspace (`MIN_FLOAT.h`), and on a short enough window that is a
   * column of one — which would have put *every* control, close included,
   * behind a menu. "Close at the top, on every card, learned once" outranks
   * overflowing by a single 18px glyph on a card already too small to read,
   * and the old fixed count kept close unconditional for exactly this reason.
   */
  const room = Math.max(1, visible - 1);
  const drawn = folded ? column.slice(0, room) : column;
  const rest = folded ? column.slice(room) : [];
  const [more, setMore] = useState<HTMLElement | null>(null);

  const setBody = useCallback(
    (node: HTMLDivElement | null) => {
      body.current = node;
      if (bodyRef) (bodyRef as { current: HTMLDivElement | null }).current = node;
    },
    [bodyRef]
  );

  /*
   * A palette for this card alone, written as the theme's own tokens on this
   * element — the same tokens `useTheme` writes on the root, one surface in.
   * Everything inside reads them by inheritance, so nothing had to be taught
   * about card themes: a chip is still `--accent`, a seam still `--ink-line`.
   *
   * `data-card-theme` is what lets `tokens.css` re-derive the handful of tokens
   * that are *composed* from these — `--glass-fill`, `--text-lo`, the map's
   * greys. A custom property's `var()` is substituted where the property is
   * declared, not where it is used, so those carry the **root's** `--ink-card`
   * into every card that merely inherits them. The attribute is the hook; the
   * recipe stays in one declaration in `tokens.css`, shared by both selectors.
   */
  const worn = settings?.value.theme?.[settings.appearance];
  const palette: CSSProperties = {};
  if (worn !== undefined) {
    for (const [token, value] of Object.entries(THEMES[worn].chrome)) {
      (palette as Record<string, string>)[`--${token}`] = value;
    }
  }

  return (
    <section
      className={`surface card${className ? ` ${className}` : ''}`}
      data-card={cardId}
      ref={frame}
      data-card-theme={worn}
      data-dragging={dragging ? 'true' : undefined}
      onContextMenu={copy.onContextMenu}
      /*
       * Two alphas, from one slider, never a single `opacity` on the section.
       *
       * An `opacity` here would fade the readout by exactly as much as the
       * background, and a card you can see through is useful where a *number*
       * you can see through is not. The fill and the text move together and the
       * text stays well ahead of it: at every setting the console shows through
       * and the figures on top of it stay legible.
       */
      style={{
        ...palette,
        /*
         * A dragged height overrides the one the stylesheet declares for this
         * card, and as a percentage of the rail rather than a pixel figure:
         * the rail is what it is a fraction of, and a percentage is what
         * survives a window resize, a different monitor and a bigger font.
         */
        ...(height !== undefined ? ({ '--card-h': `${height * 100}%` } as CSSProperties) : {}),
        ...(translucency
          ? ({
              '--card-alpha': `${Math.round(floatAlphas(translucency.solidity).fill * 100)}%`,
              '--card-text-alpha': floatAlphas(translucency.solidity).text
            } as CSSProperties)
          : {})
      }}
    >
      <header
        data-grab={onGrab ? 'true' : undefined}
        onPointerDown={onGrab}
        title={onGrab ? t('cards.header.dragHint') : undefined}
      >
        {/*
          The one standing mark that says a card can be moved.

          Always drawn, never only on hover: an affordance you have to find by
          hovering is one most people never find, and the whole rail being
          rearrangeable is worth nothing if nobody knows it. Same grip on every
          draggable card, in the same place, so it is learned once.
        */}
        {onGrab && <span aria-hidden="true" className="card-grip" />}
        {/*
          The heading is the navigation. One face means a plain title; more
          means a trail of pills — `ROOM  FOUND` — because a separate strip of
          tabs under a heading that already names the first of them says the
          same word twice, and spends a row of vertical space doing it. Each
          pill carries its own affordance, so nothing between them has to.
        */}
        <h2>
          {tabs && tabs.length > 1 ? (
            <span className="crumbs" role="tablist">
              {tabs.map((tab, index) => (
                <button
                  aria-selected={index === at}
                  className="crumb"
                  data-active={index === at ? 'true' : 'false'}
                  key={tab.id}
                  onClick={() => show(index)}
                  // A card is read, never typed into: switching its face must
                  // not take the caret out of the terminal.
                  onMouseDown={keepFocus}
                  role="tab"
                  type="button"
                >
                  {tab.label}
                </button>
              ))}
            </span>
          ) : (
            title
          )}
        </h2>
        {badge && <span className="badge">{badge}</span>}
        {/*
          Only on a floating card, because it is only there that it means
          anything: a card on the rail has the slate behind it, not the console.
          In the header rather than behind a kebab — one control does not earn a
          menu, and a menu is another surface that could take the caret.
        */}
        {translucency && (
          <input
            aria-label={t('cards.translucency.sliderLabel')}
            className="card-alpha"
            max={100}
            min={0}
            // The slider is dragged, so the header must not treat that as
            // dragging the card.
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => translucency.onChange(Number(event.target.value) / 100)}
            title={t('cards.translucency.sliderStatus', {
              fillPercent: Math.round(floatAlphas(translucency.solidity).fill * 100),
              textPercent: Math.round(floatAlphas(translucency.solidity).text * 100)
            })}
            type="range"
            value={Math.round(translucency.solidity * 100)}
          />
        )}
      </header>

      <div
        className={`body${scroll ? ' scroll' : ''}${paned || face?.paned === true ? ' paned' : ''}`}
        ref={setBody}
      >
        {shown}
      </div>

      {/*
        The action column. Quiet until the card is hovered, like the close was:
        the rail is read far more often than it is operated on, and a column
        of glyphs down every card is a toolbar. `card-close` keeps its class so
        the smoke run and the styles that know it still find it.
      */}
      <div
        className="card-side"
        ref={side}
        /*
         * Held visible while something it opened is on screen. The column is
         * quiet until the card is pointed at, and `:focus-within` cannot see a
         * caret that has moved into a portal — so opening the settings panel or
         * the kebab faded out the very control that closes it again.
         */
        data-open={tuner !== null || more !== null ? 'true' : undefined}
        role="toolbar"
        aria-label={t('cards.chrome.toolbarLabel', { cardTitle: title })}
      >
        {drawn.map((action) => (
          <button
            aria-label={action.label}
            className={`card-action${action.id === 'close' ? ' card-close' : ''}`}
            data-action={action.id}
            data-danger={action.danger ? 'true' : undefined}
            key={action.id}
            onClick={(event) => action.run(event.currentTarget)}
            // Chrome is read, not typed into.
            onMouseDown={keepFocus}
            title={action.label}
            type="button"
          >
            <Icon name={action.icon} />
          </button>
        ))}
        {folded && (
          <button
            aria-expanded={more !== null}
            aria-haspopup="menu"
            aria-label={t('cards.chrome.more')}
            className="card-action"
            // A stable hook for the harness, like every other button in this
            // column: `npm run smoke` asserts that nothing folds while it
            // fits, and matching that on the English word `More` would stop
            // finding folds the moment somebody reworded the label.
            data-action="more"
            onClick={(event) => setMore((open) => (open ? null : event.currentTarget))}
            onMouseDown={keepFocus}
            title={t('cards.chrome.more')}
            type="button"
          >
            <Icon name="more" />
          </button>
        )}
      </div>

      {more !== null && (
        <PopupMenu
          at={more}
          items={rest.map((action) => ({
            label: action.label,
            icon: action.icon,
            danger: action.danger,
            run: () => {
              setMore(null);
              // The kebab is what a folded action was reached through, so it is
              // what anything the action opens hangs off.
              action.run(more);
              returnFocus?.();
            }
          }))}
          onDismiss={() => {
            setMore(null);
            returnFocus?.();
          }}
        />
      )}

      {tuner !== null && settings && (
        <CardSettingsPopup
          appearance={settings.appearance}
          at={tuner}
          cardId={settings.id}
          cardTitle={title}
          clientTheme={settings.clientTheme}
          onChange={settings.onChange}
          onDismiss={() => {
            setTuner(null);
            returnFocus?.();
          }}
          value={settings.value}
        />
      )}

      {/*
        The corner grip, on a rail card only. The same mark a float wears in
        the same corner, so it is learned once; drawn quiet until the card is
        pointed at, like the action column, and never only on hover of the
        grip itself — an affordance you have to find by hovering is one most
        people never find.
      */}
      {onResize && (
        <span
          aria-hidden="true"
          className="card-resize"
          onDoubleClick={onResizeReset}
          onPointerDown={onResize}
          title={t('cards.header.resizeHint')}
        />
      )}

      {copy.menu !== null && copyItems.length > 0 && (
        <PopupMenu
          at={copy.menu}
          items={copyItems}
          /*
           * A menu is navigated, so it takes the caret — and hands it straight
           * back, like every other surface that does (docs/ui-design.md §3.6).
           * A card is otherwise never typed into, and a caret left on one of
           * these buttons would swallow the next thing said to the game.
           */
          onDismiss={() => {
            copy.dismiss();
            returnFocus?.();
          }}
        />
      )}
    </section>
  );
}
