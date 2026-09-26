/**
 * What goes to one browser tab, and when (todo 836). A reply always goes.
 * A push waits until the tab says its bridge is listening (`Send.clientReady`):
 * sent before, it was dropped by a bridge with no listener, and the replay the
 * ready message starts covers what it would have carried. A `character` push
 * identical to the last one this tab was sent for that session is not sent
 * again: 42 of 100 in one round of a party fight were repeats. Web only; the
 * desktop window takes every push.
 */
import { Push } from '../../../shared/ipc';
import type { RpcOutbound } from '../../../shared/rpc';

export class TabOutbox {
  private ready = false;
  /** The last `character` push sent, by session, as serialised. */
  private readonly lastCharacter = new Map<string, string>();

  /** The tab's bridge is listening. */
  markReady(): void {
    this.ready = true;
  }

  /** Whether `message`, serialised as `text`, goes to the tab now. */
  admits(message: RpcOutbound, text: string): boolean {
    if (message.k === 'reply') return true;
    if (!this.ready) return false;
    if (message.c !== Push.character) return true;
    const session = sessionOf(message.p);
    if (session === null) return true;
    if (this.lastCharacter.get(session) === text) return false;
    this.lastCharacter.set(session, text);
    return true;
  }
}

/** The session a push is about, where its payload names one (`{ session, payload }`). */
function sessionOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const session = (payload as Record<string, unknown>)['session'];
  return typeof session === 'string' ? session : null;
}
