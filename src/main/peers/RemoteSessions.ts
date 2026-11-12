/**
 * The controller's half of remote control as a whole window (todo
 * 20261031-1156-01): each character another player gives one of this
 * install's characters control of, once opened, is a session in this client
 * (`remoteSessionId`), on the rail beside this install's own. Every call a
 * window makes about it is sent to the sharer's client and answered there
 * (`RelayIntercept`, by the rules in `peerRelay.ts`); every push the sharer's
 * client sends about it is put back together and pushed to the windows here
 * as though this client had made it. Nothing about it is kept on disk.
 *
 * A character is opened only from a fresh sheet its player accepted under a
 * pinned key, whose sharer gives the character it is shared with `control`.
 * A call unanswered in `answerMs` is refused; nothing waits forever.
 */
import {
  ATTACHED_PUSHES,
  Invoke,
  Push,
  type SessionId,
  type SessionSummary
} from '../../shared/ipc';
import {
  isRemoteSessionId,
  nextRelayNumber,
  readRelayMessage,
  relayAllows,
  relayParts,
  relayRule,
  RelayJoin,
  remoteSessionId,
  SHARED_SESSION
} from '../../shared/peerRelay';
import { PushPatches } from '../../shared/patches';
import {
  newestSheets,
  peerKeyText,
  type KeyOffer,
  type PeerKey,
  type SharedSheet
} from '../../shared/peers';
import { playerKey } from '../../shared/players';
import { asRpcFrame, trimArgs, type RpcInvoke, type RpcSend } from '../../shared/rpc';
import { CONNECTION_PHASES, IDLE_CONNECTION, type ConnectionState } from '../../shared/types';
import { isRecord, memberOf } from '../../shared/values';
import { t } from '../app/i18n';
import type { Caller } from '../host/Host';
import type { WindowRegistry } from '../windows/WindowRegistry';
import type { ControllingFrame, PeerLink, Watched } from './PeerLink';
import type { RelayIntercept } from './relayTransport';

export interface RemoteSessionsDeps {
  /** `id`'s claim, while claimed. */
  peerOf(id: SessionId): PeerKey | null;
  /** The sheets `id`'s player accepted, fresh. */
  sheetsFor(id: SessionId): readonly SharedSheet[];
  /** `id`'s name on the rail. */
  nameOf(id: SessionId): string;
  link: Pick<PeerLink, 'watch' | 'call'>;
  windows: Pick<WindowRegistry, 'attach' | 'detach' | 'toAttached' | 'toAll'>;
  /** Said in `id`'s console. */
  notice(id: SessionId, message: string): void;
  /** Which characters are controlled changed: the rosters and the share views. */
  changed(): void;
  /** The client's log, for a message from the sharer that could not be read. */
  say(message: string): void;
  answerMs(): number;
}

interface Pending {
  readonly settle: (value: unknown) => void;
  readonly fail: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Remote {
  readonly id: SessionId;
  readonly via: SessionId;
  readonly peer: PeerKey;
  readonly watched: Watched;
  readonly join: RelayJoin;
  readonly patches: PushPatches;
  readonly pending: Map<number, Pending>;
  state: ConnectionState;
  /** The next call's id and message number. */
  next: number;
}

/** The accent a controlled character wears, so it is never taken for one of this install's. */
const REMOTE_ACCENT = 'violet';

export class RemoteSessions implements RelayIntercept {
  private readonly remotes = new Map<SessionId, Remote>();

  constructor(private readonly deps: RemoteSessionsDeps) {}

  /** `via` opens `name`, a character shared with it; the refusal, or null. */
  open(via: SessionId, name: string): string | null {
    const peer = this.deps.peerOf(via);
    if (peer === null) return t('peers.control.notSharing');
    const shared = newestSheets(this.deps.sheetsFor(via)).get(playerKey(name));
    if (shared === undefined || !shared.control) return t('peers.control.notOffered', { name });
    const id = remoteSessionId(via, shared.from.name);
    if (this.remotes.has(id)) return null;
    const watched = { from: shared.from, key: shared.key };
    // The gateway's frames name the sharer and not which of this install's characters watches it.
    if (this.remoteOf(watched.from, watched.key) !== null) {
      return t('peers.control.otherControls', { name });
    }
    this.closeVia(via);
    this.remotes.set(id, {
      id,
      via,
      peer,
      watched,
      join: new RelayJoin(),
      patches: new PushPatches(),
      pending: new Map(),
      state: IDLE_CONNECTION,
      next: 1
    });
    this.deps.link.watch(peer, watched);
    this.deps.changed();
    return null;
  }

