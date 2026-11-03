/**
 * The controller's half of remote control (todo 20261031-1156-01): which
 * shared character each of this install's characters is controlling, the
 * terminal text it has been sent, and each action sent and waiting for its
 * answer. A character is opened only from a fresh sheet its player accepted
 * under a pinned key, whose sharer gives this character `control`. An answer
 * that does not come within `answerMs`, or that this build does not read, is
 * a refusal said as such; nothing waits forever.
 */
import type { SessionId } from '../../shared/ipc';
import {
  actionFrame,
  asControlAnswer,
  type ControlAction,
  type ControlAnswer
} from '../../shared/peerControl';
import {
  newestSheets,
  peerKeyText,
  type KeyOffer,
  type PeerKey,
  type SharedSheet
} from '../../shared/peers';
import { playerKey } from '../../shared/players';
import { t } from '../app/i18n';
import type { ControllingFrame, PeerLink, Watched } from './PeerLink';

export interface ControllingDeps {
  /** `id`'s claim, while claimed. */
  peerOf(id: SessionId): PeerKey | null;
  /** The sheets `id`'s player accepted, fresh. */
  sheetsFor(id: SessionId): readonly SharedSheet[];
  link: Pick<PeerLink, 'watch' | 'sendAction'>;
  /** Text the controlled character's terminal painted, for `id`'s window. */
  text(id: SessionId, text: string): void;
  notice(id: SessionId, message: string): void;
  /** What `id` controls changed, for its window. */
  changed(): void;
  /** The text kept, as the console holds a short scroll. */
  backlogChars(): number;
  answerMs(): number;
}

interface Pending {
  readonly id: SessionId;
  readonly settle: (answer: ControlAnswer) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Control {
  readonly peer: PeerKey;
  readonly watched: Watched;
  text: string;
}

export class Controlling {
  private readonly controls = new Map<SessionId, Control>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;

  constructor(private readonly deps: ControllingDeps) {}

  /** `id` opens `name`'s terminal; the refusal, or null. */
  open(id: SessionId, name: string): string | null {
    const peer = this.deps.peerOf(id);
    if (peer === null) return t('peers.control.notSharing');
    const shared = newestSheets(this.deps.sheetsFor(id)).get(playerKey(name));
    if (shared === undefined || !shared.control) return t('peers.control.notOffered', { name });
    const watched = { from: shared.from, key: shared.key };
    const held = this.controls.get(id);
    if (held !== undefined && sameWatch(held.watched, watched)) return null;
    // The gateway's frames name the sharer and not which of this install's characters watches it.
    const other = this.controllerOf(watched.from, watched.key);
    if (other !== null) return t('peers.control.otherControls', { name });
    if (held !== undefined) this.close(id);
    this.controls.set(id, { peer, watched, text: '' });
    this.deps.link.watch(peer, watched);
    this.deps.changed();
    return null;
  }

  close(id: SessionId): void {
    const control = this.controls.get(id);
    if (control === undefined) return;
    this.controls.delete(id);
    this.deps.link.watch(control.peer, null);
    this.settleAll(id, t('peers.control.closed'));
    this.deps.changed();
  }

  /** The character `id` controls, as its window shows it. */
  view(id: SessionId): KeyOffer | null {
    const control = this.controls.get(id);
    return control === undefined
      ? null
      : { name: control.watched.from.name, key: control.watched.key };
  }

  /** The terminal text `id` has been sent of the character it controls. */
  backlog(id: SessionId): string {
    return this.controls.get(id)?.text ?? '';
  }

  /** One action to the character `id` controls, answered by its sharer or refused here. */
  act(id: SessionId, action: ControlAction): Promise<ControlAnswer> {
    const control = this.controls.get(id);
    if (control === undefined) {
      return Promise.resolve({ r: 'refused', why: t('peers.control.notControlling') });
    }
    const n = this.nextId;
    this.nextId = (this.nextId + 1) % 2 ** 31;
    if (!this.deps.link.sendAction(control.peer, n, actionFrame(action))) {
      return Promise.resolve({ r: 'refused', why: t('peers.control.noLink') });
    }
    return new Promise((settle) => {
      const timer = setTimeout(() => {
        this.pending.delete(n);
        settle({ r: 'refused', why: t('peers.control.noAnswer') });
      }, this.deps.answerMs());
      timer.unref?.();
      this.pending.set(n, { id, settle, timer });
    });
  }

  heard(frame: ControllingFrame): void {
    const id = this.controllerOf(frame.from, frame.key);
    if (id === null) return;
    switch (frame.k) {
      case 'text': {
        const control = this.controls.get(id)!;
        control.text = (control.text + frame.text).slice(-this.deps.backlogChars());
        this.deps.text(id, frame.text);
        return;
      }
      case 'acted': {
        const pending = this.pending.get(frame.id);
        if (pending === undefined || pending.id !== id) return;
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        pending.settle(
          asControlAnswer(frame.answer) ?? { r: 'refused', why: t('peers.control.unreadAnswer') }
        );
        return;
      }
      case 'released': {
        this.controls.delete(id);
        const name = frame.from.name;
        const said =
          frame.why === 'stopped'
            ? t('peers.control.releasedStopped', { name })
            : frame.why === 'unshared'
              ? t('peers.control.releasedUnshared', { name })
              : t('peers.control.releasedLeft', { name });
        this.deps.notice(id, said);
        this.settleAll(id, said);
        this.deps.changed();
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
    for (const [id, control] of [...this.controls]) {
      const peer = this.deps.peerOf(id);
      if (peer !== null && peerKeyText(peer) === peerKeyText(control.peer)) {
        this.deps.link.watch(peer, control.watched);
        continue;
      }
      this.controls.delete(id);
      this.settleAll(id, t('peers.control.closed'));
      this.deps.changed();
    }
  }

  /** The link dropped: what was waiting for an answer is refused; the watch is made again on the next claim. */
  lost(): void {
    for (const id of this.controls.keys()) this.settleAll(id, t('peers.control.noLink'));
  }

  forget(id: SessionId): void {
    this.close(id);
  }

  /** The session of this install controlling `from` under `key`. */
  private controllerOf(from: PeerKey, key: string): SessionId | null {
    for (const [id, control] of this.controls) {
      if (sameWatch(control.watched, { from, key })) return id;
    }
    return null;
  }

  private settleAll(id: SessionId, why: string): void {
    for (const [n, pending] of [...this.pending]) {
      if (pending.id !== id) continue;
      this.pending.delete(n);
      clearTimeout(pending.timer);
      pending.settle({ r: 'refused', why });
    }
  }
}

const sameWatch = (a: Watched, b: Watched): boolean =>
  a.key === b.key && peerKeyText(a.from) === peerKeyText(b.from);
