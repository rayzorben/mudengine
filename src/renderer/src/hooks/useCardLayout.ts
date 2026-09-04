import { useCallback, useEffect, useMemo, useState } from 'react';

import type { SessionId } from '@shared/ipc';
import { isThemeId, type Appearance, type ThemeId } from '@shared/themes';
import { isTalkLayout, isTalkStamp, type TalkLayout, type TalkStamp } from '@shared/talk';

import { t } from '../lib/i18n';
import { reordered } from '../lib/reorder';

/**
 * Every card the rail can hold, and the order a rail that has never been
 * arranged holds them in.
 *
 * This list is the *vocabulary*, not the layout. Once a character has arranged
 * its own rail the stored order wins, and this is only consulted for cards that
 * arrangement has never seen — a card added by a later build appears rather
 * than staying invisible to everyone who already has a saved layout.
 */
export const CARDS = [
  /*
   * The toolbar first, and it is the one card with a *placement* in its
   * shipped arrangement rather than only a position: it docks above the
   * console (`DEFAULT_ABOVE`), one icon high, which is where a toolbar
   * belongs and is the one thing the rail cannot give it — a rail is a column,
   * and a row of glyphs down a column is a list.
   *
   * It is still an ordinary card underneath: draggable onto the rail, over the
   * console as a float, or into the strip below. Nothing about it is special
   * except where it starts.
   */
  { id: 'toolbar', label: t('cards.toolbar.title') },
  /*
   * The character itself, first: a client for playing several characters
   * whose rail opened on bars and a room and never on *who this is*. It
   * carries the whole stat sheet, the pack and the supplies list, and its
   * title is the character's own name — see `SelfCard`.
   */
  { id: 'self', label: t('cards.self.title') },
  /*
   * Vitals and Combat adjacent, at the top.
   *
   * They are the two readouts a decision gets made off under pressure — how
   * much health is left, and how the thing it is fighting is holding up — so
   * they sit where the eye already is. The Combat card is drawn whether or not
   * there is a fight (`CardSettings.autoHide` is what changes that, per
   * character): a card that appeared when a fight started and vanished when it
   * ended moved everything below it on the rail several times a minute.
   * Everything below is arrangeable and remembered per character; this is only
   * what a rail that has never been arranged looks like.
   */
  { id: 'vitals', label: t('cards.vitals.title') },
  { id: 'combat', label: t('cards.combat.title') },
  { id: 'room', label: t('cards.room.title') },
  { id: 'map', label: t('cards.map.title') },
  /*
   * One card, two faces: `ROUTE` and `LOOP`.
   *
   * They were `walk` and `loop`, two cards side by side on every rail, and
   * each had grown a copy of the other — the Route card carried the loop's
   * name, stop and a `Stop looping` button, and the Loop card carried a stop
   * counter the Route card was already drawing as a bar. They are one
   * question asked twice (*where is this character headed*) and they are
   * mutually exclusive in practice, which is what a face is for. See
   * `NavigationCard`.
   *
   * A stored layout naming `walk` or `loop` drops on load, like any id this
   * list no longer has, and this lands in its shipped position — which is
   * where both of them were.
   */
  { id: 'navigation', label: t('cards.navigation.title') },
  { id: 'party', label: t('cards.party.title') },
  { id: 'notifications', label: t('cards.alerts.title') },
  { id: 'realm', label: t('cards.realm.title') },
  /*
   * Beside Realm, because they answer two halves of one question. Realm is the
   * listing the server maintains — who is logged in *now*, and what the realm
   * thinks of them. Players is what this client has accumulated about each of
   * them and keeps after they walk out: where they were last seen, the numbers
   * they answered `@health` with, and whether their `@` commands are answered
   * at all.
   *
   * They are two cards rather than two faces because they cut the same people
   * by two different questions — Realm by **standing**, who is dangerous;
   * Players by **reach**, who can talk to this character and who has been
   * trying — and a table takes one filtering dimension.
   */
  { id: 'players', label: t('cards.players.title') },
  /*
   * And beside those two, the third cut of the same people: the gang, which is
   * a group the *realm* maintains rather than one this client observed. It is a
   * card and not a settings page because its subject is learned from the wire —
   * which gang this character is in, and who else is in it, both come off the
   * `who` listing and both change while somebody is playing — and because what
   * it edits is a permission that applies to all of them at once.
   */
  { id: 'gang', label: t('cards.gang.title') },
  /*
   * There is no Player card. One person, chosen by clicking a name on either
   * listing, is a *question asked now* rather than an instrument watched, so it
   * is a slide-out beside the listing (`PlayerFlyout`) — a card for it was one
   * more slot on a rail somebody wanted short, and a face of Players could not
   * be read beside the listing it was chosen from. A stored layout naming
   * `player` drops on load, like any id this list no longer has.
   */
  { id: 'inventory', label: t('cards.inventory.title') },
  /*
   * Beside Carrying, because the two are one question asked about two places:
   * what this character has on them, and what it has left somewhere safe.
   *
   * **A card and not a face of Room**, unlike the shop. A shop is a property of
   * the room the character is standing in and stops being true on the next
   * step; a balance is *accumulated* — it is learned in one town and still
   * wanted in another, which is the Players card's justification exactly ("what
   * this client has accumulated about each of them and keeps after they walk
   * out"). The room's own `BANK` face answers "what is in this vault"; nothing
   * standing in one room can answer "and what about the other six".
   *
   * Put away by default for the Gang card's reason: most characters have banked
   * nowhere, and a card reading "no bank has said" on every rail is a slot
   * spent on an absence.
   */
  { id: 'banks', label: t('cards.banks.title') },
  /*
   * There is no Shop card. A shop is a property of a *room*, so it is a face of
   * the Room card — `ROOM · SHOP`, and `TEMPLE`, `BANK` or `TRAINER` where the
   * realm says so. As a card of its own it appeared and disappeared from the
   * rail as the character walked in and out of shops, which is the churn a
   * fixed card exists to prevent applied to the rail itself. A stored layout
   * naming `shop` drops on load, like any id this list no longer has.
   */
  { id: 'conversation', label: t('cards.talk.title') },
  /*
   * The reference a player used to keep on paper — what the realm data knows
   * about any name: a monster's health and temper, an item's price, weight
   * and provenance, a spell's cost and level. Last of the playing cards
   * because it is *looked up* rather than watched; clicking a name on the
   * Room, Carrying or Shop cards lands here. It replaced a Spells card that
   * listed every spell in the realm, which answered no question anybody
   * standing in a room was asking.
   */
  { id: 'reference', label: t('cards.reference.title') },
  /*
   * How the fighting has actually been going — the MegaMUD accuracy window's
   * question, answered from the stream. Put away by default, like Banks and
   * Gang: it is a card somebody opens to *ask* something, not one they watch,
   * and the rail is short on purpose.
   */
  { id: 'stats', label: t('cards.stats.title') },
  // The diagnostics half. Toggled as a group by the rail shortcut, and each one
  // can still be put away on its own — "all cards" means all of them.
  { id: 'session', label: t('cards.session.title') },
  { id: 'link', label: t('cards.link.title') },
  { id: 'automation', label: t('cards.automation.title') },
  { id: 'stream', label: t('cards.stream.title') }
] as const;