  /** Control of `id` ends here. */
  close(id: SessionId): void {
    const remote = this.remotes.get(id);
    if (remote === undefined) return;
    this.drop(remote, t('peers.control.closed'));
    this.deps.link.watch(remote.peer, null);
  }

  /** Whatever `via` controls, closed. */
  closeVia(via: SessionId): void {
    for (const remote of [...this.remotes.values()]) if (remote.via === via) this.close(remote.id);
  }

  /** The character `via` controls, as its window shows it. */
  view(via: SessionId): KeyOffer | null {
    for (const remote of this.remotes.values()) {
      if (remote.via === via) return { name: remote.watched.from.name, key: remote.watched.key };
    }
    return null;
  }

  /** The controlled characters, as the rail lists them. */
  summaries(): SessionSummary[] {
    return [...this.remotes.values()].map((remote) => ({
      id: remote.id,
      name: remote.watched.from.name,
      server: remote.watched.from.realm,
      accent: REMOTE_ACCENT,
      state: remote.state,
      retrying: false,
      remote: { via: remote.via, viaName: this.deps.nameOf(remote.via) }
    }));
  }

  intercept(
    kind: 'invoke' | 'send',
    channel: string,
    caller: Caller,
    args: readonly unknown[]
  ): { readonly value: unknown } | null {
    const rule = relayRule(kind, channel);
    if (rule.kind === 'local') return null;
    const id = args[rule.at];
    if (typeof id !== 'string' || !isRemoteSessionId(id)) return null;
    const remote = this.remotes.get(id);
    const refuse = (why: string): { value: unknown } =>
      kind === 'invoke' ? { value: Promise.reject(new Error(why)) } : { value: undefined };
    if (remote === undefined) return refuse(t('peers.relay.notControlling'));
    switch (rule.kind) {
      case 'refused':
        return refuse(t('peers.relay.refused'));
      case 'close':
        this.close(id);
        return { value: kind === 'invoke' ? Promise.resolve(null) : undefined };
      case 'forward': {
        if (!relayAllows(rule, args)) return refuse(t('peers.relay.refused'));
        if (channel === Invoke.attach) this.deps.windows.attach(caller.windowId, id);
        if (channel === Invoke.detach) this.deps.windows.detach(caller.windowId, id);
        const placed = [...args];
        placed[rule.at] = SHARED_SESSION;
        return { value: this.call(remote, kind, channel, trimArgs(placed)) };
      }
      default: {
        const never: never = rule;
        return never;
      }
    }
  }

  /** A frame from the gateway about a character this install controls. */
  heard(frame: ControllingFrame): void {
    const remote = this.remoteOf(frame.from, frame.key);
    if (remote === null) return;
    switch (frame.k) {
      case 'feed':
        return this.fed(remote, frame.part);
      case 'released': {
        const name = frame.from.name;
        const said =
          frame.why === 'stopped'
            ? t('peers.control.releasedStopped', { name })
            : frame.why === 'unshared'
              ? t('peers.control.releasedUnshared', { name })
              : t('peers.control.releasedLeft', { name });
        // The link would watch again on its next claim, bringing back a control nobody opened.
        this.deps.link.watch(remote.peer, null);
        this.deps.notice(remote.via, said);
        this.drop(remote, said);
        return;
      }
      default: {
        const never: never = frame;
        return never;
      }
    }
  }

  /** The claims changed: a character no longer claimed controls nothing; the rest watch again. */
  reclaimed(): void {
    for (const remote of [...this.remotes.values()]) {
      const peer = this.deps.peerOf(remote.via);
      if (peer !== null && peerKeyText(peer) === peerKeyText(remote.peer)) {
        this.deps.link.watch(peer, remote.watched);
        continue;
      }
      this.drop(remote, t('peers.control.closed'));
    }
  }

