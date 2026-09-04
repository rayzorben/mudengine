/**
 * Which windows exist, and which sessions each one is showing.
 *
 * Sessions belong to the app, not to a window (docs/profiles.md §4). A window
 * is a *view*: it attaches to the sessions it is displaying and detaches when
 * it stops, and closing one must never reach the socket. This registry is the
 * only thing that knows the mapping, so "who should receive this?" has exactly
 * one answer.
 *
 * Three tiers, and the distinctions are the reason this exists rather than a
 * broadcast:
 *
 * - `toAttached` is for the byte stream — `data`. At four characters
 *   in combat, serialising every chunk once per open window is precisely the
 *   cost that ends with chrome pacing the stream, so a window that is not
 *   showing a session does not pay for it.
 * - `toDiagnostics` is `toAttached` narrowed further, for `line`: per framed
 *   line, and read only by the Stream card, which is hidden by default. A
 *   window says whether it is showing that card (`Send.diagnostics`), so the
 *   common case pays nothing per line at all.
 * - `toAll` is for the coalesced, low-rate facts — state, character, walk,
 *   automation. A window renders those for every session in its tab rail
 *   whether or not it is showing that session's terminal, so they go
 *   everywhere.
 *
 * Deliberately not typed against Electron's `BrowserWindow`: cross-talk between
 * sessions is the defining bug of the multi-session refactor, and it has to be
 * testable without standing up a browser.
 */
import type { Addressed, SessionId } from '../../shared/ipc';

/** The part of a window this registry needs. `BrowserWindow` satisfies it. */
export interface WindowLike {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

interface Entry {
  window: WindowLike;
  attached: Set<SessionId>;
  /** Whether this window asked for the per-line diagnostics feed. */
  diagnostics: boolean;
}

export class WindowRegistry {
  private readonly entries = new Map<number, Entry>();

  add(window: WindowLike): void {
    this.entries.set(window.id, { window, attached: new Set(), diagnostics: false });
  }

  remove(windowId: number): void {
    this.entries.delete(windowId);
  }

  /** Every live window, for anything that publishes per window rather than to all. */
  ids(): number[] {
    return [...this.live()].map((entry) => entry.window.id);
  }

  /**
   * One window, by id.
   *
   * The session roster is per window now — which characters have tabs there —
   * so there is something that genuinely differs between windows to send, where
   * `toAll` and `toAttached` both answer questions that do not.
   */
  toWindow(windowId: number, channel: string, payload: unknown): void {
    for (const entry of this.live()) {
      if (entry.window.id === windowId) entry.window.send(channel, payload);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Sessions the given window is showing. */
  attachments(windowId: number): SessionId[] {
    return [...(this.entries.get(windowId)?.attached ?? [])];
  }

  attach(windowId: number, session: SessionId): void {
    this.entries.get(windowId)?.attached.add(session);
  }

  detach(windowId: number, session: SessionId): void {
    this.entries.get(windowId)?.attached.delete(session);
  }

  /** Every window showing a session, so a pop-out knows whether it is the last. */
  viewers(session: SessionId): number[] {
    return [...this.entries.values()]
      .filter((entry) => entry.attached.has(session))
      .map((entry) => entry.window.id);
  }

  /** The byte stream: only to windows actually showing that session. */
  toAttached<T>(channel: string, message: Addressed<T>): void {
    for (const entry of this.live()) {
      if (entry.attached.has(message.session)) entry.window.send(channel, message);
    }
  }

  /** A window opened or closed its diagnostics feed. */
  setDiagnostics(windowId: number, on: boolean): void {
    const entry = this.entries.get(windowId);
    if (entry) entry.diagnostics = on;
  }

  /** The per-line feed: attached windows that asked to see it. */
  toDiagnostics<T>(channel: string, message: Addressed<T>): void {
    for (const entry of this.live()) {
      if (entry.diagnostics && entry.attached.has(message.session)) {
        entry.window.send(channel, message);
      }
    }
  }

  /** Coalesced facts, and app-level payloads: to every live window. */
  toAll(channel: string, payload: unknown): void {
    for (const entry of this.live()) entry.window.send(channel, payload);
  }

  /**
   * Drops windows that have been destroyed as it goes.
   *
   * `closed` is not guaranteed to have fired before the next push — a window
   * torn down during a burst would otherwise be sent to, and `send` on a
   * destroyed `webContents` throws.
   */
  private *live(): Generator<Entry> {
    for (const [id, entry] of this.entries) {
      if (entry.window.isDestroyed()) {
        this.entries.delete(id);
        continue;
      }
      yield entry;
    }
  }
}
