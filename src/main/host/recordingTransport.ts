/**
 * Every call a window or a controlling client makes, written to the session's
 * activity record before its handler runs (`mudengine-session` › *Everything
 * that can change state is recorded*).
 *
 * A call is recorded whether or not its handler acts on it. Soul showed a loop
 * running and the stop button, and the logs could not say whether Start had
 * been pressed, refused or never arrived. Recorded ahead of the handler, a
 * call that throws or declines still shows that it was made.
 *
 * Arguments are summarised, never copied: a string is clipped, an object is
 * its keys, and the typed line of a session is its length only. The command a
 * typed line becomes is recorded by `SessionDebug.out` after
 * `Publisher.reportable` has masked a password, so this adds no second
 * redactor.
 */
import { Invoke, Send } from '../../shared/ipc';
import { clip } from '../../shared/debug';
import { errorMessage } from '../../shared/values';
import type { Caller, Handler, Transport } from './Host';

/** Where a recorded call goes: a session's trace, or every session's when it names none. */
export type ActionRecorder = (session: string, tag: string, text: string) => void;

/**
 * Calls that only read, or only describe a window, and happen many times a
 * second. Everything not listed is recorded: a new channel is logged until
 * someone says it is noise.
 */
const QUIET: ReadonlySet<string> = new Set([
  Send.resize,
  Send.debugFeed,
  Send.diagnostics,
  Invoke.getState,
  Invoke.getTelnetLog,
  Invoke.getLines,
  Invoke.getDebug,
  Invoke.getUnread,
  Invoke.getCharacter,
  Invoke.getWalk,
  Invoke.getAutomation,
  Invoke.getConfig,
  Invoke.getInternal,
  Invoke.listSessions,
  Invoke.listProfiles,
  Invoke.listLoops,
  Invoke.recentLoops,
  Invoke.loopCatalogue,
  Invoke.listExtensions,
  Invoke.backscrollPage,
  Invoke.talkPage,
  Invoke.portrait,
  Invoke.roomArt,
  Invoke.shares,
  Invoke.routeTo,
  Invoke.routeBetween,
  Invoke.walkPages,
  Invoke.walkPage,
  Invoke.previewAreaSearch,
  Invoke.previewMobFind,
  Invoke.cashRunTokens,
  Invoke.inheritedMobRules,
  Invoke.readCardLayout,
  Invoke.settingsSnapshot,
  Invoke.pasteText
]);

/** What a person typed: its length is recorded, never its text, which may be a password at a prompt. */
const TYPED: ReadonlySet<string> = new Set([Send.input, Send.macro, Send.lostEnter]);

/** One argument, short and free of what a person typed. */
function summarise(value: unknown, typed: boolean): string {
  if (typeof value === 'string')
    return typed ? `(${value.length} chars)` : JSON.stringify(clip(value, 80));
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === 'object') return `{${Object.keys(value).join(',')}}`;
  return String(value);
}

/** The text of one recorded call. */
export function describeCall(channel: string, args: readonly unknown[]): string {
  const rest = args.map((arg) => summarise(arg, TYPED.has(channel)));
  return [channel, ...rest].join(' ');
}

/** `inner` with each call recorded first. */
export function recordingTransport(
  inner: Transport,
  record: ActionRecorder,
  sessionOf: (candidate: unknown) => string,
  onProblem: (message: string) => void
): Transport {
  const recorded =
    (channel: string, handler: Handler): Handler =>
    (caller: Caller, ...args: unknown[]) => {
      if (!QUIET.has(channel)) {
        // A record that cannot be written never stops the call it describes.
        try {
          const session = sessionOf(args[0]);
          record(session, 'call', describeCall(channel, session === '' ? args : args.slice(1)));
        } catch (error) {
          onProblem(`Could not record ${channel}: ${errorMessage(error)}`);
        }
      }
      return handler(caller, ...args);
    };
  return {
    handle: (channel, handler) => inner.handle(channel, recorded(channel, handler)),
    on: (channel, listener) => inner.on(channel, recorded(channel, listener))
  };
}
