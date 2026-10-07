/**
 * The desktop bridge as the window uses it: the preload's `WireApi`, with
 * every push parsed from the JSON text main sent (`PUSH_METHODS` says why the
 * text crosses the context bridge unparsed). Every other method is the
 * preload's own, passed through.
 */
import {
  PUSH_METHODS,
  type IpcApi,
  type PushMethod,
  type PushText,
  type WireApi
} from '@shared/ipc';

type TextSubscribe = (handler: (text: PushText) => void) => () => void;

/** A push subscription that hands its handler the parsed payload. */
const parsed =
  (subscribe: TextSubscribe) =>
  (handler: (payload: never) => void): (() => void) =>
    subscribe((text) => handler(JSON.parse(text) as never));

export function fromWire(wire: WireApi): IpcApi {
  // One entry per listed push, each of the shape its `IpcApi` member declares.
  const pushes = Object.fromEntries(
    PUSH_METHODS.map((method) => [method, parsed(wire[method])])
  ) as unknown as Pick<IpcApi, PushMethod>;
  return { ...wire, ...pushes };
}