export type CardId = (typeof CARDS)[number]['id'];

const IDS: readonly CardId[] = CARDS.map((card) => card.id);

export function cardLabel(id: CardId): string {
  return CARDS.find((card) => card.id === id)?.label ?? id;
}

/**
 * Put away unless a player has said otherwise: Inventory, Talk, Gang, Banks and
 * Combat Stats are opt-in because not every character wants them — and most
 * characters are in no gang at all, so a Gang card on every rail by default
 * would be a slot spent on "this character is in no gang" for nearly everybody.
 * Banks is the same shape: a character that has never banked has nothing for it
 * to say. Combat Stats is the other shape — a card somebody opens to ask a
 * question rather than one they watch while playing.
 */
const DEFAULT_AWAY: readonly CardId[] = ['inventory', 'conversation', 'gang', 'banks', 'stats'];

/**
 * Cards whose shipped home is a strip docked to the console rather than the
 * rail.
 *
 * One so far, and the strip is the point of it: a toolbar is a *row*, and the
 * rail is a column. The strips overlay the console rather than taking rows
 * from it, so this appearing does not resize the terminal — a resize goes out
 * over NAWS.
 */
const DEFAULT_ABOVE: readonly CardId[] = ['toolbar'];

/**
 * A card lifted off the rail and left over the console.
 *
 * Geometry is in **fractions of the workspace**, never pixels. Users run
 * display scaling, drag windows between monitors and change the terminal font
 * size; a float remembered in pixels lands somewhere else — or off screen
 * entirely — the first time any of those changes. This is the same rule the
 * layout path already follows for columns.
 */
