/**
 * Leading a party through a room's own command, and getting it back together
 * on the far side (todo 839). A `'portal'` step (`go vortex`) is a `teleport`
 * in the room's script, which moves only whoever typed it; GreaterMUD also
 * takes that character out of its party (`TextBlockPart.cs`, `teleport`). A
 * text exit in a compass slot is not one: the server moves followers with the
 * leader (`Exits.SuccessMoveThroughExit`). So before a portal step the leader
 * says `@party <command>`, which MegaMUD acts on only when said in the room;
 * on landing it sends `par`, invites back a member standing here who is out of
 * the party, and holds the walk (`Holds.holdForParty`) until everyone is here
 * and in it, or `party.regroupMinutes` runs out. See `mudengine-automation` ›
 * parts/remotes.md.
 */
import { t } from '../app/i18n';
import { partyMembers, standingHere, type CharacterState } from '../../shared/character';
import type { Block } from '../../shared/blocks';
import type { AutomationConfig } from '../../shared/config';
import { roomAddress, type Direction, type RoomId } from '../../shared/world';
import type { CommandQueue, Intent } from './CommandQueue';
import { partyListingIntent } from './PartyListing';

export interface PartyRegroupEvents {
  notice?(message: string): void;
  /** `@join` to a member invited back, as MegaMUD's leader sends it behind `invite` (captures/112). */
  askJoin?(member: string, state: CharacterState): void;
}

/** `invite <name>`, one per name however it was asked for: an `@invite` and a regroup are one invitation. */
export function inviteIntent(who: string, reason: string): Intent {
  return {
    command: `invite ${who}`,
    priority: 'user',
    coalesceKey: `remote:invite:${who.toLowerCase()}`,
    reason
  };
}

/** A relayed step: where it leaves from and lands, who was in the party, and whether the say went. */
interface Crossing {
  from: RoomId | null;
  to: RoomId;
  members: string[];
  said: boolean;
}

/** Waiting on the far side for `members`, each by name as the party listing printed it. */
interface Gathering {
  /** The room landed in: the wait is for this room, and walking out of it ends it. */
  at: RoomId;
  members: string[];
  /** Lower-cased names invited back this time, so each is invited once. */
  invited: Set<string>;
  /** Whether a party listing has arrived since landing: before it, the roster is the old room's. */
  listed: boolean;
}

export class PartyRegroup {
  private crossing: Crossing | null = null;
  private gathering: Gathering | null = null;
  /** The wait's bound, armed at the portal step; null while the walk is not held for the party. */
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private config: AutomationConfig,
    private readonly queue: CommandQueue,
    private readonly events: PartyRegroupEvents = {}
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
  }

  /**
   * Whether the walk stands still for the party: from the portal step, not the
   * landing, because `SessionManager` hands a state to the walker before
   * `Remotes`, so the landing's next step is decided before `land` runs. Never
   * in the room being left, where a fight may have recalled the step itself.
   */
  regrouping(state: CharacterState): boolean {
    if (this.timer === null) return false;
    return this.crossing === null || roomAddress(state.room) !== this.crossing.from;
  }

  /**
   * A step's command is about to be queued. The say goes first in the same
   * band, so it reaches the wire ahead of the step and the followers hear it in
   * the room they are about to be left in. Only a member standing here hears it.
   */
  stepping(
    command: string,
    direction: Direction | 'portal',
    to: RoomId,
    state: CharacterState
  ): void {
    if (direction !== 'portal') return;
    const { enabled, party } = this.config;
    if (!enabled || !party.relayPortals || state.party.following !== null) return;
    const from = roomAddress(state.room);
    // The same step sent again after a fight recalled it: the party already heard it.
    const again = this.crossing;
    if (again !== null && again.said && again.from === from && again.to === to) return;
    const here = standingHere(state);
    const members = partyMembers(state).filter((member) => here.has(member.toLowerCase()));
    if (members.length === 0) return;
    this.end();
    const crossing: Crossing = { from, to, members, said: false };
    this.crossing = crossing;
    this.queue.enqueue({
      command: `.@party ${command}`,
      priority: 'movement',
      reason: t('automation.party.reasonRelay', { command }),
      onSent: () => {
        crossing.said = true;
      }
    });
    const minutes = party.regroupMinutes;
    if (minutes <= 0) return;
    this.events.notice?.(
      t('automation.party.regrouping', { minutes, members: members.join(', ') })
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      this.end();
      this.events.notice?.(
        t('automation.party.regroupGaveUp', { minutes, members: members.join(', ') })
      );
    }, minutes * 60_000);
  }

  onBlock(block: Block): void {
    if (this.gathering === null) return;
    if (block.type === 'party-roster' || block.type === 'party-alone') this.gathering.listed = true;
  }

  onCharacter(state: CharacterState): void {
    const here = roomAddress(state.room);
    if (here === null) return;
    if (this.crossing !== null) {
      if (here === this.crossing.to) this.land(here, this.crossing.members);
      else if (here !== this.crossing.from) this.leave();
      return;
    }
    if (this.gathering === null) return;
    if (here !== this.gathering.at) this.leave();
    else this.gather(this.gathering, state);
  }

  reset(): void {
    this.end();
  }

  dispose(): void {
    this.end();
  }

  private land(at: RoomId, members: string[]): void {
    this.crossing = null;
    this.gathering = { at, members, invited: new Set(), listed: false };
    this.queue.enqueue(partyListingIntent(this.config));
  }

  /** Somewhere the portal does not lead: a scatter, or the player walking on by hand. */
  private leave(): void {
    const held = this.timer !== null;
    this.end();
    if (held) this.events.notice?.(t('automation.party.regroupLeft'));
  }

  private gather(gathering: Gathering, state: CharacterState): void {
    if (!gathering.listed) return;
    const joined = new Set(partyMembers(state).map((name) => name.toLowerCase()));
    const here = standingHere(state);
    const missing = gathering.members.filter((member) => {
      const key = member.toLowerCase();
      return !joined.has(key) || !here.has(key);
    });
    if (missing.length === 0) {
      const held = this.timer !== null;
      this.end();
      if (held) this.events.notice?.(t('automation.party.regrouped'));
      return;
    }
    for (const member of missing) {
      const key = member.toLowerCase();
      if (joined.has(key) || !here.has(key) || gathering.invited.has(key)) continue;
      gathering.invited.add(key);
      this.events.notice?.(t('automation.party.reinvited', { member }));
      this.queue.enqueue(inviteIntent(member, t('automation.party.reasonReinvite', { member })));
      this.events.askJoin?.(member, state);
    }
  }

  private end(): void {
    this.crossing = null;
    this.gathering = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
