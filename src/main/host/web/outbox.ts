/**
 * What goes to one browser tab, and when (todo 836). A reply always goes.
 * A push waits until the tab says its bridge is listening (`Send.clientReady`):
 * sent before, it was dropped by a bridge with no listener, and the replay the
 * ready message starts covers what it would have carried. A `character` push
 * the tab already holds is not sent again (`RepeatedCharacters`).
 */
import type { RpcOutbound } from '../../../shared/rpc';
import { RepeatedCharacters } from '../repeats';

export class TabOutbox {
  private ready = false;
  private readonly repeats = new RepeatedCharacters();

  /** The tab's bridge is listening. */
  markReady(): void {
    this.ready = true;
  }

  /** Whether `message`, serialised as `text`, goes to the tab now. */
  admits(message: RpcOutbound, text: string): boolean {
    if (message.k === 'reply') return true;
    if (!this.ready) return false;
    return !this.repeats.repeats(message.c, message.p, text);
  }
}
