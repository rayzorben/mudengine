/**
 * When a message goes to one browser tab (todo 836). A reply always goes.
 * A push waits until the tab says its bridge is listening (`Send.clientReady`):
 * sent before, it was dropped by a bridge with no listener, and the replay the
 * ready message starts covers what it would have carried. A repeated
 * `character` is the patch that changes nothing (`PushPatcher`).
 */
import type { RpcOutbound } from '../../../shared/rpc';

export class TabOutbox {
  private ready = false;

  /** The tab's bridge is listening. */
  markReady(): void {
    this.ready = true;
  }

  /** Whether `message` goes to the tab now. */
  admits(message: RpcOutbound): boolean {
    return message.k === 'reply' || this.ready;
  }
}