export interface FloatState {
  id: CardId;
  /** Stays in view whichever character is shown. See `CardLayoutApi.pin`. */
  pinned?: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * How solid the card is, 0–1. One number, two alphas.
   *
   * A floating card is **always** see-through — at its most solid the fill is
   * only 60% and you can still read the console under it. That is the whole
   * point of putting a card there rather than on the rail, and a slider whose
   * top end is opaque makes the feature possible to miss entirely.
   *
   * The fill and the text move together but never to the same place: the text
   * stays well ahead, because a card you can see through is useful and a
   * *readout* you can see through is not. See `floatAlphas`.
   */
  solidity: number;
}

/**
 * The two alphas a floating card is drawn with, from the one slider.
 *
 * Fill 25–90%, text 60–100%. The gap between them is the design: the fill is
 * always the more transparent of the two, so at any setting a *number* on the
 * card is more legible than the panel it sits on — a card you can see through
 * is useful where a readout you can see through is not.
 *
 * **The top end was 60% fill and was still too transparent to read against a
 * busy console**, which is the state a floating card is most often looked at
 * in. It goes to 90%: not fully opaque, because a card that completely hides
 * the game is one the player would close rather than move, and the whole point
 * of floating it was to keep both. The bottom end is unchanged — a card that
 * can be made to vanish is one that cannot be dragged back.
 */
export const FLOAT_FILL = { min: 0.25, max: 0.9 } as const;
export const FLOAT_TEXT = { min: 0.6, max: 1 } as const;

export function floatAlphas(solidity: number): { fill: number; text: number } {
  const t = clamp(solidity, 0, 1);
  return {
    fill: FLOAT_FILL.min + t * (FLOAT_FILL.max - FLOAT_FILL.min),
    text: FLOAT_TEXT.min + t * (FLOAT_TEXT.max - FLOAT_TEXT.min)
  };
}

/**
 * What a player has set on one card, for one character.
 *
 * Kept beside the arrangement rather than in the options file, and for the
 * same reason the arrangement is: this is a preference somebody changes by
 * clicking on the card in front of them, and writing it back into a YAML file
 * full of their own comments would mean the client fighting them for it. Per
 * character, because the key is the profile's filename — a healer's rail and a
 * warrior's rail are already two different instruments.
 *
 * Every field is optional and absent means *the card's own default*, never
 * `false`: a settings object written by a build that had one fewer option must
 * not silently turn that option off for everybody who already has one stored.
 */
export interface CardSettings {
  /**
   * Take the card off the rail while it has nothing to say.
   *
   * Only meaningful for the cards in `HIDES_WHEN_EMPTY`, which is also where
   * each one's default lives — absent here means *that* default, never
   * `false`. The Combat card's is `false`, which is the change todo 04 asked
   * for: it used to appear when a fight started and vanish when it ended,
   * which on a busy route is several times a minute, and every card below it
   * on the rail moved each time.
   */
  autoHide?: boolean;
  /**
   * A palette for this card alone, chosen per appearance.
   *
   * Two entries and not one, because the client's own theme is two themes:
   * pick Nord for the Combat card while the client is dark and switching the
   * client to a light theme must not leave one dark hole in a light rail. The
   * card follows whichever half matches, and follows the client where that
   * half is unset — which is every card until somebody says otherwise.
   *
   * The value is a `ThemeId` from the same registry the client's own theme
   * comes from, so a card palette is one of the sixteen already in the build
   * with its contrast asserted, rather than a second set of colours to keep
   * legible.
   */
  theme?: Partial<Record<Appearance, ThemeId>>;
  /**
   * Talk card: draw the time beside each line. On unless this says otherwise.
   *
   * The time is *recorded* either way — `Block.at` is stamped by the classifier
   * and `TalkLog` writes the whole block — so this is only about what the card
   * draws, which is why it is here and not in the character's own file.
   */
  talkStamps?: boolean;
  /** Talk card: which format that time is written in. See `TALK_STAMPS`. */
  talkStamp?: TalkStamp;
  /** Talk card: how a line's parts are arranged. See `TALK_LAYOUTS`. */
  talkLayout?: TalkLayout;
  /**
   * Map card: how much of the realm to fit on it, 0 (sparse) to 1 (dense).
   *
   * A fraction rather than a room count, because what it chooses is how small
   * a room may be drawn — the count still comes from the card's own measured
   * box, so a map dragged twice as big still shows more at every setting.
   * `roomPixelsFor` is where the two ends live.
   */
  mapDensity?: number;
}

