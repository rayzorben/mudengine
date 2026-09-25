/**
 * The facts about every character this window has loaded: one view each, the
 * patch queue that flushes them together, and the subscriptions that fill it.
 *
 * Out of `App` (todo 731). One reducer with one flush; a global store would be
 * a second place a fact lives. Each fact is folded through `useAlerts`' port
 * inside the patch that holds the previous state. See `mudengine-ui` › *The
 * window redraws what changed*.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { keepRoster } from '../lib/roster';
import { tuning } from '../lib/tuning';
import type { AlertRaiser } from './useAlerts';
import { recallStatsBase, rememberStatsBase } from './useRemembered';
import { EMPTY_AUTOMATION, type AutomationSnapshot } from '@shared/automation';
import type { Block } from '@shared/blocks';
import { EMPTY_CHARACTER, type CharacterState } from '@shared/character';
import type { Find } from '@shared/finds';
import type { AttachSnapshot, IpcApi, SessionId } from '@shared/ipc';
import { NO_LOOP, type LoopProgress } from '@shared/loops';
import type { Discovery } from '@shared/memory';
import { mayNotice, type Notice } from '@shared/notifications';
import { NO_PLAYERS, type PlayerRegistry } from '@shared/players';
import {
  IDLE_QUEST_RUN,
  type QuestRunProgress,
  type QuestWatched,
  type RoomAsk
} from '@shared/quests';
import type { CombatTally } from '@shared/tally';
import { isTalkBlock } from '@shared/talk';
import type { ConnectionState, StreamLine, TelnetEvent } from '@shared/types';
import { EMPTY_ROOM_VERDICT, type RoomVerdict } from '@shared/verdict';
import { IDLE_WALK, type WalkProgress } from '@shared/walk';

const INITIAL_STATE: ConnectionState = {
  phase: 'idle',
  target: null,
  connectedAt: null,
  detail: null,
  endedBy: null,
  negotiated: {
    localEnabled: [],
    remoteEnabled: [],
    binary: false,
    suppressGoAhead: false,
    remoteEcho: false
  }
};

/**
 * What this window knows about one character.
 *
 * Held per session rather than only for the one on screen, because the tab rail
 * reports vitals, room and current action for characters whose terminals it is
 * not showing — that is the whole reason the rail is worth having. The coalesced
 * channels already reach every window for every session, so this is a matter of
 * keeping what arrives rather than of asking for more.
 */
