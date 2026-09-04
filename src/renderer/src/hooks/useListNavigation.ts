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
  /** Point at an option — from a hover, so the mouse and the keyboard agree. */
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
 * - Hovering points at an option, so the mouse and the keyboard never disagree
 *   about what Enter would do.
 * - The highlight is scrolled into view, because a selection you cannot see is
 *   a selection you will not trust.
 */
export function useListNavigation<T>({
  items,
  onChoose,
  onCancel
}: ListNavigationOptions<T>): ListNavigation<T> {
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // A shorter list must not leave the highlight past its end.
  const at = items.length === 0 ? 0 : Math.min(cursor, items.length - 1);

  // Re-filtering starts again at the top: the old position meant something
  // about a list that no longer exists.
  useEffect(() => {
    setCursor(0);
  }, [items.length]);

  useEffect(() => {
    const node = listRef.current?.querySelector('[data-active="true"]');
    if (node) node.scrollIntoView({ block: 'nearest' });
  }, [at, items.length]);

  const move = useCallback(
    (delta: number) => {
      if (items.length === 0) return;
      setCursor((current) => {
        const from = Math.min(current, items.length - 1);
        return (from + delta + items.length) % items.length;
      });
    },
    [items.length]
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
          setCursor(0);
          return;
        case 'End':
          event.preventDefault();
          setCursor(Math.max(0, items.length - 1));
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
    [at, items, move, onCancel, onChoose]
  );

  return {
    cursor: at,
    active: items[at],
    point: setCursor,
    onKeyDown,
    listRef,
    isActive: (index: number) => index === at
  };
}