/** What a card is set to when nothing has been set on it. */
export const NO_CARD_SETTINGS: CardSettings = {};

/**
 * The cards that can have nothing to say, and whether each takes itself off
 * the rail when it does.
 *
 * These five used to be five separate hard-coded answers in `cardElement` —
 * Party and Navigation hid themselves, Combat did until todo 04, and Gang and
 * Banks never did — and none of them could be changed by the person looking at
 * the rail. They are one question (*should a card that has nothing to say hold
 * its place*), so they are one setting with a per-card default: the default is
 * what each card did before, and the option is what makes the other answer
 * reachable.
 *
 * A card **absent from this table offers no such option**, because it always
 * has something true to say. That is what the settings popup builds its
 * toggle from, so a card cannot end up offering a control that does nothing.
 */
export const HIDES_WHEN_EMPTY: Partial<Record<CardId, boolean>> = {
  combat: false,
  party: true,
  navigation: true,
  gang: false,
  banks: false
};

/** Whether this card, as set for this character, leaves the rail when empty. */
export function hidesWhenEmpty(settings: CardSettings, id: CardId): boolean {
  return settings.autoHide ?? HIDES_WHEN_EMPTY[id] ?? false;
}

/**
 * Where a card is. Exactly one of these holds any given card.
 *
 * `above` and `below` are strips docked to the console rather than beside it —
 * the placement asked for in TODO.md for conversation, and the one a floating
 * card cannot give you: it does not cover the game. Rows are cheap and columns
 * are not (the console needs 80 of them), which is why the strips run
 * horizontally and the rail runs vertically.
 */
export interface CardLayout {
  rail: CardId[];
  /** Docked above the console, left to right. */
  above: CardId[];
  /** Docked below it. */
  below: CardId[];
  floats: FloatState[];
  away: CardId[];
  /**
   * What each card has been set to, for cards that have been set at all.
   *
   * Sparse on purpose, and it is deliberately **not** part of "where a card
   * is": putting a card away, floating it or dragging it somewhere else must
   * not throw away what was set on it, or every rearrangement would silently
   * undo a preference. `without` and `reset` both carry it through.
   */
  settings: Partial<Record<CardId, CardSettings>>;
  /**
   * How tall each card is on the rail, for the cards somebody has dragged
   * taller or shorter — as a **fraction of the rail's height**, never pixels,
   * the rule every float's geometry already follows and for the same reason.
   *
   * Sparse: a card with no entry is the height its stylesheet declares. A
   * rail card is a fixed box that never resizes with its contents, and this
   * is the one way its box changes — by the person looking at it, from the
   * grip in its corner.
   */
  heights: Partial<Record<CardId, number>>;
}

/** The lanes a card can be docked in, as the drag machine addresses them. */
export type Lane = 'rail' | 'above' | 'below';

/** A card dropped over the console with no size of its own gets this one. */
export const DEFAULT_FLOAT = { w: 0.26, h: 0.3, solidity: 1 } as const;

const MIN_FLOAT = { w: 0.12, h: 0.1 } as const;

/**
 * The range a rail card can be dragged to, as a fraction of the rail.
 *
 * The floor keeps the heading and one row on screen — a card dragged to
 * nothing cannot be dragged back — and the ceiling is the whole rail, which
 * is the most a card can usefully take.
 */
export const RAIL_HEIGHT = { min: 0.06, max: 1 } as const;

