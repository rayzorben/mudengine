/**
 * What a fact arriving for a character is worth saying: the live thresholds,
 * the player's own alert rows, and when each row last fired.
 *
 * Out of `App` (todo 731). `useSessionViews` folds every fact through the port
 * this returns, inside the patch that has the previous state in hand; what is
 * worth saying *outside* the window is read afterwards from the log that
 * landed (`useDesktopAlerts`). See `mudengine-ui` › *The window redraws what
 * changed*.
 */
import { useRef, useState } from 'react';

import { t } from '../lib/i18n';
import type { Block } from '@shared/blocks';
import type { CharacterState } from '@shared/character';
import type { AlertsUiConfig, VitalsUiConfig } from '@shared/config';
import type { SessionId } from '@shared/ipc';
import type { LoopProgress } from '@shared/loops';
import {
  alertQuiet,
  linkNotices,
  namedNotices,
  noticeFor,
  partyNotices,
  roomNotices,
  rosterNotices,
  vitalNotices,
  walkNotices,
  wanted,
  watchNotices,
  type AlertQuiet,
  type Notice
} from '@shared/notifications';
import type { ConnectionState } from '@shared/types';
import type { WalkProgress } from '@shared/walk';

/**
 * What one fact raises for one character, as the player's rows let it through
 * (`wanted`), each row's quiet clock stamped as it fires. Identity-stable, so a
 * subscription registered once for the window's lifetime can hold it.
 */
export interface AlertRaiser {
  /** The link, from what it was to what it is. */
  link(id: SessionId, was: ConnectionState, now: ConnectionState): Notice[];
  /** A status line, from the character before it to the character after. */
  character(id: SessionId, was: CharacterState, now: CharacterState): Notice[];
  /** The walk, with the lap it may be the footwork of. */
  walk(id: SessionId, was: WalkProgress, now: WalkProgress, loop: LoopProgress): Notice[];
  /** A block, read against the character it happened to. */
  block(id: SessionId, block: Block, character: CharacterState): Notice[];
}

export function useAlerts(vitals: VitalsUiConfig, alerts: AlertsUiConfig): AlertRaiser {
  /*
   * The live thresholds, readable from a subscription registered once.
   *
   * The block and character subscriptions are set up for the window's lifetime
   * and must not be torn down and rebuilt every time the options file is saved
   * — a resubscribe drops whatever arrives in the gap. A ref lets the handler
   * read the current value without becoming a dependency of it.
   */
  const vitalsRef = useRef(vitals);
  vitalsRef.current = vitals;
  /*
   * What this character wants to be alerted about, read the same way and for
   * the same reason: the subscriptions are registered once for the window's
   * lifetime and must not be torn down every time the options file is saved.
   */
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;
  /*
   * When each character's alert rows last fired, so a row can stay quiet for
   * a while afterwards (todo 03).
   *
   * A ref rather than state: nothing is drawn from it, it changes on every
   * notice, and re-rendering the client because a row's clock moved is the
   * churn the renderer measurements exist to keep out. One map per character,
   * made on first use, keyed by the row's place in the list so two rows on one
   * event keep separate clocks.
   *
   * Never pruned, and it does not need to be: it holds one entry per row that
   * has fired, per character this window has seen, which is bounded by the
   * character list and is a handful of numbers.
   */
  const quietRef = useRef(new Map<string, AlertQuiet>());

  /*
   * Built once, on state's initialiser rather than a memo, because a memo is a
   * cache React may drop and the views' subscriptions hold this for the
   * window's lifetime; everything live is read through the refs above.
   */
  const [raiser] = useState<AlertRaiser>(() => {
    const quietFor = (id: string): AlertQuiet => {
      const had = quietRef.current.get(id);
      if (had) return had;
      const fresh = alertQuiet();
      quietRef.current.set(id, fresh);
      return fresh;
    };
    const worth = (id: SessionId, notices: readonly (Notice | null)[]): Notice[] =>
      wanted(alertsRef.current, notices, quietFor(id));
    return {
      /*
       * A character that has left the realm without anybody here asking: the
       * link dropped, or the low-health hang-up acted for a player who was not
       * there. `endedBy` is the fact, decided in main, because the alternative
       * is comparing a translated sentence.
       */
      link: (id, was, now) => worth(id, linkNotices(was, now, Date.now(), t)),
      /*
       * The one genuinely urgent thing in a MUD is a number, and the server
       * never announces it — it prints a smaller figure in a status line that
       * has printed a hundred already. So the alert comes from the *crossing*,
       * which needs the previous state, which is exactly what a patch has in
       * hand.
       */
      character: (id, was, now) =>
        worth(id, [
          ...vitalNotices(was, now, vitalsRef.current, t),
          // And the player's own numeric watches, on their own figures and in
          // their own direction (todo 29). Beside the client's three levels
          // rather than inside them: *above 80% mana* is a thing somebody
          // wants and a level cannot say.
          ...watchNotices(was, now, alertsRef.current.rules, t),
          // And the named ones: an item or a person the player is waiting
          // for, wherever it turned up.
          ...namedNotices(was, now, alertsRef.current.rules, t),
          // Who is in the realm is the other thing that arrives as a state
          // change rather than as a line worth alerting on: an arrival is a
          // name, and what the realm thinks of them lands with the next
          // listing. Both moments are worth reporting and they are not the
          // same moment.
          ...rosterNotices(was, now, t),
          // A hostile in the *room* is not the same fact as one in the realm,
          // and it is raised from the room because the line that says
          // somebody walked in does not say what they are.
          ...roomNotices(was, now, t),
          /*
           * And somebody in the party in trouble, which is the reason the
           * roster matters: three of four characters are unattended, and the
           * one being watched is not usually the one that is dying.
           */
          ...partyNotices(was, now, vitalsRef.current.hp, t)
        ]),
      // The route reaching where it was going: the one piece of good news
      // kept, because it is the moment somebody who walked away wants. The lap
      // is handed in because a lap never arrives: while it is the movement,
      // the walk underneath is its own footwork.
      walk: (id, was, now, loop) => worth(id, walkNotices(was, now, loop, Date.now(), t)),
      block: (id, block, character) => worth(id, [noticeFor(block, t, character)])
    };
  });
  return raiser;
}
