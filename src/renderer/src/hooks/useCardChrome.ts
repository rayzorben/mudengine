/**
 * The chrome every card wears — close, the header grip, the corner grip,
 * roll, pin, solidity and its settings — cached per card so its identity holds
 * across renders, and the handles a put-away card's row carries.
 *
 * Out of `App` (todo 733). The closures read the layout and the gestures
 * through refs, so a cached handle never acts on a stale layout. See
 * `mudengine-ui` › *The window redraws what changed*.
 */
import { useCallback, useRef } from 'react';

import type { CardChrome } from '../components/BentoCard';
import type { CardDrag } from './useCardDrag';
import { DEFAULT_FLOAT } from './useCardLayout';
import type { CardResize } from './useCardResize';
import type { CardId, CardLayoutApi, CardSettings, FloatState } from '../lib/cards';
import type { Theme } from '@shared/themes';

/** What a pinned float's chrome reads and writes of its own character's layout. */
type PinnedLayout = Pick<
  CardLayoutApi,
  'hide' | 'settingsOf' | 'setSettings' | 'setSolidity' | 'pin' | 'isRolled' | 'roll'
>;

export interface CardChromes {
  chromeFor(id: CardId): CardChrome;
  pinnedChrome(id: CardId, layout: PinnedLayout, floating: FloatState): CardChrome;
  /** A put-away card's row taken hold of: dragged onto the console or the rail. */
  grabCard(id: CardId, event: React.PointerEvent<HTMLElement>): void;
  /** A put-away card brought out over the console. */
  floatCard(id: CardId): void;
}