export interface CardLayoutApi extends CardLayout {
  isShown(id: CardId): boolean;
  /** The float for a card, if it is floating. */
  floatOf(id: CardId): FloatState | undefined;
  hide(id: CardId): void;
  show(id: CardId): void;
  /** Put a card in a lane at an index, from wherever it currently is. */
  dock(id: CardId, lane: Lane, index: number): void;
  /** Which lane holds this card, if a lane does. */
  laneOf(id: CardId): Lane | undefined;
  /** Lift a card off the rail and leave it over the console. */
  lift(id: CardId, at: { x: number; y: number }): void;
  moveFloat(id: CardId, at: { x: number; y: number }): void;
  sizeFloat(id: CardId, size: { w: number; h: number }): void;
  /** How solid the card is, 0–1. Drives both the fill and the text. */
  setSolidity(id: CardId, solidity: number): void;
  /**
   * Bring a floating card in front of the others.
   *
   * Paint order is list order, so two floats that overlap show the later one
   * on top — and a click on the visible corner of the one underneath used to
   * leave it there, undraggable until the one covering it was moved away.
   */
  raise(id: CardId): void;
  /**
   * Keep a floating card in view whichever character is shown.
   *
   * Switching characters swaps every card for the shown character's, which is
   * right — the rail is *about* that character. A pinned float is the one
   * deliberate exception: somebody watching a healer's Talk card while playing
   * the warrior has asked for exactly that.
   */
  pin(id: CardId, pinned: boolean): void;
  /** What has been set on a card. Never null: an unset card is an empty object. */
  settingsOf(id: CardId): CardSettings;
  /**
   * Change part of what is set on a card, leaving the rest of it alone.
   *
   * A patch rather than a whole object, because a settings popup writes one
   * field at a time and a caller that had to read-modify-write would be a
   * second place the merge could go wrong. A field set to `undefined` is
   * *cleared*, which is how a card goes back to its own default.
   */
  setSettings(id: CardId, change: Partial<CardSettings>): void;
  /** How tall a card was dragged on the rail, as a fraction of it, or undefined for its own height. */
  heightOf(id: CardId): number | undefined;
  /** Drag a rail card to a height, as a fraction of the rail. Clamped. */
  sizeRail(id: CardId, fraction: number): void;
  /** Back to the height the card declares for itself. */
  resetHeight(id: CardId): void;
  /** Back to the shipped arrangement, for a rail that has been dragged into a corner. */
  reset(): void;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/**
 * The floats with one moved to the end, which is the top of the paint order.
 * The same list back when it is already there, so a click on the front card
 * does not write the layout for nothing.
 */
export function raised(floats: readonly FloatState[], id: CardId): readonly FloatState[] {
  const index = floats.findIndex((entry) => entry.id === id);
  if (index === -1 || index === floats.length - 1) return floats;
  const found = floats[index]!;
  return [...floats.slice(0, index), ...floats.slice(index + 1), found];
}

/**
 * The layout with a card put into a lane at a gap, from wherever it was.
 *
 * The gap is counted the way the drag measures it — **among the lane's cards
 * as drawn, the dragged one included** — so a card already in that lane goes
 * through `reordered`, which knows that a gap past the card's own place is
 * one too far once the card is lifted out. Inserting at the raw gap into the
 * list *without* the card put every downward move one slot too far, for as
 * long as the rail could be dragged: the gap drawn between the second and
 * third cards landed the card third. It went unnoticed because the smoke
 * run only ever dragged a card *up*, and was found the day the gap started
 * being drawn with `reordered` and stopped agreeing with the drop.
 *
 * A card from another lane, a float or the picker has no place in this list
 * yet, and the raw gap is exactly where it goes.
 */
export function docked(current: CardLayout, id: CardId, lane: Lane, index: number): CardLayout {
  const here = current[lane];
  if (here.includes(id)) {
    const next = reordered(here, id, index);
    return next === here ? current : { ...current, [lane]: [...next] };
  }
  const base = without(current, id);
  const list = base[lane];
  const at = clamp(index, 0, list.length);
  return { ...base, [lane]: [...list.slice(0, at), id, ...list.slice(at)] };
}

/** Every operation is "take it out of wherever it was, then put it back". */
function without(current: CardLayout, id: CardId): CardLayout {
  return {
    rail: current.rail.filter((entry) => entry !== id),
    above: current.above.filter((entry) => entry !== id),
    below: current.below.filter((entry) => entry !== id),
    floats: current.floats.filter((entry) => entry.id !== id),
    away: current.away.filter((entry) => entry !== id),
    // Placement, not preference: moving a card must not reset what is set on it.
    settings: current.settings,
    // Nor the height it was dragged to: a card floated and docked again is
    // back at the size somebody chose for it, not the size it shipped at.
    heights: current.heights
  };
}

/**
 * What a stored heights block actually says, card by card.
 *
 * Parsed, not trusted, like the floats: a figure that is not a finite number
 * is absent — the card's own declared height, which is the one answer that is
 * never wrong — and one from a window of a different shape is clamped rather
 * than honoured, so no card can be stored at a height it cannot be dragged
 * back from.
 */
function readHeights(value: unknown): Partial<Record<CardId, number>> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Partial<Record<CardId, number>> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isCardId(id)) continue;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    out[id] = clamp(raw, RAIL_HEIGHT.min, RAIL_HEIGHT.max);
  }
  return out;
}

