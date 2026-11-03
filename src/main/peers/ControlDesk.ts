/**
 * The sharer's half of remote control (todo 20261031-1156-01): who is
 * controlling each of this install's characters, their actions run or
 * refused, and the terminal text sent to them. Every frame is checked
 * against the character's own row for that player, the level at `control`
 * and the key pinned, whatever the gateway let through, so lowering a share
 * ends control on the next frame. Stop ends every controller of the
 * character until its player turns Allow remote control off and on again.
 * Each action, each refusal and each start and end is said in the
 * character's console; a refusal is written to its safety trace as well.
 */
import type { SafetyDecision } from '../../shared/automation';
import type { SessionId } from '../../shared/ipc';
import type { PeerGrant } from '../../shared/peerGrant';
import { asControlAction, type ControlAction, type ControlAnswer } from '../../shared/peerControl';
import { peerKeyText, type PeerKey } from '../../shared/peers';
import { PEER_MOST_TEXT, type Listener } from '../../shared/peerWire';
import { playerKey } from '../../shared/players';
import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';
import type { ControlledFrame, PeerLink } from './PeerLink';

/** A character this install claims, as control reads it. */
export interface ControlledCharacter {
  readonly id: SessionId;
  readonly peer: PeerKey;
  /** Its row for `name`, or null for none. */
  grantFor(name: string): PeerGrant | null;
}

export interface ControlDeskDeps {
  /** The session claiming `peer`, or null. */
  characterOf(peer: PeerKey): ControlledCharacter | null;
  /** The session `id` while it is claimed, or null. */
  characterAt(id: SessionId): ControlledCharacter | null;
  run(id: SessionId, action: ControlAction, by: string): Promise<ControlAnswer>;
  link: Pick<PeerLink, 'text' | 'answer' | 'release'>;
  notice(id: SessionId, message: string): void;
  refused(id: SessionId, decision: SafetyDecision): void;
  /** Who controls a character changed, for its window. */
  changed(): void;
  /** The terminal text kept for a controller who starts watching. */
  backlogChars(): number;
  now(): number;
}

interface Desk {
  peer: PeerKey;
  controllers: Listener[];
  /** Names stopped by the player, by `playerKey`, until the row leaves `control`. */
  stopped: Set<string>;
  backlog: string;
}

/** The text in frames the gateway takes. */
function* pieces(text: string): Generator<string> {
  for (let at = 0; at < text.length; at += PEER_MOST_TEXT)
    yield text.slice(at, at + PEER_MOST_TEXT);
}

/** What an action did, as the character's player reads it. */
function described(action: ControlAction): string {
  switch (action.a) {
    case 'line':
      return t('peers.control.what.line', { text: action.text });
    case 'move':
      return t('peers.control.what.move', { dir: action.dir });
    case 'rest':
      return t('peers.control.what.rest');
    case 'stop':
      return t('peers.control.what.stop');
    case 'play':
      return action.loop === null
        ? t('peers.control.what.playStopped')
        : t('peers.control.what.play', { loop: action.loop });
    case 'switch':
      return action.on
        ? t('peers.control.what.switchOn', { name: action.name })
        : t('peers.control.what.switchOff', { name: action.name });
    default: {
      const never: never = action;
      return never;
    }
  }
}

export class ControlDesk {
  private readonly desks = new Map<SessionId, Desk>();

  constructor(private readonly deps: ControlDeskDeps) {}

  heard(frame: ControlledFrame): void {
    const character = this.deps.characterOf(frame.peer);
    switch (frame.k) {
      case 'controllers':
        this.controllers(character, frame.peer, frame.to);
        return;
      case 'act':
        void this.act(character, frame.peer, frame.by, frame.id, frame.action);
        return;
      default: {
        const never: never = frame;
        return never;
      }
    }
  }

  /** What the character's terminal painted: kept, and sent while someone controls it. */
  painted(id: SessionId, text: string): void {
    const desk = this.desks.get(id);
    if (desk === undefined || text.length === 0) return;
    const most = this.deps.backlogChars();
    desk.backlog = (desk.backlog + text).slice(-most);
    if (desk.controllers.length === 0) return;
    for (const piece of pieces(text)) this.deps.link.text(desk.peer, piece, null);
  }

  /** The players controlling `id` now. */
  controlledBy(id: SessionId): string[] {
    return this.desks.get(id)?.controllers.map((each) => each.name) ?? [];
  }

  /** The player pressed Stop: every controller of `id` ends, and stays out until the row is set again. */
  stop(id: SessionId): void {
    const desk = this.desks.get(id);
    if (desk === undefined || desk.controllers.length === 0) return;
    const names = desk.controllers.map((each) => each.name);
    for (const controller of desk.controllers) {
      desk.stopped.add(playerKey(controller.name));
      this.deps.link.release(desk.peer, controller);
    }
    desk.controllers = [];
    this.deps.notice(id, t('peers.control.stopped', { names: names.join(', ') }));
    this.deps.changed();
  }