export interface SessionView {
  state: ConnectionState;
  character: CharacterState;
  /** What is known about the other players: its own push, never the character's (todo 730). */
  players: PlayerRegistry;
  walk: WalkProgress;
  loop: LoopProgress;
  automation: AutomationSnapshot;
  /** The room appraised — *can I fight this?* — beside the character it is about. */
  verdict: RoomVerdict;
  /** What the things standing in the room answer to, for this character. See `asksHere`. */
  asks: RoomAsk[];
  /**
   * The Combat Stats card's baseline: the totals every figure on it is a
   * difference from, or null for the whole session.
   *
   * Held here rather than in the card because the card ships **put away**, and
   * what re-bases it has to be running whether or not anything is drawn — a lap
   * beginning is a moment, not a render. One value, written by the card's Reset
   * button and by the lap alike, so neither has to outrank the other.
   */
  statsBase: CombatTally | null;
  lines: StreamLine[];
  telnet: TelnetEvent[];
  /**
   * What has been said, per character.
   *
   * The terminal carries every line, but it carries *everything* — a telepath
   * scrolls out of reach behind a combat burst within seconds, which is exactly
   * when nobody can go looking for it. Kept here so a second view of the same
   * stream can hold it.
   */
  talk: Block[];
  /**
   * What is worth knowing, ranked.
   *
   * Derived here rather than in main because it is a *reading* of facts that
   * already arrive, not a new fact: main publishes blocks and character state,
   * and turning those into "this deserves an alert" is presentation. Adding an
   * IPC channel for it would mean a second place that has to agree about what
   * counts as urgent.
   */
  notices: Notice[];
  /**
   * What has been raised while nobody was looking at this character.
   *
   * The point of running four characters is that three of them are unattended,
   * and the point of a tab rail is that it reports on the ones whose terminal
   * is not on screen. Vitals and walk state already reach it; *alerts* did not,
   * so a hostile arriving in an unattended character's room raised nothing
   * anybody would see.
   *
   * Cleared when the character is put on screen, because that is what "seen"
   * means. Counted rather than kept: the notices themselves are already in
   * `notices`, and a tab has room for a number.
   */
  unseen: { critical: number; warning: number; latest: string | null };
  /**
   * What this character has found that the realm data does not have.
   *
   * Per character rather than per realm, like the file it comes from: two
   * characters on one realm have been to different places, and the record is a
   * record of where *this* one has been.
   */
  learned: Discovery[];
  /**
   * What a `search` has turned up in this realm.
   *
   * Per **realm** rather than per character, unlike `learned` above it: that a
   * room hides a rusty key is a fact about the world, so every character
   * dialling the realm reads the same log. See `src/shared/finds.ts`.
   */
  finds: Find[];
  /**
   * The rank each quest has been *seen* to reach, from what this character was
   * watched doing this session.
   *
   * Nothing on the wire announces a counter moving, so this is the character's
   * own action and nothing more — the quest book ranks it under the realm's own
   * count *as of when that was read* and above the mark somebody set by hand.
   * See `questReading` for how the three are ranked, `stepSaid` for the line
   * typed at an asker, `stepKilled` for the monster a step is owned by.
   */
  questSaid: QuestWatched;
  /** How a run of a quest's plan is going, or how the last one ended. */
  questRun: QuestRunProgress;
}

const EMPTY_UNSEEN = { critical: 0, warning: 0, latest: null } as const;

export const EMPTY_VIEW: SessionView = {
  state: INITIAL_STATE,
  character: EMPTY_CHARACTER,
  players: NO_PLAYERS,
  walk: IDLE_WALK,
  loop: NO_LOOP,
  automation: EMPTY_AUTOMATION,
  verdict: EMPTY_ROOM_VERDICT,
  asks: [],
  statsBase: null,
  lines: [],
  telnet: [],
  talk: [],
  notices: [],
  unseen: EMPTY_UNSEEN,
  learned: [],
  finds: [],
  questSaid: {},
  questRun: IDLE_QUEST_RUN
};

/**
 * The totals as they stand, written down as the Combat Stats card's baseline.
 *
 * The one writer for the button and the lap alike, so neither has to be
 * compared against the other — and written down beside the layout, because
 * main's totals outlive the launch and the reading they are subtracted from
 * has to as well, or a launch silently undid the last press or the lap.
 */
function rebased(session: SessionId, view: SessionView): CombatTally {
  rememberStatsBase(session, view.character.tally);
  return view.character.tally;
}

/**
 * Folds new notices into the unseen count for a character.
 *
 * A character on screen has seen them by definition, so nothing accumulates for
 * the one being played — the count exists for the other three. `info` is not
 * counted: a tab that lights up for somebody arriving in the realm is a tab
 * nobody reads, and the whole value of the mark is that it is rare.
 */
function missed(
  current: SessionView['unseen'],
  raised: Notice[],
  shown: boolean
): SessionView['unseen'] {
  if (shown) return current.critical === 0 && current.warning === 0 ? current : EMPTY_UNSEEN;
  const worth = raised.filter((notice) => notice.severity !== 'info');
  if (worth.length === 0) return current;
  return {
    critical: current.critical + worth.filter((n) => n.severity === 'critical').length,
    warning: current.warning + worth.filter((n) => n.severity === 'warning').length,
    // The newest, for the tab's title: a number says how much and this says what.
    latest: worth[worth.length - 1]!.text
  };
}

