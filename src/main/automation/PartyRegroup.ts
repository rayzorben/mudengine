/**
 * Leading a party through a way that takes it apart, and getting it back
 * together on the far side (todos 839, 67). A `'portal'` step (`go vortex`)
 * moves only whoever typed it, so the leader says `@party <command>` first;
 * a compass exit whose cast lands in one room moves the followers too, then
 * the spell takes each out of the party (`partyCrossing`). A text exit in a
 * compass slot is neither (`Exits.SuccessMoveThroughExit`). On landing it sends
 * `par`, invites back a member standing here who is out of the party, and
 * holds the walk (`Holds.holdForParty`) until everyone is here and in it, or
 * `party.regroupMinutes` runs out. See `mudengine-automation` › parts/remotes.md.
 */
import { t } from '../app/i18n';
import { partyMembers, standingHere, type CharacterState } from '../../shared/character';
import type { Block } from '../../shared/blocks';
import type { AutomationConfig } from '../../shared/config';
import type { DecisionKind, NoticeSink } from '../../shared/decisionSettings';
import {
  roomAddress,
  scatters,
  type Direction,
  type Landing,
  type RoomId
} from '../../shared/world';
import type { CommandQueue, Intent } from './CommandQueue';
import { partyListingIntent } from './PartyListing';

const REGROUP: DecisionKind = 'party-regroup';

export interface PartyRegroupEvents {
  notice?: NoticeSink;
}

/** `invite <name>`, one per name however it was asked for: an `@invite` and a regroup are one invitation. */
export function inviteIntent(who: string, reason: string, decision: DecisionKind): Intent {
  return {
    command: `invite ${who}`,
    priority: 'user',
    coalesceKey: `remote:invite:${who.toLowerCase()}`,
    reason,
    decision
  };
}

/**
 * How a step takes the party over, on GreaterMUD. `alone`: a room script's
 * `teleport` or an item's landing moves only whoever typed it and drops them
 * from the party (`TextBlockPart.cs`, `teleport`), so the members must be told.
 * `together`: the followers come through the exit with the leader, then the
 * exit's spell lands each in the same room and out of the party (`Spell.cs`,
 * `TeleportRoom`; `CastExit` casts after the move). `apart`: a draw, which
 * lands each member in a room of their own, so there is no room to wait in and
 * the leader only says the party is apart.
 */
export type PartyCrossing = 'alone' | 'together' | 'apart';

export function partyCrossing(
  direction: Direction | 'portal',
  landing: Landing | undefined
): PartyCrossing | null {
  if (direction === 'portal') return 'alone';
  if (landing === undefined) return null;
  return scatters(landing) ? 'apart' : 'together';
}

/** A step regrouped behind: from, to, who was in the party, and whether its say went (`together` owes none). */
interface Crossing {
  from: RoomId | null;
  to: RoomId;
  members: string[];
  said: boolean;
  /**
   * `together` only: the exit's first answer is the room its table names, which
   * the cast moves the character out of at once (`Expectations.hintCast`), so
   * the regroup passes through one room on the way to `to`.
   */
  passing: boolean;
  /** That room, once seen: every state read in it is still on the way. */
  through: RoomId | null;
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
  /** The draw last said to split the party, so a step sent again after a fight says it once; cleared on leaving `from`. */
  private apartAt: { from: RoomId | null; to: RoomId } | null = null;

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
   * A step's command is about to be queued. For `alone` the say goes first in
   * the same band, so it reaches the wire ahead of the step and the followers
   * hear it in the room they are about to be left in. Only a member standing
   * here hears it, or follows through an exit.
   */
  stepping(
    command: string,
    direction: Direction | 'portal',
    to: RoomId,
    state: CharacterState,
    landing?: Landing
  ): void {
    const crossing = partyCrossing(direction, landing);
    if (crossing === null) return;
    const { enabled, party } = this.config;
    if (!enabled || state.party.following !== null) return;
    // The say is `relayPortals`'; a `together` crossing owes none and is regrouped behind regardless.
    if (crossing === 'alone' && !party.relayPortals) return;
    const from = roomAddress(state.room);
    const here = standingHere(state);
    const members = partyMembers(state).filter((member) => here.has(member.toLowerCase()));
    if (members.length === 0) return;
    if (crossing === 'apart') {
      this.apart(from, to, members);
      return;
    }
    // The same step sent again after a fight recalled it: the party already heard it.
    const again = this.crossing;
    if (again !== null && again.said && again.from === from && again.to === to) return;
    this.end();
    const together = crossing === 'together';
    const held: Crossing = { from, to, members, said: together, passing: together, through: null };
    this.crossing = held;
    if (crossing === 'alone') {
      this.queue.enqueue({
        command: `.@party ${command}`,
        priority: 'movement',
        reason: t('automation.party.reasonRelay', { command }),
        decision: 'party-relay-portal',
        onSent: () => {
          held.said = true;
        }
      });
    }
    const minutes = party.regroupMinutes;
    if (minutes <= 0) return;
    this.events.notice?.(
      t('automation.party.regrouping', { minutes, members: members.join(', ') }),
      REGROUP
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      this.end();
      this.events.notice?.(
        t('automation.party.regroupGaveUp', { minutes, members: members.join(', ') }),
        REGROUP
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
    if (this.apartAt !== null && here !== this.apartAt.from) this.apartAt = null;
    if (this.crossing !== null) {
      if (here === this.crossing.to) this.land(here, this.crossing.members);
      else if (here === this.crossing.from || here === this.crossing.through) return;
      else if (this.crossing.passing) {
        this.crossing.passing = false;
        this.crossing.through = here;
      } else this.leave();
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

  /** A draw: each member lands somewhere of their own, so nothing waits; the player is told. */
  private apart(from: RoomId | null, to: RoomId, members: string[]): void {
    if (this.apartAt !== null && this.apartAt.from === from && this.apartAt.to === to) return;
    this.end();
    this.apartAt = { from, to };
    this.events.notice?.(t('automation.party.apart', { members: members.join(', ') }), REGROUP);
  }

  private land(at: RoomId, members: string[]): void {
    this.crossing = null;
    this.gathering = { at, members, invited: new Set(), listed: false };
    this.queue.enqueue(partyListingIntent(this.config, REGROUP));
  }

  /** Somewhere the portal does not lead: a scatter, or the player walking on by hand. */
  private leave(): void {
    const held = this.timer !== null;
    this.end();
    if (held) this.events.notice?.(t('automation.party.regroupLeft'), REGROUP);
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
      if (held) this.events.notice?.(t('automation.party.regrouped'), REGROUP);
      return;
    }
    for (const member of missing) {
      const key = member.toLowerCase();
      if (joined.has(key) || !here.has(key) || gathering.invited.has(key)) continue;
      gathering.invited.add(key);
      this.events.notice?.(t('automation.party.reinvited', { member }), REGROUP);
      // The `@join` behind it is `InviteFollowUp`'s, off the `[Invited]` row this puts up.
      this.queue.enqueue(
        inviteIntent(member, t('automation.party.reasonReinvite', { member }), REGROUP)
      );
    }
  }

  private end(): void {
    this.apartAt = null;
    this.crossing = null;
    this.gathering = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
