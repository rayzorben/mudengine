import type { SupplyList } from './SupplyControls';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import ReferenceDetail, { flattenLookup, type ReferenceEntry } from './ReferenceDetail';
import type { RealmFamily } from '@shared/character';
import {
  anchorNode,
  anchorRect,
  placePopover,
  scrollMovesAnchor,
  type PopoverAnchor,
  type PopoverSide
} from '../lib/popover';
import { t } from '../lib/i18n';
import type { ShopPlace, WorldLookup } from '@shared/world';

/**
 * A name somebody clicked, and where: the element on a card, or the box of a
 * word in the console, which has no element of its own — xterm paints cells,
 * so a link there is a rectangle rather than a node.
 */
/**
 * Built fresh per click on purpose: effects key on the object, so the same
 * name clicked twice still re-opens where a bare string would compare equal.
 */
export interface Asked {
  name: string;
  anchor: PopoverAnchor;
}

export interface ReferencePopoverProps {
  asked: Asked;
  /** Asks the character's own realm. Two characters may be on two realms. */
  lookup(query: string): Promise<WorldLookup>;
  level: number | null;
  /**
   * Which engine the character is on. Three ability ids mean different things
   * on GreaterMUD and stock, and the ids above 187 exist on one of them only —
   * see `src/shared/abilities.ts`.
   */
  realm?: RealmFamily | null;
  /**
   * Open the route panel on a room, for a shop in an item's `Sold by` row.
   *
   * It also puts this panel away, which is the two-surface rule rather than a
   * convenience: the route panel is the answer to *how do I get there*, and
   * leaving a popover hanging off the name behind it would be two things open
   * with no way to say which Escape means.
   */
  onRoom?: ((map: number, room: number) => void) | null;
  /**
   * Open the realm's answer about another name, beside the element clicked.
   *
   * Clicking a monster in `Dropped by` **replaces** this panel with one about
   * that monster, which is what the next click on any name already does — so
   * reading through is one panel deep however far it goes, and Escape always
   * means the one thing on screen.
   */
  onName?: ((name: string, anchor: HTMLElement) => void) | null;
  /** This character's supplies list and the write. See `ReferenceDetailProps`. */
  supplies?: SupplyList | null;
  onDismiss(): void;
}

/**
 * What the realm knows about a clicked name, beside the name.
 *
 * Somebody who clicks a sword in their pack wants to read about it and put it
 * away, and a card docked on the rail for that is the wrong shape: it stays,
 * it takes a slot, and it is somewhere else on the screen from the thing that
 * was clicked. This slides out *from* the name — right of it where there is
 * room, else left, below, above, and over it as a last resort (`placePopover`)
 * — and goes away on Escape, on a click anywhere else, or on the next click on
 * a name, which replaces it.
 *
 * In a portal, because the cards that open it scroll and clip. Never focused:
 * it is read, not typed into, and the caret stays with the game — Escape
 * reaches it through a capture listener rather than through focus. The same
 * detail component the Reference card draws, so the two cannot disagree.
 */