  /**
   * The claims or the rows changed: a desk for each claimed character, each
   * controller its row no longer allows ended, and a stop lifted where the row
   * left `control`.
   */
  regrant(ids: readonly SessionId[]): void {
    for (const id of [...this.desks.keys()]) {
      if (!ids.includes(id)) this.desks.delete(id);
    }
    for (const id of ids) {
      const character = this.deps.characterAt(id);
      if (character === null) continue;
      const desk = this.deskOf(character);
      for (const name of [...desk.stopped]) {
        if (character.grantFor(name)?.share !== 'control') desk.stopped.delete(name);
      }
      const kept = desk.controllers.filter((each) => this.allows(character, desk, each));
      for (const gone of desk.controllers.filter((each) => !kept.includes(each))) {
        this.deps.link.release(desk.peer, gone);
        this.deps.notice(id, t('peers.control.ended', { from: gone.name }));
      }
      if (kept.length !== desk.controllers.length) this.deps.changed();
      desk.controllers = kept;
    }
  }

  /** The link dropped: nobody controls anything until the gateway says so again. */
  lost(): void {
    for (const [id, desk] of this.desks) {
      if (desk.controllers.length === 0) continue;
      this.deps.notice(id, t('peers.control.lost'));
      desk.controllers = [];
    }
    this.deps.changed();
  }

  private deskOf(character: ControlledCharacter): Desk {
    const held = this.desks.get(character.id);
    if (held !== undefined && peerKeyText(held.peer) === peerKeyText(character.peer)) return held;
    const desk: Desk = { peer: character.peer, controllers: [], stopped: new Set(), backlog: '' };
    this.desks.set(character.id, desk);
    return desk;
  }

  /** Whether `id`'s row for this controller gives control under its key, and its player has not stopped it. */
  private allows(character: ControlledCharacter, desk: Desk, controller: Listener): boolean {
    const grant = character.grantFor(controller.name);
    return (
      grant !== null &&
      grant.share === 'control' &&
      grant.keys.includes(controller.key) &&
      !desk.stopped.has(playerKey(controller.name))
    );
  }

  private controllers(
    character: ControlledCharacter | null,
    peer: PeerKey,
    to: readonly Listener[]
  ): void {
    if (character === null) {
      for (const each of to) this.deps.link.release(peer, each);
      return;
    }
    const desk = this.deskOf(character);
    const same = (a: Listener, b: Listener): boolean => a.name === b.name && a.key === b.key;
    const allowed = to.filter((each) => this.allows(character, desk, each));
    for (const refused of to.filter((each) => !allowed.includes(each))) {
      this.deps.link.release(peer, refused);
    }
    for (const arrived of allowed.filter(
      (each) => !desk.controllers.some((was) => same(was, each))
    )) {
      this.deps.notice(character.id, t('peers.control.started', { from: arrived.name }));
      for (const piece of pieces(desk.backlog)) this.deps.link.text(peer, piece, arrived);
    }
    for (const gone of desk.controllers.filter((was) => !allowed.some((each) => same(was, each)))) {
      this.deps.notice(character.id, t('peers.control.ended', { from: gone.name }));
    }
    desk.controllers = allowed;
    this.deps.changed();
  }

  private async act(
    character: ControlledCharacter | null,
    peer: PeerKey,
    by: Listener,
    id: number,
    raw: Record<string, unknown>
  ): Promise<void> {
    const answer = (reply: ControlAnswer): void =>
      this.deps.link.answer(peer, by, id, { ...reply });
    if (character === null) return answer({ r: 'refused', why: t('peers.control.notHere') });
    const desk = this.deskOf(character);
    const controlling = desk.controllers.some(
      (each) => each.name === by.name && each.key === by.key
    );
    if (!controlling || !this.allows(character, desk, by)) {
      return answer(this.refuse(character.id, by.name, t('peers.control.notGiven')));
    }
    const read = asControlAction(raw);
    if (!read.ok) {
      const why =
        read.why === 'unknown'
          ? t('peers.control.unknownAction', { name: read.name })
          : read.why === 'version'
            ? t('peers.control.newerAction')
            : t('peers.control.malformed');
      return answer(this.refuse(character.id, by.name, why));
    }
    this.deps.notice(
      character.id,
      t('peers.control.sent', { from: by.name, what: described(read.action) })
    );
    try {
      const reply = await this.deps.run(character.id, read.action, by.name);
      if (reply.r === 'refused') this.refuse(character.id, by.name, reply.why);
      answer(reply);
    } catch (error) {
      answer(this.refuse(character.id, by.name, errorMessage(error)));
    }
  }

  /** Said in the console and the safety trace; the answer the controller is sent. */
  private refuse(id: SessionId, from: string, why: string): ControlAnswer {
    this.deps.notice(id, t('peers.control.refused', { from, why }));
    this.deps.refused(id, {
      at: this.deps.now(),
      action: t('peers.control.action'),
      because: t('peers.control.because', { from }),
      acted: false,
      refused: why
    });
    return { r: 'refused', why };
  }
}
