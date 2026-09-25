import { useCallback, useEffect, useMemo, useState } from 'react';

import type { SessionId } from '@shared/ipc';
import { isThemeId, type Appearance, type ThemeId } from '@shared/themes';
import { isTalkLayout, isTalkStamp } from '@shared/talk';
import { isStatsGraph, STATS_WINDOW_HOURS } from '@shared/tally';

import {
  CARDS,
  NO_CARD_SETTINGS,
  type CardId,
  type CardLayout,
  type CardLayoutApi,
  type CardSettings,
  type FloatState,
  type Lane
} from '../lib/cards';
import { reordered } from '../lib/reorder';

const IDS: readonly CardId[] = CARDS.map((card) => card.id);

/**
 * Put away unless a player has said otherwise: Inventory, Talk, Gang, Banks and
 * Combat Stats are opt-in because not every character wants them — and most
 * characters are in no gang at all, so a Gang card on every rail by default
 * would be a slot spent on "this character is in no gang" for nearly everybody.
 * Banks is the same shape: a character that has never banked has nothing for it
 * to say. Combat Stats is the other shape — a card somebody opens to ask a
 * question rather than one they watch while playing.
 */
const DEFAULT_AWAY: readonly CardId[] = [
  'inventory',
  'conversation',
  'gang',
  'banks',
  'stats',
  'builder',
  'quests',
  'hunting'
];

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
 * The two alphas a floating card is drawn with, from the one slider.
 *
 * Fill 25–100%, text 60–100%. Below the top the fill is the more transparent
 * of the two, so at every setting that shows the game a *number* on the card
 * is more legible than the panel it sits on — a card you can see through is
 * useful where a readout you can see through is not.
 *
 * **The ceiling is the player's to remove and is gone** (2026-09-15, todo 04).
 * It was 60%, then 90%, each time on the argument that a card hiding the game
 * completely is one somebody would close rather than move — which is a reason
 * to ship the slider low, not a reason to withhold the end of it. Whether this
 * particular card, on this particular monitor, is worth the console behind it
 * is the player's call, and it is made by dragging the slider; a maximum that
 * refuses it is the client overruling a decision it asked for.
 *
 * **The floor stays**, and is the one end that is not a preference: a card
 * that can be made invisible is one that cannot be found to be dragged back.
 */
export const FLOAT_FILL = { min: 0.25, max: 1 } as const;
export const FLOAT_TEXT = { min: 0.6, max: 1 } as const;

export function floatAlphas(solidity: number): { fill: number; text: number } {
  const t = clamp(solidity, 0, 1);
  return {
    fill: FLOAT_FILL.min + t * (FLOAT_FILL.max - FLOAT_FILL.min),
    text: FLOAT_TEXT.min + t * (FLOAT_TEXT.max - FLOAT_TEXT.min)
  };
}

/**
 * Where on the slider a stated fill alpha sits. The inverse of `floatAlphas`.
 *
 * Its own arithmetic rather than `clamp`, which is declared further down the
 * module: `DEFAULT_FLOAT` calls this while the module is still initialising,
 * and a `const` arrow read from above its declaration throws.
 */
export function solidityForFill(fill: number): number {
  const t = (fill - FLOAT_FILL.min) / (FLOAT_FILL.max - FLOAT_FILL.min);
  return Math.min(1, Math.max(0, t));
}

/**
 * The fill a card dropped over the console is drawn at.
 *
 * 90%, which was the top of the slider until the ceiling went (todo 04) and is
 * still what a float ought to look like before anybody has touched it: solid
 * enough to read against a busy console, and see-through enough that the point
 * of floating it rather than railing it is visible without dragging anything.
 *
 * It ships **below** the top rather than at it, which it did not before. With
 * a ceiling of 90% those were the same place; with no ceiling, shipping at the
 * top would make every new float opaque and quietly undo the thing the slider
 * exists to offer. The end of the slider is now somewhere the player goes, not
 * somewhere they start.
 */
const DEFAULT_FLOAT_FILL = 0.9;

/** A card dropped over the console with no size of its own gets this one. */
export const DEFAULT_FLOAT = {
  w: 0.26,
  h: 0.3,
  solidity: solidityForFill(DEFAULT_FLOAT_FILL)
} as const;

const MIN_FLOAT = { w: 0.12, h: 0.1 } as const;

