/**
 * Completing a tag in the rewrite editor's template: an open brace before the
 * caret offers every tag that answers to what follows it (`templateTags`,
 * ranked by `rankNames`), under the caret, with the keys every filtered list
 * here uses (`useListNavigation`) plus Tab. Escape closes the list and goes
 * no further, as `NameCombo`'s does, since the editor owns its own Escape.
 */
import { useCallback, useLayoutEffect, useMemo, useState, type KeyboardEvent } from 'react';

import type { RewriteEntity } from '@shared/rewrites';
import { rankNames } from '../lib/rankNames';
import { tagAt, templateTags } from '../lib/templateTags';
import { useListNavigation, type ListNavigation } from './useListNavigation';

/** How many tags the list holds; it scrolls past what fits. */
const MOST = 60;

/** One context for measuring the cell, made on first use rather than per keystroke. */
let measuring: CanvasRenderingContext2D | null = null;
function measure(): CanvasRenderingContext2D | null {
  measuring ??= document.createElement('canvas').getContext('2d');
  return measuring;
}

/** The keys the list takes from the textarea while it is open. */
const LIST_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'Enter']);

export interface TagCompletion {
  /** The tags offered, best first; empty while nothing is being typed. */
  items: string[];
  navigation: ListNavigation<string>;
  /** Where the list goes, from the top left of the field it is drawn in; null while closed. */
  at: { x: number; y: number } | null;
  choose(tag: string): void;
  /** The textarea's own handlers. */
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
  /**
   * Reads where the caret is. On select, key-up, click and every change: a
   * selection event alone missed typed text, so the list never opened.
   */
  track(): void;
  onBlur(): void;
  /** The scroller moved under the caret. */
  onScroll(): void;
}

export function useTagCompletion({
  entity,
  template,
  area,
  field,
  replace
}: {
  entity: RewriteEntity;
  template: string;
  area: React.RefObject<HTMLTextAreaElement>;
  /** What the list is placed in: the caret's point is measured from its corner. */
  field: React.RefObject<HTMLElement>;
  /** Puts `text` over `[from, to)` and lands the caret after it. */
  replace(from: number, to: number, text: string): void;
}): TagCompletion {
  const tags = useMemo(() => templateTags(entity), [entity]);
  const [caret, setCaret] = useState<number | null>(null);
  /** The brace Escape closed the list on, so it stays closed until another is typed. */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  const open = caret === null ? null : tagAt(template, caret);
  // Primitives, so the memos and the measuring effect hold still between equal draws.
  const from = open !== null && open.from !== dismissed ? open.from : null;
  const typed = from === null ? null : (open?.typed ?? null);
  const items = useMemo(() => (typed === null ? [] : rankNames(tags, typed, MOST)), [tags, typed]);

  const choose = useCallback(
    (tag: string): void => {
      if (from === null || caret === null) return;
      setCaret(null);
      replace(from, caret, tag);
    },
    [caret, from, replace]
  );

  const navigation = useListNavigation<string>({ items, onChoose: choose, resetOn: typed });

  /*
   * The caret's point, measured after the draw it moved in. The template is
   * drawn in the console's monospaced face with `white-space: pre`, so a
   * caret's column and line are its cell; the cell is measured from the
   * textarea's own font rather than assumed.
   */
  const place = useCallback((): void => {
    const node = area.current;
    const box = field.current;
    if (node === null || box === null || from === null) {
      setAt(null);
      return;
    }
    const style = getComputedStyle(node);
    const context = measure();
    if (context === null) {
      setAt(null);
      return;
    }
    context.font = style.font;
    const cell = context.measureText('M').width;
    const lineHeight = Number.parseFloat(style.lineHeight);
    const before = template.slice(0, from);
    const line = before.split('\n').length;
    const column = from - (before.lastIndexOf('\n') + 1);
    const text = node.getBoundingClientRect();
    const outer = box.getBoundingClientRect();
    setAt({
      x: text.left - outer.left + Number.parseFloat(style.paddingLeft) + column * cell,
      y: text.top - outer.top + Number.parseFloat(style.paddingTop) + line * lineHeight
    });
  }, [area, field, from, template]);

  useLayoutEffect(place, [place]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (items.length === 0) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(from);
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      if (navigation.active !== undefined) choose(navigation.active);
      return;
    }
    // Home and End stay the textarea's: they move the caret along the line.
    if (LIST_KEYS.has(event.key)) navigation.onKeyDown(event);
  };

  return {
    items,
    navigation,
    at: items.length === 0 ? null : at,
    choose,
    onKeyDown,
    track: () => {
      const node = area.current;
      const next =
        node !== null && node.selectionStart === node.selectionEnd ? node.selectionEnd : null;
      setCaret(next);
      // The textarea's own value: the template prop has not caught up with a change yet.
      const brace = node === null || next === null ? null : tagAt(node.value, next);
      // Against the newest value: a key-up can run before the Escape's draw.
      setDismissed((was) => (brace !== null && brace.from === was ? was : null));
    },
    onBlur: () => setCaret(null),
    onScroll: place
  };
}
