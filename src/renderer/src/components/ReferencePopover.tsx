import type { SupplyList } from './SupplyControls';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import ReferenceDetail from './ReferenceDetail';
import { entryNumber, entryWord, flattenLookup, type ReferenceEntry } from '../lib/reference';
import EntityNumber from './EntityNumber';
import PopoverHead, { PopoverSizer } from './PopoverHead';
import type { RealmFamily } from '@shared/character';
import { type PopoverAnchor } from '../lib/popover';
import { usePopoverFrame } from '../hooks/usePopoverFrame';
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
  const [entry, setEntry] = useState<ReferenceEntry | null | 'pending'>('pending');
  /*
   * Kept beside the entry, from the same answer: `ClassOk` names a class by row
   * id and the table is the realm's, so the panel would otherwise draw `#12`
   * for a restriction it has been handed the word for.
   */
  const [classNames, setClassNames] = useState<Record<number, string>>({});
  const [shopPlaces, setShopPlaces] = useState<Record<string, ShopPlace>>({});
  /*
   * That the detail has changed size on its own account — a spawn group opened
   * into the rooms behind it.
   *
   * A counter rather than the state itself, because what the placement needs to
   * know is *that* the panel is a different size and the disclosure belongs to
   * the component drawing it. Same job as `face` in the Player flyout's own
   * `measure` list: a panel placed against a short body and then grown is one
   * left hanging off the bottom of the window.
   */
  const [resized, setResized] = useState(0);
  const onResize = useCallback(() => setResized((count) => count + 1), []);
  /*
   * Where it sits, how wide it is, and everything it does to itself — moving,
   * pinning, resizing and the four dismissal listeners. One hook, shared with
   * the two flyouts, because these are one panel drawing three things.
   *
   * `hold` rather than `dismiss` when the anchor leaves the document: this
   * panel often hangs off a *rectangle* in the console, which has no element
   * to disconnect, and where it does hang off a card's name that card redraws
   * on every status line — and a card redrawing is not a reason for a panel to
   * go.
   */
  const frame = usePopoverFrame({
    anchor: asked.anchor,
    measure: [entry, resized],
    onDismiss,
    whenAnchorGone: 'hold'
  });

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

  return createPortal(
    <div
      className="surface popover reference-popover"
      role="dialog"
      aria-label={t('cards.reference.popover.ariaLabel', { name: asked.name })}
      {...frame.props}
    >
      {/*
        The name is the heading, so `ReferenceDetail` does not draw its own —
        two name rows, one of them scrolling away under the other, would say
        the same word twice and only sometimes. The realm's word for what kind
        of thing it is takes the badge slot, where a card's badge goes.

        The *asked* name until the answer arrives, and the realm's spelling
        after: a panel that said `sandals` and then `Sandals of Speed` is
        reporting what the realm actually matched, which is the one thing worth
        knowing when a query is not exact.
      */}
      <PopoverHead
        badge={
          entry !== 'pending' && entry !== null ? (
            <>
              <span className="chip quiet">{entryWord(entry)}</span>
              {/* The realm's own number, where the card's heading carries it
                  too — this panel draws no `reference-name` of its own, so
                  without it the panel a clicked name opens would be the one
                  surface that could not say which row it was about. */}
              <EntityNumber of={entryNumber(entry)} />
            </>
          ) : null
        }
        onClose={onDismiss}
        onGrab={frame.onGrab}
        onPin={frame.togglePin}
        pinned={frame.pinned}
      >
        {entry !== 'pending' && entry !== null ? entry.name : asked.name}
      </PopoverHead>

      <div className="popover-body">
        {entry === 'pending' ? (
          <div className="empty">{t('cards.reference.popover.pending', { name: asked.name })}</div>
        ) : entry === null ? (
          <div className="empty">{t('cards.reference.notFound')}</div>
        ) : (
          <ReferenceDetail
            classNames={classNames}
            entry={entry}
            heading={false}
            level={level}
            onName={onName}
            onResize={onResize}
            onRoom={onRoom}
            realm={realm}
            shopPlaces={shopPlaces}
            supplies={supplies}
          />
        )}
      </div>
      <PopoverSizer onReset={frame.onSizeReset} onSize={frame.onSize} />
    </div>,
    document.body
  );
}
