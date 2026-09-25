/**
 * The panels that hang off a name, one at a time: the realm's answer about a
 * name, the Player flyout, the Gang flyout and the room quick view, with the
 * quick view's dwell and linger.
 *
 * Out of `App` (todo 732) with the state it owns; `SlideOuts` draws them. Each
 * panel hands the caret back itself. See `mudengine-ui` › *A listing and the
 * detail chosen from it: two cards, and a flyout*.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { GangAsked } from '../components/GangFlyout';
import type { PlayerAsked } from '../components/PlayerFlyout';
import type { Asked } from '../components/ReferencePopover';
import type { RoomAsked } from '../components/RoomQuickView';
import { t } from '../lib/i18n';
import type { PopoverAnchor } from '../lib/popover';
import { tuning } from '../lib/tuning';
import type { SessionId } from '@shared/ipc';
import { asRoomReference, type RoomId } from '@shared/world';

export interface SlideOutSlot {
  /** The name last clicked, and where, so the answer can open beside it. */
  asked: Asked | null;
  /**
   * The Player flyout: whose it is about, which character's listing it was
   * opened from, and where on screen.
   */
  flyout: PlayerAsked | null;
  gangFlyout: GangAsked | null;
  /** The room quick view: which room, where it hangs, whether a click nailed it. */
  peek: RoomAsked | null;
  /** A name clicked, on a card or in the console, asking what the realm knows. */
  inspect(name: string, anchor: PopoverAnchor): void;
  dismissAsked(): void;
  selectPlayer(session: SessionId, name: string, anchor: PopoverAnchor): void;
  dismissFlyout(): void;
  selectGang(session: SessionId, name: string, anchor: PopoverAnchor): void;
  dismissGangFlyout(): void;
  /** A room on a map pointed at or clicked. */
  peekRoom(room: RoomId, at: SVGGElement, settled: boolean): void;
  /** A room on a plan pointed at or clicked, with the plan's own *walk here*. */
  peekPlanned(room: RoomId, at: Element, settled: boolean, walkHere: (() => void) | null): void;
  /** The pointer reached the panel: it is being read, so it stays. */
  holdPeek(): void;
  /** The pointer left the room, or the panel. */
  endPeek(): void;
  dismissPeek(): void;
}

/**
 * Where a room's quick view hangs, from whatever named the room.
 *
 * A row of the route list is an `HTMLElement` and anchors as itself. A room on
 * a map is an SVG group, and `PopoverAnchor`'s element half is an
 * `HTMLElement` for the placement arithmetic it does — so it anchors as a box
 * and the element it was measured in, the same shape a word in the console
 * takes and for the same reason: xterm paints cells, and neither has an
 * `HTMLElement` of its own. `within` is the window the picture is drawn in —
 * one selector, because every map in the client is drawn in a `MapView` — so a
 * scroll of what is underneath it dismisses and a scroll of anything else does
 * not. A route list's own row is an `HTMLElement` and never reaches here.
 */
function roomAnchor(at: Element): PopoverAnchor {
  if (at instanceof HTMLElement) return at;
  const within = at.closest('.map-view');
  return {
    box: at.getBoundingClientRect(),
    within: within instanceof HTMLElement ? within : document.body
  };
}

/**
 * @param session The character on screen: the quick view is opened from its
 *   map, so switching is the dismissal.
 * @param chooseOnMap The route panel on a room, the quick view's *plan route*.
 */