export default function ReferencePopover({
  asked,
  lookup,
  level,
  realm = null,
  onRoom = null,
  onName = null,
  onDismiss,
  supplies = null
}: ReferencePopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [entry, setEntry] = useState<ReferenceEntry | null | 'pending'>('pending');
  /*
   * Kept beside the entry, from the same answer: `ClassOk` names a class by row
   * id and the table is the realm's, so the panel would otherwise draw `#12`
   * for a restriction it has been handed the word for.
   */
  const [classNames, setClassNames] = useState<Record<number, string>>({});
  const [shopPlaces, setShopPlaces] = useState<Record<string, ShopPlace>>({});
  const [place, setPlace] = useState<{ top: number; left: number; side: PopoverSide } | null>(null);

  /*
   * The exact name when the realm has it; otherwise the first match, because
   * a clicked name is one specific thing and a list to choose from would be
   * the panel asking a question it was just told the answer to. Nothing at
   * all is a real answer too, and it is said rather than shown as an empty box.
   */
  useEffect(() => {
    let live = true;
    setEntry('pending');
    void lookup(asked.name)
      .then((answer) => {
        if (!live) return;
        const all = flattenLookup(answer);
        const exact = all.find((found) => found.name.toLowerCase() === asked.name.toLowerCase());
        setEntry(exact ?? all[0] ?? null);
        setClassNames(answer.classNames);
        setShopPlaces(answer.shopPlaces ?? {});
      })
      .catch((error: unknown) => {
        if (!live) return;
        // A lookup that failed must still land somewhere: 'pending' for ever
        // is a panel stuck saying "looking…", so it resolves to the same
        // terminal state a genuine not-found reaches.
        setEntry(null);
        console.error(`[reference] lookup for '${asked.name}' failed:`, error);
      });
    return () => {
      live = false;
    };
  }, [asked, lookup]);

  /*
   * Measured before paint from the panel's own size, then placed. The first
   * pass renders it hidden so this is a measurement rather than a guess, the
   * same way `PopupMenu` does — and re-measured when the answer arrives,
   * because an answer is taller than "looking…".
   */
  useLayoutEffect(() => {
    const panel = ref.current?.getBoundingClientRect();
    if (!panel) return;
    if (asked.anchor instanceof HTMLElement && !asked.anchor.isConnected) return;
    setPlace(
      placePopover(
        anchorRect(asked.anchor),
        { width: panel.width, height: panel.height },
        { width: window.innerWidth, height: window.innerHeight }
      )
    );
  }, [asked, entry]);

  useEffect(() => {
    const away = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && ref.current?.contains(target)) return;
      // The name it hangs off is what opened it; a second click there is
      // handled by the opener, which replaces rather than toggles.
      if (target && asked.anchor instanceof HTMLElement && asked.anchor.contains(target)) return;
      onDismiss();
    };
    /*
     * Capture, and the panel owns its own Escape: `useHotkeys` listens in
     * capture too and would otherwise hand a bare Escape to whatever else is
     * open — the diagnostics rail, say — leaving this panel over the game.
     * The terminal keeps focus throughout, so this cannot go through focus.
     */
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    };
    /*
     * A scroll closes the panel only when it moved the name the panel hangs
     * off — `scrollMovesAnchor` has the whole reason. Captured at the window,
     * every scroller in the client reports here, and the loudest of them is
     * the console: a pinned terminal scrolls to the bottom on each write, so
     * dismissing on any scroll took the realm's answer away the moment the
     * game printed anything. The terminal is a different surface and its
     * output is not news here.
     */
    const scrolled = (event: Event): void => {
      if (!scrollMovesAnchor(event.target, anchorNode(asked.anchor))) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    // Anything that moves the anchor closes the panel rather than chasing it.
    window.addEventListener('resize', onDismiss);
    window.addEventListener('scroll', scrolled, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('scroll', scrolled, true);
    };
  }, [asked, onDismiss]);

  return createPortal(
    <div
      className="surface popover reference-popover"
      data-side={place?.side ?? 'right'}
      ref={ref}
      role="dialog"
      aria-label={t('cards.reference.popover.ariaLabel', { name: asked.name })}
      style={{
        top: place?.top ?? 0,
        left: place?.left ?? 0,
        visibility: place === null ? 'hidden' : 'visible'
      }}
    >
      {entry === 'pending' ? (
        <div className="empty">{t('cards.reference.popover.pending', { name: asked.name })}</div>
      ) : entry === null ? (
        <div className="reference-detail">
          <div className="reference-name">{asked.name}</div>
          <div className="empty">{t('cards.reference.notFound')}</div>
        </div>
      ) : (
        <ReferenceDetail
          classNames={classNames}
          entry={entry}
          level={level}
          onName={onName}
          onRoom={onRoom}
          realm={realm}
          shopPlaces={shopPlaces}
          supplies={supplies}
        />
      )}
    </div>,
    document.body
  );
}
