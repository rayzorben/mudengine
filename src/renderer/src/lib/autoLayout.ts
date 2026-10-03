/**
 * Auto layout for the card rail (todo 01, 2026-10-03): every card on the rail
 * at its shipped width, each just tall enough for what it draws, packed in the
 * rail's own order so as many as can stay above the fold. Short of room, the
 * lowest cards step down a size (`lib/cardSize.ts`), large to medium to small,
 * before anything is left to scroll; with room to spare, a card whose content
 * runs past its shipped height grows into it.
 *
 * Pure: the heights come in measured (`lib/cardContent.ts`), and a height not
 * yet measured at the size it is planned for is named in `unmeasured`, so the
 * caller draws the plan, measures again and asks again. See `mudengine-ui` ›
 * `parts/cards.md`, *Auto layout*.
 */
import { CARD_SIZES, cardSizeOf, type CardSize, type CardSizeBounds } from './cardSize';
import { firstFree, fitted, type GridBox, type GridSize } from './railGrid';

/** One rail card to lay out. */
export interface FitCard<Id> {
  id: Id;
  /** Its shipped size: the width it is laid out at, and its height before the rail has room to spare. */
  shipped: GridSize;
  /** A rolled card keeps the cells it has: its body is put away, so there is nothing to measure. */
  keep?: GridSize;
  /** Rows its content takes at each size, measured at the width it is laid out at. */
  needs: Partial<Record<CardSize, number>>;
}

/** The grid a plan is drawn on. */
export interface FitFrame {
  /** Cells across. */
  columns: number;
  /** Rows in view with the rail at its top: what stays out of the scrolling. */
  rows: number;
  /** A cell, and the gap a card's box leaves on its right and under it, in px. */
  cell: number;
  gap: number;
  bounds: CardSizeBounds;
  least: GridSize;
}

export interface FitPlan<Id> {
  boxes: Map<Id, GridBox>;
  /** The size each card draws in its box; null for a kept one. */
  sizes: Map<Id, CardSize | null>;
  /** Cards placed at a size whose height was not measured yet. */
  unmeasured: Id[];
}

/** The width a card is laid out at: its shipped width, as far as the grid has room. */
export function laidWidth(shipped: GridSize, columns: number): number {
  return fitted({ x: 0, y: 0, ...shipped }, columns).w;
}

/** Rows a card needs for `px` of card: its box is its cells less the gap. */
export function rowsFor(px: number, frame: Pick<FitFrame, 'cell' | 'gap'>): number {
  return Math.ceil((px + frame.gap) / frame.cell - 1e-6);
}

/** The size a card draws in a box of these cells. */
export function sizeOfCells(
  size: GridSize,
  frame: Pick<FitFrame, 'cell' | 'gap' | 'bounds'>
): CardSize | null {
  const px = (cells: number): number => cells * frame.cell - frame.gap;
  return cardSizeOf({ width: px(size.w), height: px(size.h) }, frame.bounds);
}

/** The heights, in rows, at which a card `w` cells wide draws `size`; null where no height does. */
function rowsAt(size: CardSize, w: number, frame: FitFrame): { low: number; high: number } | null {
  const width = w * frame.cell - frame.gap;
  const medium = rowsFor(frame.bounds.medium, frame);
  const large = rowsFor(frame.bounds.large, frame);
  const low = frame.least.h;
  if (width < frame.bounds.medium) return size === 'small' ? { low, high: Infinity } : null;
  if (size === 'small') return medium - 1 >= low ? { low, high: medium - 1 } : null;
  if (size === 'medium') {
    return { low: Math.max(low, medium), high: width < frame.bounds.large ? Infinity : large - 1 };
  }
  return width < frame.bounds.large ? null : { low: Math.max(low, large), high: Infinity };
}

interface Planned<Id> {
  card: FitCard<Id>;
  w: number;
  size: CardSize | null;
  h: number;
}