/** Keeps a log bounded without reallocating it on every append. */
function capped<T>(log: T[], entry: T, limit: number): T[] {
  const next = [...log, entry];
  return next.length > limit ? next.slice(-limit) : next;
}

/** Raised notices folded into a view's log, and counted if nobody is looking. */
function heard(
  view: SessionView,
  raised: Notice[],
  shown: boolean
): Pick<SessionView, 'notices' | 'unseen'> {
  return {
    notices: raised.reduce(
      (log, notice) => capped(log, notice, tuning().noticeLimit),
      view.notices
    ),
    unseen: missed(view.unseen, raised, shown)
  };
}

/** The pushes the views are folded from: the bridge's subscriptions, and nothing it sends. */
export type ViewFeeds = Pick<
  IpcApi,
  | 'onState'
  | 'onCharacter'
  | 'onWalk'
  | 'onLoop'
  | 'onPlayers'
  | 'onLearned'
  | 'onFinds'
  | 'onQuestSaid'
  | 'onQuestRun'
  | 'onAutomation'
  | 'onVerdict'
  | 'onAsks'
  | 'onTelnet'
  | 'onLine'
  | 'onBlock'
>;

/** What `App` reads of the views, and the writes it makes through the one queue. */
export interface SessionViews {
  views: Readonly<Record<SessionId, SessionView>>;
  /** Queue a change to one character's view; see the flush below. */
  patchView(id: SessionId, patch: (view: SessionView) => SessionView): void;
  /** A window attaching to a running session: everything main kept for it. */
  applySnapshot(id: SessionId, snapshot: AttachSnapshot): void;
  /** Re-base one character's Combat Stats card to its totals as they stand. */
  resetStats(id: SessionId): void;
}

/**
 * @param feeds The pushes, as the bridge delivers them.
 * @param alerts What each fact is worth saying; identity-stable (`useAlerts`).
 * @param shown The characters on screen, which have seen what they raise.
 */