function isCardId(value: unknown): value is CardId {
  return typeof value === 'string' && IDS.includes(value as CardId);
}

function readFloat(value: unknown): FloatState | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!isCardId(raw['id'])) return null;
  const number = (key: string, fallback: number): number => {
    const found = raw[key];
    return typeof found === 'number' && Number.isFinite(found) ? found : fallback;
  };
  return {
    id: raw['id'],
    // Clamped on the way in as well as on the way out: a layout written by an
    // older build, or by a window that was a different shape, must not put a
    // card somewhere it cannot be dragged back from.
    x: clamp(number('x', 0.4), 0, 0.98),
    y: clamp(number('y', 0.3), 0, 0.98),
    w: clamp(number('w', DEFAULT_FLOAT.w), MIN_FLOAT.w, 1),
    h: clamp(number('h', DEFAULT_FLOAT.h), MIN_FLOAT.h, 1),
    // `opacity` is what this field was called when it meant the fill alpha
    // directly. Read so an arrangement made before the two-alpha model is not
    // silently thrown away; the value means the same end of the range.
    solidity: clamp(number('solidity', number('opacity', DEFAULT_FLOAT.solidity)), 0, 1),
    ...(raw['pinned'] === true ? { pinned: true } : {})
  };
}

/**
 * What a stored settings block actually says, field by field.
 *
 * Parsed, not trusted: this comes out of `localStorage`, which an older build,
 * a hand edit or a half-written value can all have been through. A field that
 * is not the type it should be is **absent**, which means the card's own
 * default — the one answer that is never wrong.
 */
/**
 * The light and dark halves of a card's own palette, as far as they are still
 * real themes.
 *
 * An id this build no longer registers is dropped rather than kept: the card
 * falls back to following the client, which is the answer that is never wrong,
 * where a retained unknown id would be a setting somebody chose and then
 * watched do nothing.
 */
function readCardTheme(value: unknown): Partial<Record<Appearance, ThemeId>> | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const out: Partial<Record<Appearance, ThemeId>> = {};
  for (const appearance of ['light', 'dark'] as const) {
    const found = raw[appearance];
    if (isThemeId(found)) out[appearance] = found;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function readSettings(value: unknown): Partial<Record<CardId, CardSettings>> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Partial<Record<CardId, CardSettings>> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isCardId(id)) continue;
    if (typeof raw !== 'object' || raw === null) continue;
    const found = raw as Record<string, unknown>;
    const theme = readCardTheme(found['theme']);
    const settings: CardSettings = {
      ...(typeof found['autoHide'] === 'boolean' ? { autoHide: found['autoHide'] } : {}),
      ...(theme === null ? {} : { theme }),
      /*
       * Parsed, not trusted: this comes out of `localStorage`, where a build
       * from a fortnight ago and a hand-edited value both live. A word this
       * build cannot draw is dropped rather than carried through to a `switch`
       * with no case for it.
       */
      ...(typeof found['talkStamps'] === 'boolean' ? { talkStamps: found['talkStamps'] } : {}),
      ...(isTalkStamp(found['talkStamp']) ? { talkStamp: found['talkStamp'] } : {}),
      ...(isTalkLayout(found['talkLayout']) ? { talkLayout: found['talkLayout'] } : {}),
      ...(typeof found['mapDensity'] === 'number' && Number.isFinite(found['mapDensity'])
        ? { mapDensity: Math.max(0, Math.min(1, found['mapDensity'])) }
        : {})
    };
    // A card whose whole block parsed to nothing is a card with nothing set.
    if (Object.keys(settings).length > 0) out[id] = settings;
  }
  return out;
}

/**
 * Fill in what a stored layout does not mention, and drop what is no longer a
 * card.
 *
 * Every card ends up in exactly one place. A card the stored layout has never
 * heard of — one this build just added — goes where the shipped arrangement
 * puts it rather than nowhere, because a card nobody can find is a card that
 * was never built.
 */
