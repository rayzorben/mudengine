/**
 * The characters on screen, one per pane, and which pane the keyboard is
 * talking to: showing a tab, stepping through them, going side by side,
 * turning the split and closing a pane.
 *
 * Out of `App` (todo 731) with the state it owns; the split's arithmetic reads
 * the terminal's measured cell width (the 8px column gap is still a constant,
 * the stylesheet's own). See
 * `mudengine-ui` › *The window redraws what changed*.
 */
import { useCallback, useMemo, useRef, useState, type MutableRefObject } from 'react';

import { t } from '../lib/i18n';
import { CONSOLE_COLUMNS as MIN_COLUMNS, type PaneFlow } from '../lib/splitter';
import { tuning } from '../lib/tuning';
import { useOverridablePreference } from './usePreference';
import { NO_SESSION, type SessionId, type SessionSummary } from '@shared/ipc';

/**
 * What `App` reads of the panes, and the controls it hands down. Destructured
 * where it is called, so each field keeps its own identity: the list is
 * memoised and every control is a stable callback.
 */
export interface Panes {
  /** The characters on screen, in pane order, filtered to those still loaded. */
  panes: SessionId[];
  /** The pane the keyboard is talking to. */
  paneAt: number;
  /** The character in that pane, or `NO_SESSION` with none loaded. */
  session: SessionId;
  paneFlow: PaneFlow;
  /** The element the panes divide, so a split can be measured before it is made. */
  layersRef: MutableRefObject<HTMLDivElement | null>;
  showSession(id: SessionId): void;
  stepSession(delta: number): void;
  focusPane(id: SessionId): void;
  addPane(id: SessionId): void;
  turnPanes(next: PaneFlow): void;
  closePane(): void;
}

/**
 * @param sessions The roster, in rail order.
 * @param cols The shown console's measured width, in columns.
 * @param say A sentence into a character's own console, for a refusal.
 */
