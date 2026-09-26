/**
 * Which card is drawn, and from what: the rail's gates (the diagnostics
 * group, the HUD) over `cardElement`, for
 * the shown character's lanes and floats and for another character's pinned
 * floats.
 *
 * Out of `App` (todo 733). See `mudengine-ui` › *The window redraws what
 * changed*: every slice a card reads through `view` is a dependency.
 */
import { useCallback, useMemo, type ReactNode } from 'react';

import { cardElement } from '../components/CardSwitch';
import type { CardChromes } from './useCardChrome';
import type { CardDrag } from './useCardDrag';
import type { CardContexts } from './useCardContext';
import { EMPTY_VIEW, type SessionView } from './useSessionViews';
import { isDiagnosticCard, type CardId, type CardLayoutApi } from '../lib/cards';
import type { SessionId } from '@shared/ipc';

export interface CardRendererInputs {
  /** The shown character's arrangement. */
  cards: Pick<CardLayoutApi, 'floatOf'>;
  /**
   * The drag machine: read by the chrome through a ref, and a dependency
   * here so a drag starting or ending redraws the card it moves.
   */
  drag: CardDrag;
  railOpen: boolean;
  hudOpen: boolean;
  /** The character on screen, and its view. */
  session: SessionId;
  view: SessionView;
  /** Every character's view, for a pinned float's. */
  views: Readonly<Record<SessionId, SessionView>>;
  contextFor: CardContexts['contextFor'];
  chromeFor: CardChromes['chromeFor'];
  pinnedChrome: CardChromes['pinnedChrome'];
}

/** One character's pinned floats, drawn from that character's view. */
export type PinnedRenderer = (id: CardId, layout: CardLayoutApi) => ReactNode;

export interface CardRenderers {
  renderCard(id: CardId): ReactNode;
  /**
   * The same function for as long as that character's view, and the context
   * it draws from, are (todo 761).
   */
  pinnedFor(sid: SessionId): PinnedRenderer;
}

export function useCardRenderers({
  cards,
  drag,
  railOpen,
  hudOpen,
  session,
  view,
  views,
  contextFor,
  chromeFor,
  pinnedChrome
}: CardRendererInputs): CardRenderers {
  const { automation, character, lines, state, walk } = view;
  const telnetEvents = view.telnet;

  /**
   * One card, wherever it is.
   *
   * The rail and the float layer render from the same function on purpose:
   * dragging a card out of the rail must not change what it *is*, and two
   * copies of this switch would drift the moment one of them gained a prop.
   * The chrome — close, drag handle, translucency — is assembled here too, so
   * every card gets the same set without listing it eleven times.
   *
   * Returns `null` for a card its group has hidden. A card is **not** taken
   * away when the character leaves the realm: it keeps its place and the last
   * true things it said, and the standby card says why nothing is moving.
   */
  const renderCard = useCallback(
    (id: CardId): ReactNode => {
      // Diagnostics are still a group, toggled together by the rail shortcut.
      // A card the player has *floated* is exempt: lifting it off the rail is
      // an explicit request to keep it in view.
      const floating = cards.floatOf(id);
      const diagnostic = isDiagnosticCard(id);
      if (diagnostic && !railOpen && !floating) return null;
      if (!diagnostic && !hudOpen && !floating) return null;

      return cardElement(id, contextFor(session, view, chromeFor(id)));
    },
    /*
     * `view`'s consumed fields are enumerated rather than the object listed,
     * so a push that only touches bookkeeping does not rebuild every card.
     */
    [
      automation,
      cards,
      character,
      chromeFor,
      contextFor,
      drag,
      hudOpen,
      lines,
      railOpen,
      session,
      state,
      telnetEvents,
      // Every slice a card reads through `view` (`cardElement`), each of which
      // can arrive in a push of its own: the registry by design (todo 730),
      // the rest whenever their push lands without a status line beside it.
      view.asks,
      view.finds,
      view.learned,
      // The Navigation card reads loop progress through `view`, so it is a
      // real dependency — omitted, the card kept a stale closure whenever a
      // loop push landed in a render where nothing else here moved. Same
      // defect the `commands` memo had with `view.loop.status`.
      view.loop,
      view.notices,
      view.players,
      view.questRun,
      view.questSaid,
      view.statsBase,
      view.talk,
      view.verdict,
      walk
    ]
  );

  /**
   * A pinned float belonging to a character that is *not* shown.
   *
   * Every callback is bound to that character, never to the shown one: a
   * Talk card pinned from the healer sends as the healer. What it cannot do
   * is be dragged by its header — the drag machine belongs to the shown
   * character's rail — so it moves once that character is shown.
   */
  const renderPinned = useCallback(
    (id: CardId, sid: SessionId, v: SessionView, layout: CardLayoutApi): ReactNode => {
      const floating = layout.floatOf(id);
      if (!floating) return null;
      return cardElement(id, contextFor(sid, v, pinnedChrome(id, layout, floating)));
    },
    [contextFor, pinnedChrome]
  );

  /*
   * Bound per character and kept per view, so a memoised `PinnedFloats` is
   * drawn again when its own character's view moves, not when any does: a
   * push lands in `views` whole, and listing it redrew every pinned float on
   * every status line of every character (todo 761). Weak on the view, so a
   * replaced view takes its binding with it.
   */
  const bound = useMemo(
    () => new WeakMap<SessionView, Map<SessionId, PinnedRenderer>>(),
    [renderPinned]
  );
  const pinnedFor = useCallback(
    (sid: SessionId): PinnedRenderer => {
      const v = views[sid] ?? EMPTY_VIEW;
      // By id as well as by view: every character not yet heard from shares `EMPTY_VIEW`.
      const byId = bound.get(v) ?? new Map<SessionId, PinnedRenderer>();
      bound.set(v, byId);
      const held = byId.get(sid);
      if (held) return held;
      const render: PinnedRenderer = (id, layout) => renderPinned(id, sid, v, layout);
      byId.set(sid, render);
      return render;
    },
    [bound, renderPinned, views]
  );

  return { renderCard, pinnedFor };
}