export function normalizeLayout(partial: Partial<CardLayout>): CardLayout {
  const rail: CardId[] = [];
  const above: CardId[] = [];
  const below: CardId[] = [];
  const floats: FloatState[] = [];
  const away: CardId[] = [];
  const placed = new Set<CardId>();

  const take = (id: CardId): boolean => {
    if (placed.has(id)) return false;
    placed.add(id);
    return true;
  };

  for (const id of partial.rail ?? []) if (isCardId(id) && take(id)) rail.push(id);
  for (const id of partial.above ?? []) if (isCardId(id) && take(id)) above.push(id);
  for (const id of partial.below ?? []) if (isCardId(id) && take(id)) below.push(id);
  for (const entry of partial.floats ?? []) {
    const parsed = readFloat(entry);
    if (parsed && take(parsed.id)) floats.push(parsed);
  }
  for (const id of partial.away ?? []) if (isCardId(id) && take(id)) away.push(id);

  // Anything this build knows about that the stored layout did not.
  for (const id of IDS) {
    if (placed.has(id)) continue;
    if (DEFAULT_AWAY.includes(id)) away.push(id);
    else if (DEFAULT_ABOVE.includes(id)) above.push(id);
    else rail.push(id);
  }

  // Back into the shipped order, so a brand-new card lands where it belongs
  // rather than at the bottom. Cards the player has actually arranged keep the
  // order they were arranged in, because they were already in `partial.rail`.
  const arranged = new Set(partial.rail ?? []);
  rail.sort((a, b) => {
    if (arranged.has(a) && arranged.has(b)) return 0;
    if (arranged.has(a) !== arranged.has(b)) return arranged.has(a) ? -1 : 1;
    return IDS.indexOf(a) - IDS.indexOf(b);
  });

  /*
   * Settings are keyed by card rather than positioned, so nothing has to be
   * placed — only parsed. It happens here rather than in `parse` because this
   * is the one funnel every stored layout comes through, and a second entry
   * point that skipped the parsing would be a stored value nothing had checked.
   * Idempotent, so `reset` handing back already-parsed settings costs nothing.
   */
  return {
    rail,
    above,
    below,
    floats,
    away,
    settings: readSettings(partial.settings),
    heights: readHeights(partial.heights)
  };
}

function parse(stored: string | null): CardLayout | null {
  if (stored === null) return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (typeof value !== 'object' || value === null) return null;
    const raw = value as Record<string, unknown>;
    return normalizeLayout({
      rail: Array.isArray(raw['rail']) ? (raw['rail'] as CardId[]) : undefined,
      above: Array.isArray(raw['above']) ? (raw['above'] as CardId[]) : undefined,
      below: Array.isArray(raw['below']) ? (raw['below'] as CardId[]) : undefined,
      floats: Array.isArray(raw['floats']) ? (raw['floats'] as FloatState[]) : undefined,
      away: Array.isArray(raw['away']) ? (raw['away'] as CardId[]) : undefined,
      // Cast like the lists above it: `normalizeLayout` is what actually reads
      // this, field by field, and drops whatever is not what it should be.
      settings: raw['settings'] as CardLayout['settings']
    });
  } catch {
    return null;
  }
}

/**
 * How a character's rail is arranged, remembered.
 *
 * Per character, not per client: a healer watches different things from a
 * warrior, and someone running four of them wants each rail to be about the one
 * it belongs to. The key is the session id, which is the profile's filename, so
 * the arrangement follows the character rather than the tab it happens to be in.
 *
 * Stored in `localStorage` rather than the options file on purpose — this is a
 * preference someone changes by dragging, and writing it back into a file full
 * of their own comments would mean the client fighting them for it. Same
 * reasoning as density and theme.
 */