/** The height a card is first given at `size`, and whether that was measured. */
function heightAt<Id>(
  card: FitCard<Id>,
  size: CardSize,
  w: number,
  frame: FitFrame
): { h: number; measured: boolean } | null {
  const range = rowsAt(size, w, frame);
  if (range === null) return null;
  const need = card.needs[size];
  const shipped = sizeOfCells({ w, h: card.shipped.h }, frame);
  // Unmeasured, a card is tried at its shipped height, or at the most this
  // size allows when it is stepping down from the size it ships at.
  const first = need ?? (shipped === size ? card.shipped.h : range.high);
  const cap = Math.max(card.shipped.h, range.low);
  return {
    h: Math.min(range.high, Math.max(range.low, Math.min(first, cap))),
    measured: need !== undefined
  };
}

/** Every card at its first free spot, in order, and the row under the lowest. */
function pack<Id>(
  plan: readonly Planned<Id>[],
  columns: number
): { boxes: Map<Id, GridBox>; bottom: number } {
  const boxes = new Map<Id, GridBox>();
  const taken: GridBox[] = [];
  let bottom = 0;
  for (const { card, w, h } of plan) {
    const box = firstFree({ w, h }, taken, columns);
    taken.push(box);
    boxes.set(card.id, box);
    bottom = Math.max(bottom, box.y + box.h);
  }
  return { boxes, bottom };
}

/** The next smaller size a card can draw at its width, with its height there. */
function stepDown<Id>(entry: Planned<Id>, frame: FitFrame): Planned<Id> | null {
  if (entry.size === null) return null;
  for (let i = CARD_SIZES.indexOf(entry.size) - 1; i >= 0; i -= 1) {
    const size = CARD_SIZES[i]!;
    const at = heightAt(entry.card, size, entry.w, frame);
    if (at !== null && at.h < entry.h) return { ...entry, size, h: at.h };
  }
  return null;
}

/**
 * The rail laid out, cards given in the order they are read on it.
 *
 * Each card starts at the size it ships at and the height its content takes
 * there, no taller than it ships. While the cards run past the rows in view,
 * the lowest card that can steps down a size. Once they fit, each card whose
 * content runs longer, top first, grows as far as the cards still fit. A card
 * left past the rows in view scrolls, as every card did before.
 */
export function autoLayout<Id>(cards: readonly FitCard<Id>[], frame: FitFrame): FitPlan<Id> {
  const plan: Planned<Id>[] = cards.map((card) => {
    const w = laidWidth(card.keep ?? card.shipped, frame.columns);
    if (card.keep) return { card, w, size: null, h: card.keep.h };
    const size = sizeOfCells({ w, h: card.shipped.h }, frame) ?? 'small';
    return { card, w, size, h: heightAt(card, size, w, frame)?.h ?? card.shipped.h };
  });

  for (let i = plan.length - 1; i >= 0 && pack(plan, frame.columns).bottom > frame.rows;) {
    const smaller = stepDown(plan[i]!, frame);
    if (smaller === null) i -= 1;
    else plan[i] = smaller;
  }

  if (pack(plan, frame.columns).bottom <= frame.rows) {
    for (const [i, entry] of plan.entries()) {
      const need = entry.size === null ? undefined : entry.card.needs[entry.size];
      const range = entry.size === null ? null : rowsAt(entry.size, entry.w, frame);
      if (need === undefined || range === null) continue;
      const most = Math.min(need, range.high, frame.rows);
      // The tallest that still fits, found by halving.
      let low = entry.h;
      let high = most;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        plan[i] = { ...entry, h: mid };
        if (pack(plan, frame.columns).bottom <= frame.rows) low = mid;
        else high = mid - 1;
      }
      plan[i] = { ...entry, h: low };
    }
  }

  return {
    boxes: pack(plan, frame.columns).boxes,
    sizes: new Map(plan.map(({ card, size }) => [card.id, size])),
    unmeasured: plan
      .filter(({ card, size }) => size !== null && card.needs[size] === undefined)
      .map(({ card }) => card.id)
  };
}