export function useSlideOuts(
  session: SessionId,
  chooseOnMap: (map: number, room: number) => void
): SlideOutSlot {
  const [asked, setAsked] = useState<Asked | null>(null);
  /*
   * One at a time, like the reference slide-out, and **not** remembered
   * across launches, unlike a card's filters: a filter is a standing choice
   * and is remembered, a find is a question being asked right now and is not —
   * and a clicked name is a find. The registry it names dies with the session
   * anyway (`src/shared/players.ts`), so a stored name would point at nobody
   * on every launch.
   */
  const [flyout, setFlyout] = useState<PlayerAsked | null>(null);
  /*
   * The Gang flyout, on the same terms as the Player one and mutually exclusive
   * with it: a gang's panel is clicked *through* to a person's, and two panels
   * hanging off two names is two things to put away and no way to say which
   * Escape means.
   */
  const [gangFlyout, setGangFlyout] = useState<GangAsked | null>(null);
  /*
   * The fourth panel, on the same one-at-a-time terms as the other three. What
   * is different is how it opens: a pointer resting on a room rather than a
   * click on a name, so it also carries `settled` — a hovered panel goes when
   * the pointer leaves it and the room, and a clicked one stays until it is
   * dismissed like any other.
   */
  const [peek, setPeek] = useState<RoomAsked | null>(null);
  /** The linger: the pointer has left, and the panel goes unless it comes back. */
  const linger = useRef<number | undefined>(undefined);

  const holdPeek = useCallback(() => window.clearTimeout(linger.current), []);
  const dismissPeek = useCallback(() => {
    window.clearTimeout(linger.current);
    setPeek(null);
  }, []);
  useEffect(() => () => window.clearTimeout(linger.current), []);
  /*
   * And it goes when the character does. The panel hangs off the map, which
   * stays on screen through a tab switch — so a room read on one character's
   * realm would have been redrawn from the *next* character's, under the same
   * `map/room` badge and possibly a different world entirely. Every other
   * panel is addressed at the session it was opened from; this one is opened
   * from the shown character's map, so switching is the dismissal.
   */
  useEffect(() => dismissPeek(), [session, dismissPeek]);

  /*
   * A name clicked on a card, or in the console, asking what the realm knows
   * about it.
   *
   * Opens a slide-out beside the name rather than a card on the rail: the
   * person wants to read and put it away, and a card somewhere else on the
   * screen is the wrong shape for that. Stamped so the same name clicked
   * twice still lands; the second click replaces the first panel. The
   * console has no element to anchor to — xterm paints cells — so it hands up
   * the box of the cells instead.
   */
  const inspect = useCallback(
    (name: string, anchor: PopoverAnchor) => {
      setFlyout(null);
      setGangFlyout(null);
      dismissPeek();
      setAsked({ name, anchor });
    },
    [dismissPeek]
  );
  const dismissAsked = useCallback(() => setAsked(null), []);

  /*
   * A name clicked on a listing: open the Player flyout on that person, beside
   * the listing that was clicked.
   *
   * Addressed at the character whose card was clicked rather than at the shown
   * one, because a pinned float belongs to somebody else — the flyout reads
   * *that* character's registry and writes *that* character's permissions.
   * One slide-out at a time: opening this puts away the realm's answer about
   * an item, and vice versa, because two panels hanging off two names is two
   * things to put away and no way to tell which Escape means.
   */
  const selectPlayer = useCallback(
    (sid: SessionId, name: string, anchor: PopoverAnchor) => {
      setAsked(null);
      setGangFlyout(null);
      dismissPeek();
      setFlyout({ session: sid, name, anchor });
    },
    [dismissPeek]
  );
  const dismissFlyout = useCallback(() => setFlyout(null), []);

  /*
   * A gang clicked — in the console, or on the person whose gang it is.
   *
   * A gang is an entity like a person or an item: it is printed in the `who`
   * listing's own column, and it was the one recognisable thing on that line
   * that opened nothing. Addressed at the character whose surface was clicked,
   * because the membership is read out of *that* character's roster and
   * registry, and a pinned float belongs to somebody else.
   */
  const selectGang = useCallback(
    (sid: SessionId, name: string, anchor: PopoverAnchor) => {
      setAsked(null);
      setFlyout(null);
      dismissPeek();
      setGangFlyout({ session: sid, name, anchor });
    },
    [dismissPeek]
  );
  const dismissGangFlyout = useCallback(() => setGangFlyout(null), []);

  /*
   * The map's one action on a room: plan the way there, which is what a
   * room's bare click used to do on its own. One definition, because the Map
   * card and the route panel's map are the same picture and a reader who has
   * learnt the button on one has learnt it on the other.
   */
  const walkTo = useCallback(
    (room: RoomId): RoomAsked['act'] => ({
      label: t('cards.roomPeek.walkToButton'),
      hint: t('cards.roomPeek.walkToTooltip'),
      run: () => {
        const to = asRoomReference(room);
        setPeek(null);
        if (to !== null) chooseOnMap(to.map, to.room);
      }
    }),
    [chooseOnMap]
  );
  /*
   * Put the room's panel up, whoever asked for it.
   *
   * **One panel at a time, like the other three**: opening this puts away the
   * realm's answer about an item, a person or a gang. Written once because
   * three surfaces open it — the map, the route panel, the loop builder — and
   * a fourth that forgot to put the flyout away would be two panels on screen
   * claiming the one slot.
   *
   * What differs between them is the *action* on the panel and nothing else,
   * so that is all each caller decides.
   */
  const openPeek = useCallback((next: RoomAsked) => {
    window.clearTimeout(linger.current);
    setAsked(null);
    setFlyout(null);
    setGangFlyout(null);
    setPeek(next);
  }, []);
  /*
   * A pointer came to rest on a room of a map, or clicked one: open the
   * realm's answer about it beside the room.
   *
   * The map has drawn a lair glyph since the realm data was indexed and
   * nothing could say what was in it — the Room card's face is about the room
   * the character is *standing in*. This is that face for a room on the map,
   * and the way there is a button on it rather than the room's bare click,
   * which used to send a character somewhere on one mis-click.
   *
   * **The Map card's, the loop builder's, one panel with one button** (todo
   * 2026-09-14). The builder's was given `act: null` first, on the argument
   * that a click there is a pick and *Plan route* opens a dialog over the float
   * being drawn on. That was wrong twice over: it left the builder's rooms
   * with the way-there offered nowhere at all — the `<title>` still said
   * *Route to …*, which is the affordance a button is supposed to be — and a
   * panel that is the same panel everywhere except for its one control is two
   * panels. Parity is the rule; the surface decides what a **click** means and
   * nothing else.
   */
  const peekRoom = useCallback(
    (room: RoomId, at: SVGGElement, settled: boolean) => {
      openPeek({ room, anchor: roomAnchor(at), settled, act: walkTo(room) });
    },
    [openPeek, walkTo]
  );
  /*
   * The pointer left the room, or the panel. A hovered panel goes after the
   * linger; a settled one — one somebody clicked — stays, because they said so.
   *
   * The linger exists because the panel is a thing to *read*: one that vanished
   * while the hand was travelling the twenty pixels towards it would be
   * unreachable by pointer.
   */
  const endPeek = useCallback(() => {
    window.clearTimeout(linger.current);
    linger.current = window.setTimeout(
      () => setPeek((open) => (open === null || open.settled ? open : null)),
      tuning().roomPeekLingerMs
    );
  }, []);
  /*
   * A room on a plan pointed at or clicked — a row of the route list, or a
   * room on the panel's own map, which is the Map card's picture drawn under
   * the head. The same panel, with the route list's own action where the room
   * is a step of the plan: *walk here* — the plan is already on screen, and
   * stopping short at a room is what picking one of its steps already means.
   * A neighbour the plan does not pass through gets the map's *plan route*,
   * which re-plans by name, in the open, rather than nothing: the picture is
   * there to be read, and a room on it that answers for itself but cannot be
   * gone to would be the one room on the screen that is.
   *
   * A row is hovered rather than clicked, so it does not take the click the
   * row uses to pick a step; the panel therefore goes on the linger like the
   * map's does. A room on the map settles on a click, as it does on the card.
   */
  const peekPlanned = useCallback(
    (room: RoomId, at: Element, settled: boolean, walkHere: (() => void) | null) => {
      openPeek({
        room,
        anchor: roomAnchor(at),
        settled,
        // It hangs off something inside the route panel, so it is in front of
        // that panel's scrim rather than behind it. See `RoomAsked.overDialog`.
        overDialog: true,
        act:
          walkHere === null
            ? walkTo(room)
            : {
                label: t('cards.roomPeek.walkHereButton'),
                hint: t('cards.roomPeek.walkHereTooltip'),
                run: () => {
                  setPeek(null);
                  walkHere();
                }
              }
      });
    },
    [openPeek, walkTo]
  );

  return {
    asked,
    flyout,
    gangFlyout,
    peek,
    inspect,
    dismissAsked,
    selectPlayer,
    dismissFlyout,
    selectGang,
    dismissGangFlyout,
    peekRoom,
    peekPlanned,
    holdPeek,
    endPeek,
    dismissPeek
  };
}