export function useSessionViews(
  feeds: ViewFeeds,
  alerts: AlertRaiser,
  shown: readonly SessionId[]
): SessionViews {
  const [views, setViews] = useState<Record<SessionId, SessionView>>({});

  /**
   * Which characters are on screen right now.
   *
   * A set rather than a single id, because a split shows several at once and
   * all of them count as seen. Read through a ref for the reason `useAlerts`
   * reads the thresholds through one: these subscriptions are registered for
   * the window's lifetime and must not be rebuilt every time somebody changes
   * tab.
   */
  const shownRef = useRef<Set<SessionId>>(new Set());

  /**
   * View patches queue and flush together, at most every
   * `tuning.chromeFlushMs` — chrome must never be able to pace the stream.
   *
   * Applying each push as its own state update re-rendered every card on the
   * rail per pushed fact, and on a busy realm that is many times a second: the
   * renderer spent its whole budget redrawing chrome and the console's own
   * writes — the player's echoed keystrokes among them — queued behind it.
   * Leading edge, so a lone change still paints at once; the sweep behind it
   * catches whatever a burst adds. One queue for every caller, because a
   * direct write landing between queued patches would apply them out of the
   * order they were pushed in.
   */
  const pendingPatches = useRef(new Map<SessionId, Array<(view: SessionView) => SessionView>>());
  const patchTimer = useRef<number | null>(null);
  const flushPatches = useCallback(() => {
    const batch = pendingPatches.current;
    if (batch.size === 0) return;
    pendingPatches.current = new Map();
    setViews((prev) => {
      const next = { ...prev };
      for (const [id, patches] of batch) {
        next[id] = patches.reduce((view, patch) => patch(view), next[id] ?? EMPTY_VIEW);
      }
      return next;
    });
  }, []);
  const patchView = useCallback(
    (id: SessionId, patch: (view: SessionView) => SessionView) => {
      const batch = pendingPatches.current;
      const queued = batch.get(id);
      if (queued) queued.push(patch);
      else batch.set(id, [patch]);
      if (patchTimer.current !== null) return;
      flushPatches();
      patchTimer.current = window.setTimeout(() => {
        patchTimer.current = null;
        flushPatches();
      }, tuning().chromeFlushMs);
    },
    [flushPatches]
  );
  useEffect(
    () => () => {
      if (patchTimer.current !== null) window.clearTimeout(patchTimer.current);
      // Forgotten too: StrictMode and Fast Refresh re-run the effects on this
      // same instance, and a handle still held would hold every patch (753).
      patchTimer.current = null;
    },
    []
  );

  const applySnapshot = useCallback(
    (id: SessionId, snapshot: AttachSnapshot) => {
      patchView(id, (was) => ({
        state: snapshot.state,
        character: snapshot.character,
        players: snapshot.players,
        walk: snapshot.walk,
        loop: snapshot.loop,
        automation: snapshot.automation,
        verdict: snapshot.verdict,
        asks: snapshot.asks,
        /*
         * Carried, not reset. A snapshot is this window attaching to a session
         * that was already running, and main's totals are the same monotonic
         * ones the baseline was taken from — so a reading this window had
         * survives the attach — and one written down before the launch is
         * read back here, since main's totals outlive the launch too. A
         * baseline older than the *totals* is a different matter and is
         * discarded by the card's own `stale` test.
         */
        statsBase: was.statsBase ?? recallStatsBase(id),
        lines: snapshot.lines.slice(-tuning().lineLogLimit),
        telnet: snapshot.telnet.slice(-tuning().telnetLogLimit),
        // The conversation log's tail: main keeps what was said on disk, so a
        // restart restores the Talk card instead of starting it empty.
        talk: snapshot.talk.slice(-tuning().talkLimit),
        notices: [],
        // A window that has just attached has not missed anything: the
        // backscroll it replays is the record, and a count of alerts raised
        // before it existed is a number nobody can act on.
        unseen: EMPTY_UNSEEN,
        learned: snapshot.learned,
        finds: snapshot.finds,
        questSaid: snapshot.questSaid,
        questRun: snapshot.questRun
      }));
    },
    [patchView]
  );

  /*
   * Putting a character on screen is what "seen" means, so its unseen count
   * clears here rather than on a click: a split that brings a second character
   * up, a pane closing, and a tab switch are all the same event as far as
   * having looked at it is concerned.
   */
  useEffect(() => {
    shownRef.current = new Set(shown);
    for (const id of shown) {
      patchView(id, (v) =>
        v.unseen.critical === 0 && v.unseen.warning === 0 ? v : { ...v, unseen: EMPTY_UNSEEN }
      );
    }
  }, [shown, patchView]);

  /**
   * Re-base one character's Combat Stats card to its totals as they stand.
   *
   * The same write the lap makes on `onLoop`, so the button and the loop
   * cannot disagree about what a baseline is; main's totals are untouched by
   * either, which is what makes both safe.
   */
  const resetStats = useCallback(
    (sid: SessionId) => patchView(sid, (v) => ({ ...v, statsBase: rebased(sid, v) })),
    [patchView]
  );

  /**
   * Facts about every character, kept for every character.
   *
   * These channels are addressed but not filtered: the tab rail draws vitals
   * and current action for characters this window is not showing, which is the
   * point of the rail. They are coalesced and low-rate, so keeping all of them
   * costs a state update per change rather than per line.
   */
  useEffect(() => {
    const off = [
      feeds.onState(({ session: id, payload }) =>
        patchView(id, (v) => {
          const raised = alerts.link(id, v.state, payload);
          return {
            ...v,
            state: payload,
            ...heard(v, raised, shownRef.current.has(id))
          };
        })
      ),
      feeds.onCharacter(({ session: id, payload }) =>
        patchView(id, (v) => {
          // From the character the patch has in hand, because the alert is the
          // crossing, and read against the live rows (`useAlerts`).
          const raised = alerts.character(id, v.character, payload);
          return {
            ...v,
            character: keepRoster(v.character, payload),
            ...heard(v, raised, shownRef.current.has(id))
          };
        })
      ),
      feeds.onWalk(({ session: id, payload }) =>
        patchView(id, (v) => {
          const raised = alerts.walk(id, v.walk, payload, v.loop);
          return {
            ...v,
            walk: payload,
            ...heard(v, raised, shownRef.current.has(id))
          };
        })
      ),
      feeds.onLoop(({ session: id, payload }) =>
        patchView(id, (v) => ({
          ...v,
          loop: payload,
          /*
           * A lap that has just begun re-bases the Combat Stats card — todo
           * 01, *"starting a loop should reset combat statistics; restarting a
           * loop should not"*.
           *
           * `lapBegunAt` is the moment the run first stood on the loop, which
           * is what makes both halves of that sentence one test: `start` clears
           * it and the first stop reached sets it, while `resume` leaves it
           * exactly as it was, so a restart moves nothing here. And it is the
           * *lap* rather than the button, so the twenty-eight steps out from
           * town are not counted as a stretch the loop earned nothing over.
           *
           * The totals as they stand at that instant, which is the same value
           * the Reset button writes — main's own totals are untouched either
           * way, so this is a reading being re-based and never data being lost.
           */
          statsBase:
            payload.lapBegunAt !== null && payload.lapBegunAt !== v.loop.lapBegunAt
              ? rebased(id, v)
              : v.statsBase
        }))
      ),
      feeds.onPlayers(({ session: id, payload }) =>
        patchView(id, (v) => ({ ...v, players: payload }))
      ),
      feeds.onLearned(({ session: id, payload }) =>
        patchView(id, (v) => ({ ...v, learned: payload }))
      ),
      feeds.onFinds(({ session: id, payload }) => patchView(id, (v) => ({ ...v, finds: payload }))),
      feeds.onQuestSaid(({ session: id, payload }) =>
        patchView(id, (v) => ({ ...v, questSaid: payload }))
      ),
      feeds.onQuestRun(({ session: id, payload }) =>
        patchView(id, (v) => ({ ...v, questRun: payload }))
      ),
      feeds.onAutomation(({ session: id, payload }) =>
        patchView(id, (v) => ({ ...v, automation: payload }))
      ),
      feeds.onVerdict(({ session: id, payload }) =>
        patchView(id, (v) => ({ ...v, verdict: payload }))
      ),
      feeds.onAsks(({ session: id, payload }) => patchView(id, (v) => ({ ...v, asks: payload }))),
      feeds.onTelnet(({ session: id, payload }) =>
        patchView(id, (v) => ({ ...v, telnet: capped(v.telnet, payload, tuning().telnetLogLimit) }))
      ),
      feeds.onLine(({ session: id, payload }) =>
        patchView(id, (v) => ({ ...v, lines: capped(v.lines, payload, tuning().lineLogLimit) }))
      ),
      // Facts, read two more ways. Nothing is asked of the server for either:
      // both are second views of the block feed the terminal already carries.
      feeds.onBlock(({ session: id, payload }) => {
        const conversation = isTalkBlock(payload);
        // Cheap first: most lines are neither, and reaching into the character's
        // state for every one of them would put work on the block feed's hot
        // path for nothing.
        if (!conversation && !mayNotice(payload)) return;
        patchView(id, (v) => {
          /*
           * Inside the patch, because one notice depends on who threw the
           * punch: a blow from a monster is the weather, and the same blow from
           * a *player* opens the five-minute window in which hanging up kills.
           * The roster that tells them apart is on the view being patched.
           */
          const raised = alerts.block(id, payload, v.character);
          return {
            ...v,
            talk: conversation ? capped(v.talk, payload, tuning().talkLimit) : v.talk,
            ...heard(v, raised, shownRef.current.has(id))
          };
        });
      })
    ];

    return () => off.forEach((unsubscribe) => unsubscribe());
  }, [feeds, alerts, patchView]);

  return { views, patchView, applySnapshot, resetStats };
}
