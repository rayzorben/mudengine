/**
 * What the realm knows about a room nobody is standing in, beside the thing
 * that named it.
 *
 * The map has drawn a lair glyph since the realm data was indexed, and the
 * question that glyph raises — *what is in there* — had no answer anywhere:
 * the Room card's `LAIR` face is about the room the character is *in*, and a
 * room on the map is somewhere else by definition. So this is that face, and
 * the rest of the room's facts with it, hanging off whatever named the room —
 * a room on the map, a step on a route list.
 *
 * A panel rather than a card, for the reason the Reference popover is one: it
 * is read and put away, and a card on the rail is somewhere else on the screen
 * from the thing that was pointed at. It shares `usePopoverFrame` with the
 * other three, so it places, moves, pins, resizes and dismisses identically.
 *
 * **Opened by a pointer resting on a room, not by a click.** Reading what is
 * in a lair is the reason to look at the map at all, and a click is already
 * spoken for — it plans the way there. The dwell and the linger are the
 * caller's (`App.tsx`), which owns the one-panel-at-a-time rule.
 *
 * The one action is the walk: it is the thing to do *about* a room, it belongs
 * where the reader has just decided to do it, and it is the affordance the
 * map's bare click used to be.
 */
import { createPortal } from 'react-dom';
import { Fragment, useEffect, useState } from 'react';

import EntityNumber from './EntityNumber';
import LairList from './LairList';
import { shopKindLabel } from './ShopFace';
import PopoverHead, { PopoverSizer } from './PopoverHead';
import { usePopoverFrame } from '../hooks/usePopoverFrame';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { PopoverAnchor } from '../lib/popover';
import type { Alignment } from '@shared/character';
import { errorMessage } from '@shared/values';
import { lightPhrase } from '@shared/light';
import { DIRECTION_NAME, type Direction, type RoomBrief, type RoomId } from '@shared/world';

/**
 * A room somebody pointed at, and where.
 *
 * Built fresh per peek for the reason `Asked` is: effects key on the object,
 * so pointing at the same room twice still re-opens it.
 */
export interface RoomAsked {
  room: RoomId;
  anchor: PopoverAnchor;
  /**
   * Whether somebody clicked the room rather than merely pointing at it.
   *
   * A hovered panel goes when the pointer leaves both it and the room; a
   * settled one stays until it is dismissed like any other, because clicking
   * is how a reader says *keep this*. The linger belongs to the caller, so
   * this is the fact the caller reads.
   */
  settled: boolean;
  /**
   * Whether the thing it hangs off is itself inside a dialog.
   *
   * A scrim exists to dim what is *behind* the dialog, and this panel hangs
   * off a row inside one — so at the popover layer's ordinary height it was
   * drawn under the route panel's own scrim and read as greyed-out. It is in
   * front of the dialog, not behind it, and says so.
   */
  overDialog?: boolean;
  /**
   * What the one action does to this room, and what it is called.
   *
   * The map's is *plan route* — lay the way there out, which is what a room's
   * click used to do on its own. A route list's is *walk here* — walk the plan on
   * screen only as far as this room. Null where there is nothing to offer: a
   * pinned float cannot plan on somebody else's realm, and a control bound to
   * nowhere is worse than none.
   */
  act: { label: string; hint: string; run(): void } | null;
}

export interface RoomQuickViewProps {
  asked: RoomAsked;
  /** Asks the character's own realm. Two characters may be on two realms. */
  load(room: RoomId): Promise<RoomBrief | null>;
  /** How the realm ranks the reader, for the lair's hostility words. */
  mine: Alignment | null;
  onDismiss(): void;
  /**
   * The pointer entered or left the panel, so the caller's linger can be
   * cancelled and restarted. A panel opened by hovering has to be reachable by
   * the hand that opened it.
   */
  onPointerEnter(): void;
  onPointerLeave(): void;
}

