import { useCallback, useState } from 'react';

import { writeClipboard } from '../lib/clipboard';
import { t } from '../lib/i18n';
import type { MenuItem } from '../components/PopupMenu';

/** Where the menu is, and what the click had to offer. */
export interface CopyMenuState {
  x: number;
  y: number;
  /** The text highlighted when the menu opened, or '' if nothing was. */
  selection: string;
  /** The text of the smallest readable thing under the pointer. */
  line: string;
  /** Everything the card says. */
  all: string;
}

/**
 * Right-click to copy, for the cards.
 *
 * The console has had this since copy and paste went in, and the cards had
 * nothing — which is backwards: what a player actually wants to send somebody
 * is a room name, a route, a party member's health or an alert, and every one
 * of those is on a card. Reading it off the screen and typing it back in is the
 * thing a client exists to avoid.
 *
 * **Three offers, because a click can mean three things**, and which one it
 * means is not something the client can know:
 *
 * - *Copy* — what is highlighted. Absent when nothing is, rather than greyed:
 *   unlike the console's menu, where Copy is the entry somebody came for and
 *   its being unavailable is the answer, here there are two other entries that
 *   *do* work, so a dead row would just be in the way.
 * - *Copy line* — the smallest readable thing under the pointer. This is the
 *   one that makes the feature worth having: a room name or a party row is one
 *   element, and selecting it by dragging across a 200-pixel card is fiddlier
 *   than reading it out loud.
 * - *Copy card* — the whole face, for pasting a stat block or a route.
 *
 * Text is taken from the DOM rather than from the state behind it, deliberately:
 * what somebody asked to copy is what they can see, including the units, the
 * separators and the words a formatter put there.
 */
export function useCopyMenu(): {
  menu: CopyMenuState | null;
  /** Put on the element that should answer a right-click. */
  onContextMenu(event: React.MouseEvent): void;
  /** The entries for a `PopupMenu`. Empty when there is nothing to copy. */
  items(menu: CopyMenuState): MenuItem[];
  dismiss(): void;
} {
  const [menu, setMenu] = useState<CopyMenuState | null>(null);

  const onContextMenu = useCallback((event: React.MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const card = event.currentTarget as HTMLElement;
    if (!target) return;

    /*
     * A selection only counts when it is *inside this card*. A leftover
     * highlight in the console — or in another card — would otherwise be
     * offered here as though it were what was clicked on, and the entry would
     * copy something the player cannot see.
     */
    const live = window.getSelection();
    const selection =
      live !== null && live.rangeCount > 0 && !live.isCollapsed && card.contains(live.anchorNode)
        ? live.toString().trim()
        : '';

    event.preventDefault();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      selection,
      line: lineUnder(target, card),
      all: readable(card)
    });
  }, []);

  const dismiss = useCallback(() => setMenu(null), []);

  const items = useCallback(
    (open: CopyMenuState): MenuItem[] => {
      const entries: MenuItem[] = [];
      if (open.selection.length > 0) {
        entries.push({
          label: t('cards.copyMenu.copy'),
          icon: 'copy',
          run: () => {
            dismiss();
            void writeClipboard(open.selection);
          }
        });
      }
      if (open.line.length > 0 && open.line !== open.selection) {
        entries.push({
          label: t('cards.copyMenu.copyLine'),
          icon: 'copy',
          run: () => {
            dismiss();
            void writeClipboard(open.line);
          }
        });
      }
      if (open.all.length > 0 && open.all !== open.line) {
        entries.push({
          label: t('cards.copyMenu.copyCard'),
          icon: 'fileText',
          run: () => {
            dismiss();
            void writeClipboard(open.all);
          }
        });
      }
      return entries;
    },
    [dismiss]
  );

  return { menu, onContextMenu, items, dismiss };
}

/**
 * The text of the smallest readable thing under the pointer.
 *
 * Walks *up* from what was clicked until there is something with text in it,
 * because the click usually lands on a `<span>` holding one word of a row. It
 * stops at the card, so "line" can never quietly become "everything".
 *
 * A definition list is the one shape worth a special case: `<dt>` and `<dd>`
 * are two elements saying one fact — `Health` and `98/400` — and copying either
 * alone gives a word or a number with nothing to say what it was.
 */
function lineUnder(target: HTMLElement, card: HTMLElement): string {
  let at: HTMLElement | null = target;
  while (at && at !== card) {
    if (at.tagName === 'DT' || at.tagName === 'DD') {
      const term = at.tagName === 'DT' ? at : previousTerm(at);
      const value = at.tagName === 'DD' ? at : (at.nextElementSibling as HTMLElement | null);
      const pair = [readable(term), readable(value)].filter((part) => part.length > 0);
      if (pair.length > 0) return pair.join(': ');
    }
    const text = readable(at);
    if (text.length > 0 && text.includes(' ')) return text;
    if (text.length > 0 && at !== target) return text;
    at = at.parentElement;
  }
  return readable(target);
}

/**
 * The `<dt>` a `<dd>` belongs to, walking back past its siblings.
 *
 * A `<dl>` row may carry several `<dd>`s for one `<dt>` — the Combat Stats
 * readout states a figure and the average or share beside it that way — so
 * looking only at the immediately previous element found a `<dd>` and copied
 * a bare number with nothing to say what it was, which is the exact failure
 * the pair rule exists to prevent.
 */
function previousTerm(node: HTMLElement): HTMLElement | null {
  let previous = node.previousElementSibling;
  while (previous?.tagName === 'DD') previous = previous.previousElementSibling;
  return previous?.tagName === 'DT' ? (previous as HTMLElement) : null;
}

/**
 * What an element says, as a person reads it.
 *
 * `innerText` and not `textContent`: it honours line breaks and skips what is
 * hidden, so a card with a face switched off does not paste the face nobody was
 * looking at.
 */
export function readable(node: HTMLElement | null): string {
  if (!node) return '';
  return (node.innerText ?? '').replace(/[ \t]+\n/g, '\n').trim();
}