export function useCardLayout(session: SessionId): CardLayoutApi {
  const key = `mudengine.layout.${session}`;
  // What the same character's cards were stored under before a layout was a
  // thing worth keeping. Read once, so someone who had put two cards away does
  // not get them back on the next launch.
  const legacyKey = `mudengine.cards.${session}`;

  const read = useCallback((): CardLayout => {
    try {
      const found = parse(window.localStorage.getItem(key));
      if (found) return found;
      const legacy: unknown = JSON.parse(window.localStorage.getItem(legacyKey) ?? 'null');
      if (Array.isArray(legacy)) return normalizeLayout({ away: legacy as CardId[] });
      return normalizeLayout({});
    } catch {
      // Private mode, storage disabled, or a value written by an older build.
      return normalizeLayout({});
    }
  }, [key, legacyKey]);

  const [layout, setLayout] = useState<CardLayout>(read);

  // Switching character switches instrument.
  useEffect(() => {
    setLayout(read());
  }, [read]);

  const store = useCallback(
    (next: CardLayout) => {
      setLayout(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // The arrangement still applies for as long as the window is open.
      }
    },
    [key]
  );

  const api = useMemo<CardLayoutApi>(() => {
    const patchFloat = (id: CardId, change: Partial<FloatState>): void => {
      const found = layout.floats.find((entry) => entry.id === id);
      if (!found) return;
      store({
        ...layout,
        floats: layout.floats.map((entry) => (entry.id === id ? { ...entry, ...change } : entry))
      });
    };

    return {
      ...layout,
      isShown: (id) => !layout.away.includes(id),
      floatOf: (id) => layout.floats.find((entry) => entry.id === id),
      hide: (id) => {
        const base = without(layout, id);
        store({ ...base, away: [...base.away, id] });
      },
      show: (id) => {
        if (!layout.away.includes(id)) return;
        const base = without(layout, id);
        store({ ...base, rail: [...base.rail, id] });
      },
      dock: (id, lane, index) => {
        const next = docked(layout, id, lane, index);
        // A drop back into its own gap moves nothing and writes nothing.
        if (next !== layout) store(next);
      },
      laneOf: (id) =>
        layout.rail.includes(id)
          ? 'rail'
          : layout.above.includes(id)
            ? 'above'
            : layout.below.includes(id)
              ? 'below'
              : undefined,
      lift: (id, at) => {
        const existing = layout.floats.find((entry) => entry.id === id);
        const base = without(layout, id);
        store({
          ...base,
          floats: [
            ...base.floats,
            {
              id,
              x: clamp(at.x, 0, 0.98),
              y: clamp(at.y, 0, 0.98),
              w: existing?.w ?? DEFAULT_FLOAT.w,
              h: existing?.h ?? DEFAULT_FLOAT.h,
              solidity: existing?.solidity ?? DEFAULT_FLOAT.solidity
            }
          ]
        });
      },
      moveFloat: (id, at) => patchFloat(id, { x: clamp(at.x, 0, 0.98), y: clamp(at.y, 0, 0.98) }),
      sizeFloat: (id, size) =>
        patchFloat(id, {
          w: clamp(size.w, MIN_FLOAT.w, 1),
          h: clamp(size.h, MIN_FLOAT.h, 1)
        }),
      setSolidity: (id, solidity) => patchFloat(id, { solidity: clamp(solidity, 0, 1) }),
      pin: (id, pinned) => patchFloat(id, pinned ? { pinned: true } : { pinned: undefined }),
      settingsOf: (id) => layout.settings[id] ?? NO_CARD_SETTINGS,
      setSettings: (id, change) => {
        const merged: CardSettings = { ...(layout.settings[id] ?? {}), ...change };
        // A field cleared back to the card's own default leaves no key behind,
        // and a card with nothing set leaves no block behind — so what is on
        // disk is what somebody actually chose, and a default that changes in
        // a later build reaches them.
        for (const key of Object.keys(merged) as Array<keyof CardSettings>) {
          if (merged[key] === undefined) delete merged[key];
        }
        const next = { ...layout.settings };
        if (Object.keys(merged).length > 0) next[id] = merged;
        else delete next[id];
        store({ ...layout, settings: next });
      },
      raise: (id) => {
        const next = raised(layout.floats, id);
        if (next !== layout.floats) store({ ...layout, floats: [...next] });
      },
      heightOf: (id) => layout.heights[id],
      sizeRail: (id, fraction) => {
        const next = clamp(fraction, RAIL_HEIGHT.min, RAIL_HEIGHT.max);
        if (layout.heights[id] === next) return;
        store({ ...layout, heights: { ...layout.heights, [id]: next } });
      },
      resetHeight: (id) => {
        if (layout.heights[id] === undefined) return;
        const heights = { ...layout.heights };
        delete heights[id];
        store({ ...layout, heights });
      },
      /*
       * The *arrangement* goes back to how it ships; what is set on each card
       * stays. This is reached for by somebody who has dragged the rail into a
       * corner, and throwing away a theme and an auto-hide choice along with
       * the mess would make it a control nobody dares press.
       */
      reset: () => store(normalizeLayout({ settings: layout.settings }))
    };
  }, [layout, store]);

  return api;
}