export default function RoomQuickView({
  asked,
  load,
  mine,
  onDismiss,
  onPointerEnter,
  onPointerLeave
}: RoomQuickViewProps) {
  const [brief, setBrief] = useState<RoomBrief | null | 'pending'>('pending');

  /*
   * `dismiss` rather than `hold` when the anchor goes: this panel hangs off a
   * room on a picture that is redrawn from a fresh fetch every time the
   * character moves, and a panel left beside a room that is no longer on the
   * map is a panel pointing at nothing.
   */
  const frame = usePopoverFrame({
    anchor: asked.anchor,
    measure: [brief],
    onDismiss,
    whenAnchorGone: 'dismiss'
  });

  useEffect(() => {
    let live = true;
    setBrief('pending');
    void load(asked.room)
      .then((answer) => {
        if (live) setBrief(answer);
      })
      .catch((error: unknown) => {
        // A query that failed still has to land: 'pending' for ever is a panel
        // stuck saying "looking…", so it resolves to the same terminal state a
        // room the realm does not hold reaches.
        if (!live) return;
        setBrief(null);
        console.error(`[room] brief for ${asked.room}: ${errorMessage(error)}`);
      });
    return () => {
      live = false;
    };
  }, [asked, load]);

  const room = brief === 'pending' || brief === null ? null : brief;

  return createPortal(
    <div
      className="surface popover room-peek"
      data-over-dialog={asked.overDialog === true ? 'true' : undefined}
      role="dialog"
      aria-label={t('cards.roomPeek.ariaLabel', { roomName: room?.name ?? asked.room })}
      onPointerEnter={onPointerEnter}
      /*
       * **A panel somebody has taken hold of does not answer the linger.**
       * `settled` is the caller's word for *clicked*, and pinning happens
       * afterwards on a control inside here — so the caller cannot see it, and
       * a hovered panel that was pinned and then left was unmounted 220ms
       * later. Same for a drag: `onGrab` listens at the window, and a hand that
       * outruns the panel fires `pointerleave` on the way.
       *
       * Reported rather than suppressed, because the caller owns the timer:
       * withholding the event is the whole of *this panel is being kept*.
       */
      onPointerLeave={
        frame.pinned || frame.props['data-moving'] === 'true' ? undefined : onPointerLeave
      }
      {...frame.props}
    >
      <PopoverHead
        badge={<span className="chip off">{asked.room}</span>}
        onClose={onDismiss}
        onGrab={frame.onGrab}
        onPin={frame.togglePin}
        pinned={frame.pinned}
      >
        {room?.name ?? t('cards.roomPeek.pendingName')}
      </PopoverHead>

      <div className="popover-body">
        {brief === 'pending' ? (
          <div className="empty">{t('cards.roomPeek.pending')}</div>
        ) : brief === null ? (
          <div className="empty">{t('cards.roomPeek.unknownRoom')}</div>
        ) : (
          <RoomFacts brief={brief} mine={mine} />
        )}
        {/*
         * The one action, below the facts and above nothing: what the reader
         * does *about* a room comes after reading what is in it. The one
         * filled control on the panel, per §3.3 — everything above it reads.
         */}
        {asked.act !== null && (
          <div className="peek-actions">
            <button
              className="primary"
              onClick={asked.act.run}
              onMouseDown={keepFocus}
              title={asked.act.hint}
              type="button"
            >
              {asked.act.label}
            </button>
          </div>
        )}
      </div>
      <PopoverSizer onReset={frame.onSizeReset} onSize={frame.onSize} />
    </div>,
    document.body
  );
}

/**
 * Everything the realm records about the room, in one `.readout`.
 *
 * One `<dl>` per panel and groups as fragments, per the rule that an `auto`
 * track is sized per container: the lair's own rows are `LairList`'s and sit
 * under their own heading, because *what spawns here* is a list of things and
 * the rest of this is one fact per line.
 */
