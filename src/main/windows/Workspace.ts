import fs from 'node:fs';
import path from 'node:path';

import type { SessionId } from '../../shared/ipc';

/**
 * Which window shows which characters.
 *
 * Distinct from the `WindowRegistry`, and the distinction is the whole point:
 * *attachment* is about where a session's bytes are pushed, and **ownership** is
 * about whose tab rail a character appears in. A window can be attached to a
 * session it does not own — it is showing it in a pane — and it must not have a
 * tab for one that lives in another window.
 *
 * Three rules:
 *
 * - **A character is owned by exactly one window.** Two tabs for one character
 *   in two windows is two places to type at it, and typing has to reach exactly
 *   one session.
 * - **Ownership is not a socket.** Moving a character between windows, or
 *   closing the window it lives in, must never disconnect it — the session is
 *   in main and it never moves (docs/profiles.md §7.4). A window closing hands
 *   its characters back rather than taking them with it.
 * - **A character nobody owns belongs to the main window.** That is what makes
 *   a crashed or force-closed pop-out recoverable without a restart, and it is
 *   also what makes the ordinary single-window case need no bookkeeping at all.
 */
export class Workspace {
  /** Window id → the characters whose tabs live there, in rail order. */
  private readonly owned = new Map<number, SessionId[]>();
  /**
   * What the file said, read once.
   *
   * Read lazily rather than in the constructor because the constructor runs
   * before the session host exists, and every list here is filtered against
   * what actually exists on the way out. Memoised because both readers want it
   * and the main window's is wanted *before* `restore()` is called — the main
   * window is created first, precisely so the characters no pop-out claims fall
   * to it.
   */
  private saved: { main: SessionId[]; popouts: SessionId[][] } | null = null;

  constructor(
    private readonly options: {
      /** The window a character falls back to. */
      mainWindowId(): number | null;
      /** Every character that exists, so ownership can be reconciled against it. */
      allSessions(): SessionId[];
      /** Where the arrangement is remembered. */
      file: string;
    }
  ) {}

  /** Called when a window appears. Restores whatever it used to hold. */
  open(windowId: number): void {
    if (this.owned.has(windowId)) return;
    /*
     * The main window's rail order is remembered like a pop-out's.
     *
     * It used not to be: `restore()` skipped the `main: true` entry on the
     * reasoning that its characters are "whatever is left", which is true of
     * *which* characters and says nothing about what order they are in. So a
     * rail dragged into the order somebody wanted came back alphabetical on
     * the next launch — the arrangement was written to the file every time and
     * read back never.
     *
     * Filtered against what exists, like every other list here, so a
     * remembered order naming a deleted character does not reserve it a place.
     * A character the file has never heard of is simply not in `mine`, and
     * `sessionsFor` appends it: a new character joins the end of the rail
     * rather than displacing the arrangement.
     */
    const remembered = windowId === this.options.mainWindowId() ? this.read().main : [];
    const all = new Set(this.options.allSessions());
    this.owned.set(
      windowId,
      remembered.filter((id) => all.has(id))
    );
  }

  /**
   * The rail, in the order somebody dragged it into.
   *
   * Stated whole rather than as a move, because the renderer already knows the
   * order it is drawing and re-deriving a move from two lists would be a second
   * copy of the rule that decides where a dropped tab lands.
   *
   * Filtered against what the window actually **shows** rather than against
   * what it literally owns, and the difference is the whole of the ordinary
   * case: a character nobody has popped out is unclaimed, and the main window
   * answers for it without owning it. Against `owned` this would have been a
   * no-op on every rail that had never been rearranged — which is every rail,
   * the first time.
   *
   * `sessionsFor` is also what keeps the safety property: a pop-out is shown
   * only what it owns, and the main window is never shown a character a pop-out
   * claims. So a window cannot reorder — or quietly adopt — a tab that lives
   * somewhere else, which is the same rule that stops it holding two tabs for
   * one character. Reordering does *claim* the unclaimed, which is right: they
   * were the main window's to begin with, and popping one out still moves it.
   *
   * Anything shown that the list does not name keeps its place at the end, so a
   * roster that grew between the drag starting and this arriving loses nobody.
   */
  reorder(windowId: number, order: readonly SessionId[]): void {
    if (!this.owned.has(windowId)) return;
    const shown = this.sessionsFor(windowId);
    const held = new Set(shown);
    const next = order.filter((id) => held.has(id));
    const seen = new Set(next);
    this.owned.set(windowId, [...next, ...shown.filter((id) => !seen.has(id))]);
  }

