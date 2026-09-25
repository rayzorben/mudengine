/**
 * The panels that hang off a name, drawn from the one slot `useSlideOuts`
 * keeps: at most one of the realm's answer about a name, the room quick view,
 * the Player flyout and the Gang flyout.
 *
 * Out of `App` (todo 732). The flyouts are addressed at the character whose
 * listing was clicked, the other two at the character on screen. See
 * `mudengine-ui` › *A listing and the detail chosen from it: two cards, and a
 * flyout*.
 */
import { useCallback } from 'react';

import GangFlyout from './GangFlyout';
import { ownAlignment } from './LairList';
import PlayerFlyout from './PlayerFlyout';
import ReferencePopover, { type ReferencePopoverProps } from './ReferencePopover';
import RoomQuickView, { type RoomQuickViewProps } from './RoomQuickView';
import { EMPTY_VIEW, type SessionView } from '../hooks/useSessionViews';
import type { SlideOutSlot } from '../hooks/useSlideOuts';
import { t } from '../lib/i18n';
import type { CharacterState } from '@shared/character';
import type { RemotesConfig } from '@shared/config';
import type { IpcApi, SessionId } from '@shared/ipc';
import type { RemoteName } from '@shared/remotes';

export interface SlideOutsProps {
  /** The slot, less the openers a map calls: drawing and dismissing is all this does. */
  slot: Omit<SlideOutSlot, 'peekRoom' | 'peekPlanned'>;
  /** Every character's facts, for a flyout addressed at one of them. */
  views: Readonly<Record<SessionId, SessionView>>;
  /** The character on screen, whose realm the reference and the quick view ask. */
  character: CharacterState;
  lookup: ReferencePopoverProps['lookup'];
  loadRoomBrief: RoomQuickViewProps['load'];
  supplies: ReferencePopoverProps['supplies'];
  /** The route panel on a room: a shop in *Sold by* opens it. */
  chooseOnMap(map: number, room: number): void;
  /** One character's resolved `automation.remotes`. */
  remotesFor(session: SessionId): RemotesConfig;
  api: Pick<IpcApi, 'askRemote' | 'setRemoteGrant'>;
  /** A sentence into one character's console. */
  say(session: SessionId, message: string): void;
  returnFocus(): void;
}

export default function SlideOuts({
  slot,
  views,
  character,
  lookup,
  loadRoomBrief,
  supplies,
  chooseOnMap,
  remotesFor,
  api,
  say,
  returnFocus
}: SlideOutsProps) {
  const { asked, flyout, gangFlyout, peek, dismissAsked } = slot;

  /**
   * One of the three questions put to a player, from the flyout hanging off
   * their name.
   *
   * Addressed at the character whose listing was clicked, not the shown one —
   * `PlayerAsked.session`, the rule every other control on that panel follows,
   * and the reason a pinned float can carry it at all. The refusal lands in
   * *that* character's console for the same reason the lap's does: a sentence
   * about a character belongs in front of the character it is about.
   *
   * This was three palette commands per person (todo 04): with a realm's
   * roster loaded, a hundred rows of *Ask X for their Y* stood between the
   * palette's own filter and every other command in the client. The palette
   * lists commands; who to ask is an argument, and an argument belongs beside
   * its subject.
   */
  const askPlayer = useCallback(
    (name: string, remote: RemoteName) => {
      const sid = flyout?.session ?? null;
      if (sid === null) return;
      void api.askRemote(sid, name, remote).then((sent) => {
        if (!sent) say(sid, t('cards.player.ask.refused', { name }));
      });
    },
    [api, flyout, say]
  );

  return (
    <>
      {/*
        What the realm knows about a clicked name, beside the name. One at a
        time; the next click replaces it, Escape or a click elsewhere closes it.
      */}
      {asked !== null && (
        <ReferencePopover
          asked={asked}
          level={character.progress.level}
          lookup={lookup}
          onDismiss={dismissAsked}
          /*
            A shop in `Sold by` opens the route panel, and this panel goes with
            it: one thing open at a time is the rule both slide-outs already
            keep, and two panels hanging off one click is two things to put
            away with no way to say which Escape means.
          */
          onName={slot.inspect}
          onRoom={(map, room) => {
            dismissAsked();
            chooseOnMap(map, room);
          }}
          realm={character.realm}
          supplies={supplies}
        />
      )}

      {/*
        What the realm knows about a room nobody is standing in, beside the
        room. Opened by a pointer resting on a room on the map; the way there
        is a button on it, which is the affordance the room's bare click used
        to be.
      */}
      {peek !== null && (
        <RoomQuickView
          asked={peek}
          load={loadRoomBrief}
          mine={ownAlignment(character)}
          onDismiss={slot.dismissPeek}
          onPointerEnter={slot.holdPeek}
          onPointerLeave={slot.endPeek}
        />
      )}

      {/*
        One other person, beside the listing they were clicked on. Drawn from the
        clicked character's own registry and permissions, which is why it takes a
        session rather than reading the shown character's.
      */}
      {flyout !== null && (
        <PlayerFlyout
          asked={flyout}
          character={(views[flyout.session] ?? EMPTY_VIEW).character}
          players={(views[flyout.session] ?? EMPTY_VIEW).players}
          inspect={slot.inspect}
          onAsk={askPlayer}
          onDismiss={slot.dismissFlyout}
          onGrant={(name, grant) => void api.setRemoteGrant(flyout.session, name, grant)}
          onSelectGang={(gang, anchor) => slot.selectGang(flyout.session, gang, anchor)}
          remotes={remotesFor(flyout.session)}
          returnFocus={returnFocus}
        />
      )}

      {/*
        One gang, beside wherever its name was clicked, and read out of the same
        character's roster and registry. Every member's name is itself a control
        that opens the panel above on them: an entity carries through.
      */}
      {gangFlyout !== null && (
        <GangFlyout
          asked={gangFlyout}
          character={(views[gangFlyout.session] ?? EMPTY_VIEW).character}
          players={(views[gangFlyout.session] ?? EMPTY_VIEW).players}
          onDismiss={slot.dismissGangFlyout}
          onSelectPlayer={slot.selectPlayer}
          returnFocus={returnFocus}
        />
      )}
    </>
  );
}