function RoomFacts({ brief, mine }: { brief: RoomBrief; mine: Alignment | null }) {
  const dark = brief.light === undefined ? null : lightPhrase(brief.light);
  /*
   * **One label column for the panel, across two `<dl>`s.** An `auto` track is
   * sized per container, so the room's facts and the lair's monsters would
   * otherwise each measure their own and the two columns would not line up —
   * the rule a card keeps by having exactly one `.readout`. These cannot be
   * one `<dl>`: the lair's rows are `LairList`'s, drawn identically on the Room
   * card's own face. So they get `grid-template-columns: subgrid` on a shared
   * parent, which is the remedy the rule itself names.
   */
  return (
    <div className="peek-facts">
      <dl className="readout">
        {brief.place !== undefined && (
          <>
            <dt>{t('cards.roomPeek.placeLabel')}</dt>
            <dd>
              {brief.place.name}
              <span className="chip quiet">{shopKindLabel(brief.place.kind)}</span>
            </dd>
          </>
        )}
        {brief.npc !== undefined && (
          <>
            <dt>{t('cards.roomPeek.livesHereLabel')}</dt>
            {/* With the realm's own row. `Rooms.NPC` *is* a row number, so
                this is the one monster on the panel whose number is never in
                question — the lair's are `LairList`'s. */}
            <dd className="span">
              {brief.npc.name}
              <EntityNumber of={{ id: brief.npc.id }} />
            </dd>
          </>
        )}
        {/*
         * The realm's own light level, which is a claim the client had and
         * showed nowhere. Said as the phrase the server would print, because
         * −25 and −999 are both dark and only one of them is worth a torch.
         */}
        {dark !== null && (
          <>
            <dt>{t('cards.roomPeek.lightLabel')}</dt>
            <dd className="span">{dark}</dd>
          </>
        )}
        {/*
         * The spell the realm casts on whoever stands here. Written into the
         * realm file since format 13 and read by nothing until now — 13,016
         * of the shipped realm's rooms carry one, and a room that heals you
         * and a room that drowns you are the same column.
         */}
        {brief.spell !== undefined && (
          <>
            <dt>{t('cards.roomPeek.roomSpellLabel')}</dt>
            <dd className="span">
              {brief.spell.name}
              {/* And what it actually does — `river damage` and `inn rest`
                  are the same column, and the name alone does not answer the
                  question the reader is asking. */}
              {brief.hazard !== undefined && (
                <span
                  className={
                    brief.hazard.unread === true || brief.hazard.summons === true
                      ? 'chip warn'
                      : 'chip bad'
                  }
                >
                  {/* Read off the field rather than inferred from the absence
                      of the other two: a spell that only names what stops it
                      would otherwise be reported as moving you. */}
                  {brief.hazard.damage !== undefined
                    ? t('cards.roomPeek.roomSpellDamage', { damage: brief.hazard.damage })
                    : brief.hazard.relocates === true
                      ? t('cards.roomPeek.roomSpellMoves')
                      : brief.hazard.summons === true
                        ? t('cards.roomPeek.roomSpellSummons')
                        : t('cards.route.hazardUnread')}
                </span>
              )}
            </dd>
          </>
        )}
        {/* What stops it. The half that decides what to do: a room that bashes
            you against the rocks is a corridor if you are carrying a boat. */}
        {brief.hazardItems !== undefined && (
          <>
            <dt>{t('cards.roomPeek.roomSpellStoppedBy')}</dt>
            <dd className="span">{brief.hazardItems.map((item) => item.name).join(', ')}</dd>
          </>
        )}
        {/* What the realm furnishes it with and puts back every night —
            format 42. Names, not controls, for the lair's reason below; the
            ones nobody can pick up are drawn quiet, since the raft is the
            thing a reader came for and the sign beside it is scenery. */}
        {brief.placed !== undefined && (
          <>
            <dt title={t('cards.roomPeek.placedHint')}>{t('cards.roomPeek.placedLabel')}</dt>
            <dd className="span">
              {brief.placed.map((item, index) => (
                <Fragment key={item.id}>
                  {index > 0 && ', '}
                  {item.fixed === true ? (
                    <span className="quiet" title={t('cards.room.fixedTitle')}>
                      {item.name}
                    </span>
                  ) : (
                    item.name
                  )}
                  <EntityNumber of={{ id: item.id }} />
                </Fragment>
              ))}
            </dd>
          </>
        )}
        <dt>{t('cards.roomPeek.exitsLabel')}</dt>
        <dd className="span">
          {brief.exits.length === 0 ? (
            <span className="quiet">{t('cards.roomPeek.noExits')}</span>
          ) : (
            /*
             * **One way out is one bounded thing.** Two of one name —
             * `northeast Sandbar northwest Sandbar` — ran together into a
             * sentence, because the only thing between a destination and the
             * next direction was a wider gap than the one inside the pair. So
             * each takes a seam of its own, and the arrow inside says which
             * half is the way and which is where it goes — the `→` the room's
             * own answers already use below. Still wrapping rather than
             * stacking: a column of four short facts is a panel twice as tall
             * as the lair it is above.
             */
            <ul className="peek-exits">
              {brief.exits.map((exit) => (
                <li className="peek-exit" key={exit.direction}>
                  <span className="step-command">
                    {DIRECTION_NAME[exit.direction as Direction] ?? exit.direction}
                  </span>
                  <span aria-hidden="true" className="peek-exit-arrow">
                    →
                  </span>
                  <span className="peek-exit-to">{exit.name ?? exit.to}</span>
                  {exit.obstacle !== undefined && (
                    <span className="chip warn" title={exit.obstacle.detail}>
                      {exit.obstacle.label}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
      {/*
       * What spawns here, in the words the Room card's own face uses, because
       * it is the same readout. `inspect` is deliberately absent: this panel
       * is already one panel deep and opening the realm's answer about a
       * monster would replace it with something that cannot get back.
       */}
      {brief.lair !== undefined && (
        <>
          <h3 className="peek-heading">{t('cards.room.tabs.lair')}</h3>
          <LairList lair={brief.lair} mine={mine} />
        </>
      )}
      {/*
       * The words the room answers to — a portal, a lever, a phrase that takes
       * you somewhere the exit table does not. Their phrases only: what each
       * one wants is the Room card's own face, and this is a glance.
       */}
      {brief.commands !== undefined && (
        <>
          <h3 className="peek-heading">{t('cards.roomPeek.answersHeading')}</h3>
          <ul className="peek-answers">
            {brief.commands.map((answer, index) => (
              // The realm repeats a phrase across two commands in one room, so
              // the place in the list is the key — `keyOf`'s own rule.
              <li key={`${answer.say[0] ?? ''}-${index}`}>
                <span className="step-command">{answer.say[0]}</span>
                {answer.to !== undefined && <span className="quiet"> → {answer.to}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
