/**
 * The alerts worth interrupting somebody who is not looking at the window.
 *
 * The Alerts card is the second reading of the stream, for a player watching
 * it. This is the third, for the state a MUD client spends most of an evening
 * in: minimised behind something else, because the whole point of automating a
 * character is being able to go and do something else while it plays.
 *
 * Four rules hold it to what it is for. It raises only what one of the
 * player's own alert rows claimed and marked `notify`; it raises nothing while
 * the window has the focus unless that row says otherwise (or the arrival is
 * one the player stopped short to wait at), because whatever it would say is
 * already on screen and a notification for that is why people turn
 * notifications off; it raises
 * **one** per character per flush, the newest, because four monsters arriving
 * is one thing that happened and four notifications is a stack somebody has to
 * dismiss; and each kind then rests for `tuning.desktopAlertGapMs` before it
 * may speak again about that character and that thing (`Notice.about`),
 * because being attacked is a fresh line several times a round. An arrival the
 * gap or a newer alert held back is said in the console (`lib/desktopPick.ts`).
 *
 * Reading the log rather than the raising: notices are folded into each
 * character's view inside a state updater, which React may run twice, and a
 * notification is a side effect that must happen exactly once. So this watches
 * what actually landed — after the commit, keyed on the notice's own id, which
 * is stable within a session.
 */
import { useEffect, useRef } from 'react';

import { t } from '../lib/i18n';
import { pickDesktopAlert, type DesktopHold } from '../lib/desktopPick';
import { freshNotices } from '../lib/freshNotices';
import { tuning } from '../lib/tuning';
import type { AutomationSnapshot } from '@shared/automation';
import type { AlertRule, Notice } from '@shared/notifications';
import type { SessionId } from '@shared/ipc';

/**
 * The part of a character's view this reads, so the views themselves are
 * handed over (`useSessionViews`) rather than a copy reshaped per flush.
 */
export interface AlertSubject {
  /** The character's alerts, oldest first, as `useSessionViews` keeps them. */
  notices: Notice[];
  /** Whose they are, for the notification's title. Null before the realm says. */
  character: { name: string | null };
  /** Whether nobody is at that character's keyboard, for a row's `onlyAway` (todo 79). */
  automation: Pick<AutomationSnapshot, 'away'>;
}

export interface DesktopAlertsOptions {
  /** Every character this window is drawing, by session id. */
  subjects: Readonly<Record<SessionId, AlertSubject>>;
  /**
   * The player's own alert rows, and the only thing that decides this
   * (2026-09-13). A row claiming a notice and marked `notify` raises it; its
   * own `whileFocused` says whether that holds while the window is in front.
   * `ui.alerts.desktop` was two switches asking the same two questions.
   */
  rules: readonly AlertRule[];
  /** Bring this window forward, then show the character the notice was about. */
  onOpen(session: SessionId): void;
  /**
   * Somewhere to say a thing in the console: that nothing can be raised at all
   * (no character, at most once), or in that character's console why an
   * arrival was not raised (todo 157).
   */
  say(message: string, session?: SessionId): void;
}

/** The sentence for each rule that holds a notification back. */
function heldSentence(why: DesktopHold, text: string): string {
  switch (why) {
    case 'gap':
      return t('notices.desktopAlerts.held.gap', {
        text,
        seconds: Math.round(tuning().desktopAlertGapMs / 1000)
      });
    case 'newer':
      return t('notices.desktopAlerts.held.newer', { text });
    default: {
      const never: never = why;
      return never;
    }
  }
}

/**
 * What the browser can do about a notification, as three answers rather than
 * two: a tab that has not been asked yet is not the same as one that said no,
 * and only one of them is worth reporting.
 */
type Standing = 'ready' | 'asking' | 'refused' | 'absent';

/**
 * Whether the window is in front of the person sitting at it.
 *
 * Both halves, because they answer different questions: `hidden` is a
 * minimised window or a background tab, and `hasFocus` is a window in plain
 * sight that somebody has clicked away from. Either one means the alert is not
 * being read where it already is.
 */
function outOfSight(): boolean {
  return document.visibilityState !== 'visible' || !document.hasFocus();
}

