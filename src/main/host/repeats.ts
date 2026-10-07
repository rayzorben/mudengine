/**
 * A `character` push a window already holds is not sent to it again (todo
 * 836): 42 of 100 in one round of a party fight were repeats, and 3,719 of
 * the 8,345 pushed over twenty minutes of soul's capture (2026-10-06). Each
 * host keeps one per window or tab, beside the text it serialises anyway. A
 * character goes to every window (`WindowRegistry.toAll`), so what a window
 * was last sent for a session is what it holds once it has attached: a push
 * it missed while loading is covered by the attach snapshot. Every push to
 * that window, a replay included, goes through the same filter.
 */
import { Push } from '../../shared/ipc';

export class RepeatedCharacters {
  /** The last `character` push sent, by session, as serialised. */
  private readonly last = new Map<string, string>();

  /** Whether a push on `channel`, serialised as `text`, is the character this window was last sent. */
  repeats(channel: string, payload: unknown, text: string): boolean {
    if (channel !== Push.character) return false;
    const session = sessionOf(payload);
    if (session === null) return false;
    if (this.last.get(session) === text) return true;
    this.last.set(session, text);
    return false;
  }
}

/** The session a push is about, where its payload names one (`{ session, payload }`). */
function sessionOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const session = (payload as Record<string, unknown>)['session'];
  return typeof session === 'string' ? session : null;
}
