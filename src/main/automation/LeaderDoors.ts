/**
 * Helping the leader through a door (todo 03, `automation.party.helpWithDoors`).
 * The room sees the leader fail a bash (`You see Baby attempt to bash the gate
 * to the east.`, captures/014) and this character has a go in turn: `pi` when
 * its picklocks meet the door's figure, since a failed pick costs no health,
 * or else `bas` when its strength does and the bash's damage is affordable.
 * A pick unlocks without opening (`Door.TryPickLock`), so `open` follows it.
 * The room is never told of a failed pick, so only a bash asks for help. One
 * try per failed bash seen: the leader's own tries bound ours, and one left
 * in the queue when the room changes is dropped. A door the realm has no
 * record of is picked but never bashed: it may be one only a key opens.
 * `mudengine-automation` › parts/remotes.md.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import { fightIsRunning, type CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import { barrierStated, canPick, meetsBarrier, tooHurtToBash } from '../../shared/walk';
import {
  asSpokenDirection,
  DIRECTION_NAME,
  roomAddress,
  type Direction,
  type RoomId
} from '../../shared/world';
import type { CommandQueue } from './CommandQueue';

export interface LeaderDoorsEvents {
  notice?(message: string): void;
}

const DOOR_KEY = 'party:door';

export class LeaderDoors {
  /** The door a `pi` went for, until its answer: an unlock is followed by `open`. */
  private picking: { direction: Direction; barrier: string } | null = null;
  /** The room as of the last line; a try queued in another room is not sent. */
  private here: RoomId | null = null;
  /** Directions out of `here` already said to be past this character's help, so each is said once. */
  private readonly told = new Set<Direction>();

  constructor(
    private config: AutomationConfig,
    private readonly queue: Pick<CommandQueue, 'enqueue'>,
    private readonly events: LeaderDoorsEvents = {}
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
  }

  reset(): void {
    this.picking = null;
    this.told.clear();
  }

  onBlock(block: Block, state: CharacterState): void {
    const here = roomAddress(state.room);
    if (here !== this.here) {
      this.here = here;
      this.told.clear();
    }
    switch (block.type) {
      case 'skill-failed':
        this.picking = null;
        return;
      case 'door-changed':
        this.afterPick(block);
        return;
      case 'player-bashes-door':
        this.help(block, state);
        return;
      default:
        return;
    }
  }

  /** `You successfully unlocked the door.` answering this character's `pi`: open it for the leader. */
  private afterPick(block: Block): void {
    const door = this.picking;
    this.picking = null;
    if (door === null || block.groups['state2'] !== 'unlocked') return;
    this.queue.enqueue({
      command: `open ${door.direction}`,
      priority: 'movement',
      coalesceKey: DOOR_KEY,
      stillWanted: this.stillHere(),
      reason: t('automation.party.reasonOpenForLeader', {
        barrier: door.barrier,
        direction: DIRECTION_NAME[door.direction]
      })
    });
  }

  /** Whether the character is still in the room a try was proposed in. */
  private stillHere(): () => boolean {
    const at = this.here;
    return () => this.here === at;
  }

  private help(block: Block, state: CharacterState): void {
    const { enabled, party, health } = this.config;
    if (!enabled || !party.helpWithDoors) return;
    const leader = state.party.following;
    const who = block.groups['player'];
    if (leader === null || who?.toLowerCase() !== leader.toLowerCase()) return;
    const direction = asSpokenDirection(block.groups['direction'] ?? '');
    if (direction === null) return;

    const words = {
      leader,
      barrier: block.groups['barrier'] ?? 'door',
      direction: DIRECTION_NAME[direction]
    };
    const tell = (message: string): void => {
      if (this.told.has(direction)) return;
      this.told.add(direction);
      this.events.notice?.(message);
    };
    if (fightIsRunning(state)) {
      tell(t('automation.party.helpDoorFighting', words));
      return;
    }

    const exit = state.room.exits.find((way) => way.direction === direction);
    const need = exit?.requirement;
    const stated = barrierStated(need);
    // A lock the realm names a key for and no figure: only that key opens it
    // (`RoomManager` gives a key door `strRequired = -999`).
    if (need?.keyId !== undefined && !stated) {
      tell(t('automation.party.helpDoorKeyOnly', words));
      return;
    }
    const { picklocks, strength } = state.progress;
    const { pickMargin, bashMargin } = tuning().walk;
    const pick = canPick(need?.pickDifficulty, picklocks, pickMargin, stated);
    // No figure from a realm that does know the exit is a plain door; one it
    // has no record of (an unresolved room, no world data) may be keyed.
    const known = exit?.targetMap !== null && exit?.targetMap !== undefined;
    const bash = meetsBarrier(need?.bashDifficulty, strength, bashMargin, stated);
    if (!pick && bash && !known) {
      tell(t('automation.party.helpDoorUnknown', words));
      return;
    }
    if (!pick && bash && tooHurtToBash(state.vitals, health.restBelow)) {
      tell(t('automation.party.helpDoorHurt', words));
      return;
    }
    if (!pick && !bash) {
      tell(t('automation.party.helpDoorCannot', words));
      return;
    }
    this.queue.enqueue({
      command: `${pick ? 'pi' : 'bas'} ${direction}`,
      priority: 'movement',
      coalesceKey: DOOR_KEY,
      stillWanted: this.stillHere(),
      reason: pick
        ? t('automation.party.reasonPickForLeader', words)
        : t('automation.party.reasonBashForLeader', words),
      onSent: () => {
        this.picking = pick ? { direction, barrier: words.barrier } : null;
      }
    });
  }
}
