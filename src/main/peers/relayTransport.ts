/**
 * The host's transport as remote control needs it (todo 20261031-1156-01):
 * every handler kept by channel, so a call relayed from a controlling client
 * runs through the same handler a window's does (`RelayDesk`); and a call a
 * window makes about a character this client controls answered by that
 * character's own client (`RemoteSessions`) instead of here. Composed once,
 * in `client.ts`, in front of the host's own transport.
 */
import type { Caller, Handler, Transport } from '../host/Host';

/** The handlers registered, by channel: `invoke` for `Invoke.*`, `send` for `Send.*`. */
export interface HandlerTable {
  handler(kind: 'invoke' | 'send', channel: string): Handler | undefined;
}

/** A call about a character controlled from here, taken over; null leaves it to its handler. */
export interface RelayIntercept {
  intercept(
    kind: 'invoke' | 'send',
    channel: string,
    caller: Caller,
    args: readonly unknown[]
  ): { readonly value: unknown } | null;
}

export interface RelayTransport {
  readonly transport: Transport;
  readonly handlers: HandlerTable;
}

/** `inner` with each handler kept, and each call first offered to `relay()`. */
export function relayTransport(
  inner: Transport,
  relay: () => RelayIntercept | null
): RelayTransport {
  const kept = { invoke: new Map<string, Handler>(), send: new Map<string, Handler>() };
  const wrapped =
    (kind: 'invoke' | 'send', channel: string, handler: Handler): Handler =>
    (caller, ...args) => {
      const taken = relay()?.intercept(kind, channel, caller, args) ?? null;
      return taken === null ? handler(caller, ...args) : taken.value;
    };
  return {
    transport: {
      handle(channel, handler) {
        kept.invoke.set(channel, handler);
        inner.handle(channel, wrapped('invoke', channel, handler));
      },
      on(channel, listener) {
        kept.send.set(channel, listener);
        inner.on(channel, wrapped('send', channel, listener));
      }
    },
    handlers: { handler: (kind, channel) => kept[kind].get(channel) }
  };
}