export function usePanes(
  sessions: readonly SessionSummary[],
  cols: number,
  say: (session: SessionId, message: string) => void
): Panes {
  /**
   * The characters on screen, one per pane, and which pane the keyboard is
   * talking to.
   *
   * Flat and at most four: a recursive split tree needs a layout algebra, drag
   * handles and a serialisation format, and pays that back for someone tiling
   * six documents rather than watching four characters. See docs/profiles.md
   * §7.3.
   */
  const [paneIds, setPaneIds] = useState<SessionId[]>([]);
  const [focusedPane, setFocusedPane] = useState(0);

  /**
   * The panes, filtered to characters that are still loaded.
   *
   * Derived rather than corrected in place: a character closing while it is on
   * screen must not leave a pane pointing at an id nothing answers to, and
   * there is always at least one pane while there is at least one character.
   */
  const panes = useMemo(() => {
    const live = paneIds.filter((id) => sessions.some((entry) => entry.id === id));
    if (live.length > 0) return live;
    return sessions.length > 0 ? [sessions[0]!.id] : [];
  }, [paneIds, sessions]);

  const paneAt = Math.min(focusedPane, Math.max(0, panes.length - 1));
  const session = panes[paneAt] ?? NO_SESSION;

  /**
   * Stacked or side by side.
   *
   * Stacked is the default because rows are cheap and columns are not: the
   * console needs 80 of them and no server in this family will format to fewer.
   * That is the opposite of the browser convention, and it follows from the
   * game rather than from taste.
   */
  const [paneFlow, setPaneFlow] = useOverridablePreference<PaneFlow>(
    'mudengine.panes',
    'rows',
    (value): value is PaneFlow => value === 'rows' || value === 'columns'
  );

  /**
   * Show a different character.
   *
   * Sends nothing. The state is already here — every character's facts arrive
   * whether or not its terminal is on screen — so a switch is a change of view
   * and never a command. A bare Enter to "refresh" would be a command the player
   * did not type, and in this game a bare Enter is a full room description that
   * re-triggers everything listening for one.
   */
  const showSession = useCallback(
    (id: SessionId) => {
      // Already on screen? Then this is a request to type at it, not to move it.
      const at = panes.indexOf(id);
      if (at >= 0) {
        setFocusedPane(at);
        return;
      }
      setPaneIds(panes.map((current, index) => (index === paneAt ? id : current)));
    },
    [paneAt, panes]
  );

  const stepSession = useCallback(
    (delta: number) => {
      if (sessions.length < 2) return;
      const at = sessions.findIndex((entry) => entry.id === session);
      const next = sessions[(at + delta + sessions.length) % sessions.length];
      if (next) showSession(next.id);
    },
    [session, sessions, showSession]
  );

  /** The element the panes divide, so a split can be measured before it is made. */
  const layersRef = useRef<HTMLDivElement | null>(null);

  /**
   * How many columns each pane would get if the slate were divided `count` ways
   * side by side.
   *
   * Arithmetic on a *measured* cell width, never on a constant. There is no
   * minimum-pane-width in pixels anywhere in this path and there cannot be:
   * display scaling differs per user, a window can be dragged to a monitor with
   * another scale factor, and the terminal font size is a setting. The live
   * terminal's own geometry is the only honest source for what a column costs.
   *
   * A prediction only — once the split lands each pane measures itself for real
   * and reality wins. This exists to avoid making the mess, not to be believed
   * afterwards.
   */
  const columnsIfSplit = useCallback(
    (count: number): number | null => {
      const box = layersRef.current;
      if (!box || cols <= 0) return null;
      const cell = box.clientWidth / cols;
      if (!Number.isFinite(cell) || cell <= 0) return null;
      // The gaps between panes are not available to any of them.
      const gap = 8 * (count - 1);
      return Math.floor((box.clientWidth - gap) / count / cell);
    },
    [cols]
  );

  /**
   * The one gate on going side by side: predicts the split, and when each
   * console would fall under the floor, prints the caller's refusal into the
   * shown terminal. True means refused, so the caller stands down. Shared by
   * `addPane` and `turnPanes` because the arithmetic and the reporting must
   * not drift apart — only the remedy clause differs.
   */
  const refuseNarrowSplit = useCallback(
    (count: number, message: (columns: number) => string): boolean => {
      const predicted = columnsIfSplit(count);
      if (predicted === null || predicted >= MIN_COLUMNS) return false;
      say(session, message(predicted));
      return true;
    },
    [columnsIfSplit, say, session]
  );

  /**
   * Put another character on screen beside this one.
   *
   * Refused when the slate cannot carry it side by side, with the only two
   * remedies there are: stack instead, or use a smaller terminal font. There is
   * no third — the server never negotiates NAWS, so "tell it we are narrower"
   * is not a thing that exists.
   */
  const addPane = useCallback(
    (id: SessionId) => {
      if (panes.length >= tuning().maxPanes || panes.includes(id)) return;

      if (
        paneFlow === 'columns' &&
        refuseNarrowSplit(panes.length + 1, (columns) =>
          t('notices.panes.splitTooNarrowStack', { columns, minColumns: MIN_COLUMNS })
        )
      ) {
        return;
      }

      setPaneIds([...panes, id]);
      setFocusedPane(panes.length);
    },
    [paneFlow, panes, refuseNarrowSplit]
  );

  /**
   * Turn the split, if the slate can carry it.
   *
   * Guarded for the same reason `addPane` is, and it is the same gate: asking
   * for side by side is a deliberate action, so it is refused with a reason
   * rather than granted and then complained about. Turning *back* to stacked is
   * always allowed — it can only ever give a console more room.
   *
   * This is not the same case as a split that drifts under the floor because
   * the window was dragged narrower. That one is reported and never corrected:
   * a layout that reorganises itself under someone's hands mid-combat is a
   * hazard, and the status rail says `narrow` instead.
   */
  const turnPanes = useCallback(
    (next: PaneFlow) => {
      if (
        next === 'columns' &&
        panes.length > 1 &&
        refuseNarrowSplit(panes.length, (columns) =>
          t('notices.panes.splitTooNarrowKeep', { columns, minColumns: MIN_COLUMNS })
        )
      ) {
        return;
      }
      setPaneFlow(next);
    },
    [panes.length, refuseNarrowSplit, setPaneFlow]
  );

  const closePane = useCallback(() => {
    if (panes.length < 2) return;
    setPaneIds(panes.filter((_, index) => index !== paneAt));
    setFocusedPane(Math.max(0, paneAt - 1));
  }, [paneAt, panes]);

  const focusPane = useCallback(
    (id: SessionId) => {
      const at = panes.indexOf(id);
      if (at >= 0) setFocusedPane(at);
    },
    [panes]
  );

  return {
    panes,
    paneAt,
    session,
    paneFlow,
    layersRef,
    showSession,
    stepSession,
    focusPane,
    addPane,
    turnPanes,
    closePane
  };
}
