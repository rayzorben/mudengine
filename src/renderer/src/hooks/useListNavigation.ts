import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject
} from 'react';

export interface ListNavigation<T> {
  /** Index of the highlighted option, clamped to the current list. */
  cursor: number;
  /** The highlighted option, if the list is not empty. */
  active: T | undefined;
  /**
   * Spread on an option's row, so pointing at it highlights it and the mouse
   * and the keyboard agree. The highlight follows the pointer when it moves
   * over a row. A list drawn under a resting pointer fires `mouseenter` on
   * whatever row lands there, and Enter would take an option nobody pointed
   * at (measured 2026-10-09 on a room list: row 5, under where a drag had
   * left the pointer).
   */
  hover(index: number): { onMouseMove(): void };
  /** Highlight an option and scroll it into view, as an arrow key would. */
  point(index: number): void;
  /**
   * Attach to the text input.
   *
   * Arrows, Home, End, Enter and Escape are taken; **everything else is left
   * alone**, so the field keeps typing normally. The arrows are a navigation
   * layer over the input, not a mode it enters.
   */
  onKeyDown(event: KeyboardEvent): void;
  /**
   * Attach to the scroll container, so the highlight can stay in view.
   *
   * Typed as the `<ul>` every filtered list here actually is, so no call site
   * has to cast — a surface whose list is not a `<ul>` widens this then.
   */
  listRef: RefObject<HTMLUListElement>;
  /** Whether an option is the highlighted one. */
  isActive(index: number): boolean;
}

export interface ListNavigationOptions<T> {
  items: T[];
  onChoose(item: T): void;
  /** Escape, when the surface has somewhere to go. */
  onCancel?(): void;
  /**
   * What makes the old highlight meaningless: the query, for a list that also
   * grows when a group is opened. Opening a group lengthens the list without
   * re-asking anything, and resetting on the length sent the highlight and
   * the scroll back to the first row. Defaults to the list's length.
   */
  resetOn?: unknown;
  /**
   * Who a row is, for a list that changes under the highlight without being
   * re-asked: a group shut above it, a row moved into a section. With it the
   * highlight stays on the same row wherever that row moves; without it the
   * highlight is a position.
   */
  keyOf?(item: T): string;
}

/**
 * Arrow-key navigation over a list that sits under a text field.
 *
 * Every filtered list in this app is the same interaction — type to narrow,
 * arrow to choose, Enter to take it, Escape to leave — and it existed twice in
 * two different states of completeness because each surface implemented its own
 * key handling. The command palette navigated; the room search did not, and
 * Enter silently took the first match whatever was highlighted. Nothing forced
 * them to agree, so they did not.
 *
 * This is the thing that forces it. A new list surface gets the whole behaviour
 * by using the hook, and cannot get half of it.
 *
 * The rules it encodes, from docs/ui-design.md §3.6:
 *
 * - The input keeps the caret and keeps typing. Arrows do not steal it.
 * - The highlight is clamped, not wrapped past the ends by accident — it wraps
 *   deliberately, which is what a short list wants.
 * - Moving the pointer over an option points at it, so the mouse and the
 *   keyboard never disagree about what Enter would do. A pointer at rest
 *   leaves the highlight where it is.
 * - The highlight is scrolled into view, because a selection you cannot see is
 *   a selection you will not trust.
 */
export function useListNavigation<T>({
  items,
  onChoose,
  onCancel,
  resetOn,
  keyOf
}: ListNavigationOptions<T>): ListNavigation<T> {
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  // The row the highlight was put on, so a list that moves keeps it there.
  const pointed = useRef<string | null>(null);

  // A shorter list must not leave the highlight past its end.
  const clamped = items.length === 0 ? 0 : Math.min(cursor, items.length - 1);
  const followed =
    keyOf === undefined || pointed.current === null
      ? -1
      : items.findIndex((item) => keyOf(item) === pointed.current);
  const at = followed >= 0 ? followed : clamped;

  // Hold what the highlight is on now, and the position it is at.
  useEffect(() => {
    const item = items[at];
    pointed.current = item === undefined || keyOf === undefined ? null : keyOf(item);
    if (at !== cursor) setCursor(at);
  }, [at, cursor, items, keyOf]);

  const reset = resetOn === undefined ? items.length : resetOn;

  // Re-filtering starts again at the top: the old position meant something
  // about a list that no longer exists.
  useEffect(() => {
    pointed.current = null;
    setCursor(0);
  }, [reset]);

  useEffect(() => {
    const node = listRef.current?.querySelector('[data-active="true"]');
    if (node) node.scrollIntoView({ block: 'nearest' });
  }, [at, reset]);

  // Pointed at by hand, so the row is held by key from here: the sync effect
  // above runs only when the position moves, and a pointer resting on the
  // highlighted row moves nothing.
  const hold = useCallback(
    (index: number) => {
      const item = items[index];
      pointed.current = item === undefined || keyOf === undefined ? null : keyOf(item);
    },
    [items, keyOf]
  );

  const move = useCallback(
    (delta: number) => {
      if (items.length === 0) return;
      setCursor((current) => {
        const next = (Math.min(current, items.length - 1) + delta + items.length) % items.length;
        hold(next);
        return next;
      });
    },
    [items.length, hold]
  );

  const point = useCallback(
    (index: number) => {
      const next = Math.max(0, index);
      hold(next);
      setCursor(next);
    },
    [hold]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          move(1);
          return;
        case 'ArrowUp':
          event.preventDefault();
          move(-1);
          return;
        case 'Home':
          event.preventDefault();
          point(0);
          return;
        case 'End':
          event.preventDefault();
          point(items.length - 1);
          return;
        case 'Enter': {
          const chosen = items[at];
          if (!chosen) return;
          event.preventDefault();
          onChoose(chosen);
          return;
        }
        case 'Escape':
          if (!onCancel) return;
          event.preventDefault();
          onCancel();
          return;
        default:
          // Everything else is typing, and belongs to the field.
          return;
      }
    },
    [at, items, move, onCancel, onChoose, point]
  );

  return {
    cursor: at,
    active: items[at],
    hover: (index: number) => ({ onMouseMove: () => point(index) }),
    point,
    onKeyDown,
    listRef,
    isActive: (index: number) => index === at
  };
}