export function useCardChrome(
  cards: PinnedLayout &
    Pick<CardLayoutApi, 'floatOf' | 'laneOf' | 'heightOf' | 'resetHeight' | 'lift' | 'raise'>,
  drag: Pick<CardDrag, 'state' | 'begin'>,
  resize: Pick<CardResize, 'begin'>,
  returnFocus: () => void,
  theme: Theme
): CardChromes {
  /*
   * Read through refs by the cached chrome below, which is built once and
   * must not go stale: a closure that captured `cards` or
   * `drag` by value would act on the layout as it stood when the card was
   * first drawn. The render-time assignment is the pattern `TerminalView`'s
   * handlers already use.
   */
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const dragRef = useRef(drag);
  dragRef.current = drag;
  // The corner grip on a rail card, through a ref for the reason `dragRef`
  // is — a card's chrome is cached and must not close over a stale gesture.
  const resizeRef = useRef(resize);
  resizeRef.current = resize;
  // A put-away card's row is a handle too (see `CardPicker`); through the
  // ref so the picker's props hold still between drags.
  const grabCard = useCallback(
    (id: CardId, event: React.PointerEvent<HTMLElement>) =>
      dragRef.current.begin(id, event, { fromControl: true }),
    []
  );
  /**
   * A put-away card brought out over the console rather than onto the rail —
   * the second control on every row of the picker's list.
   *
   * Centred on the workspace, from the float's own shipped size, so no pixel
   * or fraction constant is invented for the position. Two cards floated in a
   * row land on each other; the second is `raise`d above the first, which is
   * both visible and what a person who just asked for it expects to see.
   * Cascading them would need a step nothing measures.
   */
  const floatCard = useCallback((id: CardId) => {
    cardsRef.current.lift(id, {
      x: (1 - DEFAULT_FLOAT.w) / 2,
      y: (1 - DEFAULT_FLOAT.h) / 2
    });
    cardsRef.current.raise(id);
  }, []);

  /**
   * The chrome for a card, cached so its identity is stable across renders.
   *
   * Every card is memoised, and memoisation is only as good as the props: a
   * fresh `onClose` per render re-rendered every card per state flush, which
   * is the very cost the flush exists to avoid. The closures read the layout
   * and the drag machine through refs, so a cached handle never acts on a
   * stale layout; the object is rebuilt only when something a card *draws*
   * changes — dragging, floating, solidity, pinned — or when `returnFocus`
   * itself moves, the one captured value the refs do not cover: a cache that
   * kept the old one would hand the caret back through a stale closure for
   * the life of the window, with nothing failing.
   */
  const chromeCache = useRef(
    new Map<
      CardId,
      { key: string; focus: () => void; settings: CardSettings; chrome: CardChrome }
    >()
  );
  const chromeFor = useCallback(
    (id: CardId): CardChrome => {
      const floating = cardsRef.current.floatOf(id);
      const dragging = dragRef.current.state?.id === id && dragRef.current.state.live;
      // Which lane, and how tall it was dragged there: both part of the key,
      // because a card docked from a strip onto the rail gains the grip and a
      // resized one is drawn at its new height on the next commit, not later.
      const lane = cardsRef.current.laneOf(id);
      const height = cardsRef.current.heightOf(id);
      // Part of the key for the reason the height is: the glyph in the heading
      // states which way the press goes, and a chrome cached across a roll
      // would go on offering the way the card has just come.
      const rolled = cardsRef.current.isRolled(id);
      const key = floating
        ? `float:${floating.solidity}:${floating.pinned === true}:${dragging}:${theme.id}:${rolled}`
        : `rail:${dragging}:${theme.id}:${lane ?? ''}:${height ?? ''}:${rolled}`;
      /*
       * Compared by identity rather than folded into the string key. The store
       * hands back the very object it holds — the shared empty one for a card
       * nothing has been set on — and replaces it only for the card that
       * changed, so identity is exact. Spelling each field into the key would
       * be a list to keep in step with `CardSettings`, and the symptom of
       * forgetting one is a card that ignores a setting until something else
       * happens to invalidate its chrome.
       */
      const settings = cardsRef.current.settingsOf(id);
      const cached = chromeCache.current.get(id);
      if (
        cached &&
        cached.key === key &&
        cached.focus === returnFocus &&
        cached.settings === settings
      )
        return cached.chrome;
      const chrome: CardChrome = {
        cardId: id,
        onClose: () => cardsRef.current.hide(id),
        onGrab: (event: React.PointerEvent<HTMLElement>) => dragRef.current.begin(id, event),
        dragging,
        // Every card's copy menu takes the caret and gives it back here.
        returnFocus,
        /*
         * Rolled up to its heading, and the way back down. On every card and
         * in every placement: a card is rolled where it stands, so nothing
         * here depends on which lane it is in or on whether it floats.
         */
        rolled,
        onRoll: (next: boolean) => cardsRef.current.roll(id, next),
        settings: {
          id,
          value: settings,
          appearance: theme.appearance,
          clientTheme: theme.id,
          onChange: (change) => cardsRef.current.setSettings(id, change)
        },
        ...(floating
          ? {
              translucency: {
                solidity: floating.solidity,
                onChange: (solidity: number) => cardsRef.current.setSolidity(id, solidity)
              },
              pinned: floating.pinned === true,
              onPin: (next: boolean) => cardsRef.current.pin(id, next)
            }
          : {}),
        /*
         * The corner grip, on the rail only: a float has its own, and a
         * docked strip is sized by its splitter. The height rides along where
         * one has been dragged, and its absence means the card's own.
         */
        ...(lane === 'rail'
          ? {
              ...(height !== undefined ? { height } : {}),
              onResize: (event: React.PointerEvent<HTMLElement>) =>
                resizeRef.current.begin(id, event),
              onResizeReset: () => cardsRef.current.resetHeight(id)
            }
          : {})
      };
      chromeCache.current.set(id, { key, focus: returnFocus, settings, chrome });
      return chrome;
    },
    // The theme is a real dependency and not only part of the key: the palette
    // picker offers the half of the registry that matches what the client is
    // wearing, so a card whose chrome was built under the old one would go on
    // offering dark palettes to a light client.
    [returnFocus, theme]
  );

  /**
   * The chrome for a pinned float belonging to a character that is not
   * shown: that character's own settings, solidity, pin and roll, read and
   * written through that character's own layout. No header drag — the drag
   * machine belongs to the shown character's rail.
   */
  const pinnedChrome = useCallback(
    (id: CardId, layout: PinnedLayout, floating: FloatState): CardChrome => {
      return {
        cardId: id,
        onClose: () => layout.hide(id),
        returnFocus,
        // That character's own settings, read and written through that
        // character's own layout — a pinned float belongs to somebody else,
        // and the rest of this object is addressed the same way.
        settings: {
          id,
          value: layout.settingsOf(id),
          appearance: theme.appearance,
          clientTheme: theme.id,
          onChange: (change) => layout.setSettings(id, change)
        },
        translucency: {
          solidity: floating.solidity,
          onChange: (solidity: number) => layout.setSolidity(id, solidity)
        },
        pinned: true,
        onPin: (next: boolean) => layout.pin(id, next),
        // Read and written through that character's own layout, like the
        // settings above: a pinned float belongs to somebody else.
        rolled: layout.isRolled(id),
        onRoll: (next: boolean) => layout.roll(id, next)
      };
    },
    [returnFocus, theme]
  );

  return { chromeFor, pinnedChrome, grabCard, floatCard };
}