export function useDesktopAlerts({ subjects, rules, onOpen, say }: DesktopAlertsOptions): void {
  /* The newest notice already accounted for, per character. */
  const seen = useRef(new Map<SessionId, string>());
  /* When each kind last spoke for each character, keyed `session:kind`. */
  const rested = useRef(new Map<string, number>());
  const standing = useRef<Standing>('absent');
  const said = useRef(false);
  const open = useRef(onOpen);
  open.current = onOpen;
  /*
   * The one notification standing per character, so a second replaces rather
   * than stacks — `tag` already does that on the operating system's side, and
   * this is the same promise kept about the handles.
   */
  const live = useRef(new Map<SessionId, Notification>());

  /*
   * Ask once, and only once a row actually notifies: a client that asks for
   * notification permission on the first launch, before anybody has decided
   * they want any, is one that gets told no for the life of the install.
   */
  const anyNotifies = rules.some((rule) => rule.enabled && rule.notify);
  useEffect(() => {
    if (!anyNotifies || standing.current !== 'absent') return;
    if (typeof Notification === 'undefined') {
      // Not a browser that can, or a page that is not a secure context. Said
      // out loud, like every other refusal here: silence would read as a
      // setting that does nothing.
      if (!said.current) {
        said.current = true;
        say(t('notices.desktopAlerts.unavailable'));
      }
      return;
    }
    if (Notification.permission === 'granted') {
      standing.current = 'ready';
      return;
    }
    if (Notification.permission === 'denied') {
      standing.current = 'refused';
      if (!said.current) {
        said.current = true;
        say(t('notices.desktopAlerts.refused'));
      }
      return;
    }
    standing.current = 'asking';
    void Notification.requestPermission().then((answer) => {
      standing.current = answer === 'granted' ? 'ready' : 'refused';
      if (answer === 'granted' || said.current) return;
      said.current = true;
      say(t('notices.desktopAlerts.refused'));
    });
  }, [anyNotifies, say]);

  useEffect(() => {
    const marks = seen.current;
    for (const [id, subject] of Object.entries(subjects) as Array<[SessionId, AlertSubject]>) {
      // A character first seen starts from where it is (`freshNotices`).
      const fresh = freshNotices(marks, id, subject.notices);
      if (fresh === null) continue;
      if (standing.current !== 'ready') continue;
      /*
       * Only what arrived since the last look, newest first, and only the
       * first of those that no rule holds (`pickDesktopAlert`). The rest are
       * in the card, which is where a list belongs.
       *
       * The floor is per **kind** and the thing it is about, not per
       * character: being attacked is a fresh line several times a round, and
       * without one an evening away leaves a notification centre with
       * hundreds of entries in it, but a floor on the whole character would
       * let a burst of blows swallow the notice that the character then died.
       */
      const now = Date.now();
      const pick = pickDesktopAlert(fresh, rules, {
        inFront: !outOfSight(),
        away: subject.automation.away,
        now,
        gapMs: tuning().desktopAlertGapMs,
        spokeAt: (rests) => rested.current.get(`${id}:${rests}`)
      });
      /*
       * An arrival the gap or a newer alert held back is said in that
       * character's console, with the rule that held it, so a walk that ended
       * without a notification is not a mystery (todo 157). Arrivals only:
       * the gap holding a blow every round is its whole job, and a line per
       * blow is the noise it stops. The window in front is the row's own
       * `whileFocused`, so it is not said.
       */
      for (const { notice, kind, why } of pick.held) {
        if (kind === 'arrived') say(heldSentence(why, notice.text), id);
      }
      if (pick.raise === null) continue;
      const raise = pick.raise.notice;
      rested.current.set(`${id}:${pick.raise.rests}`, now);

      const { name } = subject.character;
      const title =
        name === null
          ? t('notices.desktopAlerts.untitled')
          : t('notices.desktopAlerts.title', { name });
      try {
        const shown = new Notification(title, { body: raise.text, tag: id });
        shown.onclick = () => {
          open.current(id);
          shown.close();
        };
        live.current.get(id)?.close();
        live.current.set(id, shown);
      } catch {
        /*
         * A constructor that throws is a platform that says it has
         * notifications and does not (a page served over plain HTTP to a
         * browser that only pretends). Stop trying, and say so once.
         */
        standing.current = 'refused';
        if (said.current) continue;
        said.current = true;
        say(t('notices.desktopAlerts.unavailable'));
      }
    }
  }, [subjects, rules, say]);

  /*
   * Nothing this window raised outlives it. A reload leaves notifications on
   * screen whose click would reach a page that is gone.
   */
  useEffect(() => {
    const shown = live.current;
    return () => {
      for (const notification of shown.values()) notification.close();
      shown.clear();
    };
  }, []);
}
