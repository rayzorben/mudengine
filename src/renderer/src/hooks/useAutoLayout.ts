/**
 * Auto layout on the card rail (todo 01, 2026-10-03): measures what each
 * card draws, asks `lib/autoLayout.ts` for the rail, and draws it. A card
 * planned at a size it was not measured at is measured again once it is
 * drawn there, a few times at most. The arrangement from before auto layout
 * is kept per character until undone. See `mudengine-ui` › `parts/cards.md`, *Auto
 * layout*.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SessionId } from '@shared/ipc';

import { autoLayout, rowsFor, type FitCard, type FitFrame } from '../lib/autoLayout';
import { contentHeight } from '../lib/cardContent';
import { CARD_SIZES, isCardSize, type CardSize } from '../lib/cardSize';
import {
  LEAST_CARD,
  type AutoLayoutApi,
  type CardId,
  type CardLayoutApi,
  type RailArrangement,
  type RailGridView
} from '../lib/cards';
import { NOTHING_KEPT, preferredOn, railFor } from '../lib/railCards';
import { sameBox, type GridBox } from '../lib/railGrid';
import { forgetStored, readStored, writeStored } from '../lib/storage';
import { readArrangement } from './useCardLayout';

/** Plans drawn before the rail is left as it is: one, and a measure at each size a card can step to. */
const PASSES = CARD_SIZES.length + 1;
/** Frames a drawn plan is given to reach its boxes and sizes before it is measured anyway. */
const SETTLE_FRAMES = 30;

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Whether the rail stands every card where `placed` put it, and no other. */
function sameArrangement(
  placed: ReadonlyMap<CardId, GridBox>,
  drawn: ReadonlyMap<CardId, GridBox>
): boolean {
  if (placed.size !== drawn.size) return false;
  return [...placed].every(([id, box]) => {
    const at = drawn.get(id);
    return at !== undefined && sameBox(at, box);
  });
}

const kept = (key: string): RailArrangement | null =>
  readStored(
    key,
    (stored) => readArrangement(JSON.parse(stored)),
    () => null
  );

/** The grid as `autoLayout` reads it, measured now; null while there is no rail. */
function measureFrame(rail: RailGridView): FitFrame | null {
  const frame = rail.frame();
  const rows = rail.room();
  const bounds = rail.bounds();
  if (!frame || !bounds || rows === null) return null;
  const { columns, cell, gap } = frame;
  return { columns, rows, cell, gap, bounds, least: LEAST_CARD };
}

export function useAutoLayout(
  session: SessionId,
  layout: Pick<
    CardLayoutApi,
    'placeAll' | 'restoreRail' | 'isRolled' | 'rail' | 'spots' | 'sizes' | 'columns'
  >,
  rail: RailGridView
): AutoLayoutApi {
  const key = `mudengine.layout.${session}.before-auto`;
  const [canUndo, setCanUndo] = useState(() => kept(key) !== null);
  useEffect(() => setCanUndo(kept(key) !== null), [key]);

  // Read when a pass runs, not when it was asked for: every placement makes a
  // new layout api.
  const live = useRef(layout);
  live.current = layout;
  // A run started later, or a character switched to, ends the one under way.
  const runs = useRef(0);
  useEffect(() => () => void (runs.current += 1), [key]);

  /** Frames until the rail draws every card of the plan in its box at its size. */
  const settled = useCallback(
    async (boxes: ReadonlyMap<CardId, GridBox>, sizes: ReadonlyMap<CardId, CardSize | null>) => {
      for (let frame = 0; frame < SETTLE_FRAMES; frame += 1) {
        await nextFrame();
        const drawn = rail.drawn();
        const there = [...boxes].every(([id, box]) => {
          const at = drawn.get(id);
          const size = sizes.get(id);
          return (
            at !== undefined &&
            sameBox(at, box) &&
            (size == null || rail.card(id)?.dataset.cardSize === size)
          );
        });
        if (there) break;
      }
      // One frame more, for what a card draws at its new size.
      await nextFrame();
    },
    [rail]
  );

  const run = useCallback(() => {
    const token = (runs.current += 1);
    if (rail.drawn().size === 0) return;
    // The player's own arrangement is what undo is for: a second run keeps
    // the one the first replaced, not the first run's. The arrangement as
    // kept, never as a stacked rail draws it.
    if (kept(key) === null) {
      const { rail: order, spots, sizes, columns } = live.current;
      writeStored(key, JSON.stringify({ rail: order, spots, sizes, columns }));
    }
    setCanUndo(kept(key) !== null);
    const needs = new Map<CardId, FitCard<CardId>['needs']>();
    const pass = async (): Promise<void> => {
      let placed: ReadonlyMap<CardId, GridBox> | null = null;
      for (let n = 0; n < PASSES && token === runs.current; n += 1) {
        const frame = measureFrame(rail);
        if (!frame) return;
        const drawn = rail.drawn();
        // A card dropped, sized, shown or put away since the last pass is the
        // player's say, and the run ends there rather than moving it again.
        if (placed !== null && !sameArrangement(placed, drawn)) return;
        const width = railFor(drawn.keys(), NOTHING_KEPT, frame.columns);
        const cards = [...drawn].map(([id, box]): FitCard<CardId> => {
          const element = rail.card(id);
          const size = element?.dataset.cardSize;
          const wanted = preferredOn(id, width);
          const known =
            element && isCardSize(size) && box.w === wanted.w
              ? { ...needs.get(id), [size]: rowsFor(contentHeight(element), frame) }
              : (needs.get(id) ?? {});
          needs.set(id, known);
          const rolled = live.current.isRolled(id);
          return { id, wanted, needs: known, ...(rolled ? { keep: box } : {}) };
        });
        const plan = autoLayout(cards, frame);
        live.current.placeAll(plan.boxes, width);
        placed = plan.boxes;
        if (plan.unmeasured.length === 0) break;
        await settled(plan.boxes, plan.sizes);
      }
      if (token === runs.current) rail.scroller()?.scrollTo({ top: 0 });
    };
    // Measuring and placing only, so a throw is a bug: said, with where it was.
    void pass().catch((error: unknown) => {
      console.error('auto layout stopped part way through', error);
    });
  }, [key, rail, settled]);

  const undo = useCallback(() => {
    runs.current += 1;
    const arrangement = kept(key);
    if (arrangement !== null) live.current.restoreRail(arrangement);
    forgetStored(key);
    setCanUndo(kept(key) !== null);
  }, [key]);

  return useMemo(() => ({ run, undo, canUndo }), [run, undo, canUndo]);
}