  /**
   * The link dropped: every control ends, since the sharer's client made its
   * window afresh and nothing here is attached to it.
   */
  lost(): void {
    for (const remote of [...this.remotes.values()]) {
      this.deps.notice(
        remote.via,
        t('peers.control.lostControl', { name: remote.watched.from.name })
      );
      this.drop(remote, t('peers.control.noLink'));
    }
  }

  forget(via: SessionId): void {
    this.closeVia(via);
  }

  private call(
    remote: Remote,
    kind: 'invoke' | 'send',
    channel: string,
    args: unknown[]
  ): Promise<unknown> | undefined {
    const n = remote.next;
    remote.next = nextRelayNumber(n);
    const message: RpcInvoke | RpcSend =
      kind === 'invoke'
        ? { k: 'invoke', q: 1, id: n, c: channel, a: args }
        : { k: 'send', q: 1, c: channel, a: args };
    const sent = [...relayParts(n, JSON.stringify(message))].every((part) =>
      this.deps.link.call(remote.peer, part)
    );
    if (kind === 'send') return undefined;
    if (!sent) return Promise.reject(new Error(t('peers.control.noLink')));
    return new Promise((settle, fail) => {
      const timer = setTimeout(() => {
        remote.pending.delete(n);
        fail(new Error(t('peers.control.noAnswer')));
      }, this.deps.answerMs());
      timer.unref?.();
      remote.pending.set(n, { settle, fail, timer });
    });
  }

  private fed(remote: Remote, part: Parameters<RelayJoin['take']>[0]): void {
    const text = remote.join.take(part);
    if (text === null) return;
    if (text === 'too-long') {
      this.deps.say(
        `remote control: a message about ${remote.watched.from.name} was too long, and dropped`
      );
      return;
    }
    const frame = readRelayMessage(text, asRpcFrame);
    if (frame === null || frame.k === 'welcome' || frame.k === 'beat') {
      this.deps.say(`remote control: a message about ${remote.watched.from.name} did not read`);
      return;
    }
    switch (frame.k) {
      case 'reply': {
        const pending = remote.pending.get(frame.id);
        if (pending === undefined) return;
        remote.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if ('e' in frame) pending.fail(new Error(frame.e));
        else pending.settle(frame.r);
        return;
      }
      case 'push':
        return this.pushed(remote, frame.c, frame.p);
      case 'patch': {
        const whole = remote.patches.apply(frame);
        return this.pushed(remote, whole.c, whole.p);
      }
      default: {
        const never: never = frame;
        return never;
      }
    }
  }

  /** A push about the controlled character, pushed here under its session. */
  private pushed(remote: Remote, channel: string, payload: unknown): void {
    if (!isRecord(payload) || payload['session'] !== SHARED_SESSION) return;
    const here = { ...payload, session: remote.id };
    // The rail's summary reads the phase alone; the whole state goes on to the windows as pushed.
    const state =
      channel === Push.state && isRecord(payload['payload']) ? payload['payload'] : null;
    const phase = state === null ? null : memberOf(state['phase'], CONNECTION_PHASES);
    if (phase !== null && phase !== remote.state.phase) {
      remote.state = { ...remote.state, phase };
      this.deps.changed();
    }
    if (ATTACHED_PUSHES.has(channel)) {
      this.deps.windows.toAttached(channel, here as { session: SessionId; payload: unknown });
    } else this.deps.windows.toAll(channel, here);
  }

  private drop(remote: Remote, why: string): void {
    this.remotes.delete(remote.id);
    for (const pending of remote.pending.values()) {
      clearTimeout(pending.timer);
      pending.fail(new Error(why));
    }
    remote.pending.clear();
    remote.join.clear();
    this.deps.changed();
  }

  /** The session controlling `from` under `key`. */
  private remoteOf(from: PeerKey, key: string): Remote | null {
    for (const remote of this.remotes.values()) {
      if (remote.watched.key === key && peerKeyText(remote.watched.from) === peerKeyText(from)) {
        return remote;
      }
    }
    return null;
  }
}