/**
 * The range a rail card can be dragged to, as a fraction of the rail.
 *
 * The floor keeps the heading and one row on screen — a card dragged to
 * nothing cannot be dragged back — and the ceiling is the whole rail, which
 * is the most a card can usefully take.
 */
export const RAIL_HEIGHT = { min: 0.06, max: 1 } as const;

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

/**
 * The float a card gets when it is lifted — from a lane, or from where it was
 * already floating.
 *
 * **What is the card's own comes across**: how solid it is, and whether it is
 * pinned into view whichever character is shown. Nothing lifted a card that
 * was already floating until a snap did (todo 02, 2026-09-13), so a pin
 * dropped here would have taken a card out of view on the next character
 * switch because somebody lined it up with its neighbour. What is *not* its
 * own — where it is, and how big — is the caller's to state, and falls back to
 * what it had and then to what a float ships at.
 */
export function lifted(
  id: CardId,
  existing: FloatState | undefined,
  at: { x: number; y: number },
  size?: { w: number; h: number }
): FloatState {
  return {
    id,
    x: clamp(at.x, 0, 0.98),
    y: clamp(at.y, 0, 0.98),
    w: clamp(size?.w ?? existing?.w ?? DEFAULT_FLOAT.w, MIN_FLOAT.w, 1),
    h: clamp(size?.h ?? existing?.h ?? DEFAULT_FLOAT.h, MIN_FLOAT.h, 1),
    solidity: existing?.solidity ?? DEFAULT_FLOAT.solidity,
    ...(existing?.pinned === true ? { pinned: true } : {})
  };
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
    heights: current.heights,
    // Nor whether it was rolled up. A card rolled up on the rail and then
    // dragged over the console is the same card, and unrolling it to move it
    // would be the client undoing a choice in order to honour another.
    rolled: current.rolled
  };
}

/**
 * Which cards a stored layout says are rolled up.
 *
 * Parsed like every other stored list: anything that is not a card this build
 * has is dropped, and a card named twice is held once — a duplicate would make
 * `roll(id, false)` leave one copy behind and read as a toggle that did
 * nothing.
 */
function readRolled(value: unknown): CardId[] {
  if (!Array.isArray(value)) return [];
  const out: CardId[] = [];
  for (const id of value) if (isCardId(id) && !out.includes(id)) out.push(id);
  return out;
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

/** A whole number of things, from `localStorage` where anything may have been. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
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
      ...(typeof found['talkChannels'] === 'boolean'
        ? { talkChannels: found['talkChannels'] }
        : {}),
      ...(typeof found['mapDensity'] === 'number' && Number.isFinite(found['mapDensity'])
        ? { mapDensity: Math.max(0, Math.min(1, found['mapDensity'])) }
        : {}),
      ...(isCount(found['findDays']) ? { findDays: found['findDays'] } : {}),
      ...((STATS_WINDOW_HOURS as readonly number[]).includes(found['statsHours'] as number)
        ? { statsHours: found['statsHours'] as number }
        : {}),
      ...(isStatsGraph(found['statsGraph']) ? { statsGraph: found['statsGraph'] } : {})
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
    heights: readHeights(partial.heights),
    rolled: readRolled(partial.rolled)
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
      settings: raw['settings'] as CardLayout['settings'],
      /*
       * `heights` was written by `store` and never read back here, so a card
       * dragged taller on the rail came back at its shipped height on the next
       * launch — a gesture that appeared to work and was thrown away at the
       * window's edge. Found while adding `rolled` beside it, which is stored
       * exactly the same way and would have inherited the same silence.
       */
      heights: raw['heights'] as CardLayout['heights'],
      rolled: Array.isArray(raw['rolled']) ? (raw['rolled'] as CardId[]) : undefined
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
      lift: (id, at, size) => {
        const existing = layout.floats.find((entry) => entry.id === id);
        const base = without(layout, id);
        store({ ...base, floats: [...base.floats, lifted(id, existing, at, size)] });
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
      isRolled: (id) => layout.rolled.includes(id),
      roll: (id, rolled) => {
        // Asking for the state it is already in writes nothing: every write is
        // a `localStorage` round trip and a new layout object, which rebuilds
        // every card's chrome.
        if (layout.rolled.includes(id) === rolled) return;
        store({
          ...layout,
          rolled: rolled ? [...layout.rolled, id] : layout.rolled.filter((entry) => entry !== id)
        });
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