  /**
   * A window has gone.
   *
   * Its characters go back to the main window rather than with it: closing a
   * window must never disconnect a character, and a character with a live
   * socket and no tab anywhere is a character nobody can reach.
   */
  close(windowId: number): SessionId[] {
    const orphans = this.owned.get(windowId) ?? [];
    this.owned.delete(windowId);
    const main = this.options.mainWindowId();
    if (main !== null && main !== windowId) {
      const home = this.owned.get(main) ?? [];
      this.owned.set(main, [...home, ...orphans.filter((id) => !home.includes(id))]);
    }
    return orphans;
  }

  /** Which window a character's tab lives in, or null if none claims it. */
  windowOf(session: SessionId): number | null {
    for (const [windowId, sessions] of this.owned) {
      if (sessions.includes(session)) return windowId;
    }
    return null;
  }

  /**
   * The characters this window shows tabs for.
   *
   * Anything nobody owns is answered by the main window, so a character that
   * appeared while a pop-out had focus, or one whose window was force-closed,
   * is always reachable somewhere. Filtered against what actually exists, so a
   * remembered arrangement naming a character that has since been deleted does
   * not put a tab on screen for nothing.
   */
  sessionsFor(windowId: number): SessionId[] {
    const all = this.options.allSessions();
    const mine = (this.owned.get(windowId) ?? []).filter((id) => all.includes(id));
    if (windowId !== this.options.mainWindowId()) return mine;
    const claimed = new Set<SessionId>();
    for (const [id, sessions] of this.owned) {
      if (id === windowId) continue;
      for (const session of sessions) claimed.add(session);
    }
    const unclaimed = all.filter((id) => !claimed.has(id) && !mine.includes(id));
    return [...mine, ...unclaimed];
  }

  /** Moves a character's tab to a window. Removing it from wherever it was. */
  move(session: SessionId, toWindow: number): void {
    for (const [windowId, sessions] of this.owned) {
      if (windowId === toWindow) continue;
      const at = sessions.indexOf(session);
      if (at !== -1) sessions.splice(at, 1);
    }
    const target = this.owned.get(toWindow) ?? [];
    if (!target.includes(session)) target.push(session);
    this.owned.set(toWindow, target);
  }

  /** Every window that currently holds a tab, for republishing. */
  windows(): number[] {
    return [...this.owned.keys()];
  }

  /* ------------------------------------------------------------ on disk */

  /**
   * The arrangement, remembered.
   *
   * In its own file under the user data directory and **not** in the options
   * file: it is chrome state, it changes constantly, and writing it into a
   * hand-annotated YAML file the user edits would mean the client fighting them
   * for it (docs/profiles.md §7.4). Same reasoning as card layout and theme.
   *
   * Keyed by *position in the window order* rather than by window id, because
   * an Electron window id is not stable across launches — a saved id would
   * restore a character into a window that no longer exists.
   */
  save(): void {
    const ordered = this.windows().sort((a, b) => a - b);
    const main = this.options.mainWindowId();
    const layout = {
      v: 1,
      windows: ordered.map((id) => ({
        main: id === main,
        sessions: this.owned.get(id) ?? []
      }))
    };
    try {
      fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
      fs.writeFileSync(this.options.file, `${JSON.stringify(layout, null, 2)}\n`, 'utf8');
    } catch {
      // An arrangement that cannot be written is a convenience lost, not a
      // reason to fail: everything still works, in one window.
    }
  }

  /**
   * What was saved, as a list of the pop-out windows to recreate.
   *
   * The main window's group is not among them — it already exists, and `open`
   * has taken its order. Anything naming a character that no longer exists is
   * dropped rather than recreating an empty window.
   */
  restore(): SessionId[][] {
    const all = new Set(this.options.allSessions());
    return this.read()
      .popouts.map((group) => group.filter((id) => all.has(id)))
      .filter((group) => group.length > 0);
  }

  /**
   * The file, parsed once and never trusted.
   *
   * Unfiltered: what exists changes between this being read and each caller
   * asking, so the filtering is every caller's own. A file that will not parse
   * is an arrangement lost, not a reason to fail — everything still works, in
   * one window, in the order the characters were loaded in.
   */
  private read(): { main: SessionId[]; popouts: SessionId[][] } {
    if (this.saved) return this.saved;
    this.saved = { main: [], popouts: [] };

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.options.file, 'utf8'));
    } catch {
      return this.saved;
    }
    if (typeof parsed !== 'object' || parsed === null) return this.saved;
    const windows = (parsed as { windows?: unknown }).windows;
    if (!Array.isArray(windows)) return this.saved;

    for (const entry of windows) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as { main?: unknown; sessions?: unknown };
      if (!Array.isArray(record.sessions)) continue;
      const sessions = record.sessions.filter((id): id is SessionId => typeof id === 'string');
      if (record.main === true) this.saved.main = sessions;
      else if (sessions.length > 0) this.saved.popouts.push(sessions);
    }
    return this.saved;
  }
}
