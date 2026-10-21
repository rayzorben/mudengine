/**
 * `l` once in a room shown without its description (todo 20261020-2015-01):
 * with brief on the realm prints no description, and a room the bundled set
 * has no picture for needs one before the art server can draw it. Offered in
 * the probe band only while unknown rooms are sent for artwork (`art.rooms`),
 * the room is placed for certain, the set has nothing for its map and room,
 * and nothing moves the character: no fight, no route, no loop, no errand.
 * Once per room per entry to the realm, whatever the look printed. See
 * `mudengine-automation` › *A routine reacts to what happens*.
 */
import { t } from '../app/i18n';
import { fightIsRunning, type CharacterState } from '../../shared/character';
import { certainRoom } from '../../shared/descriptions';
import type { RoomLook } from '../../shared/roomArt';
import type { RoomId } from '../../shared/world';
import type { CommandQueue } from './CommandQueue';

export const ROOM_LOOK_KEY = 'probe:look-room';

export class BriefLook {
  /** The rooms looked at since the character entered the realm. */
  private readonly looked = new Set<RoomId>();

  constructor(
    private readonly queue: Pick<CommandQueue, 'offer'>,
    private readonly look: RoomLook | undefined,
    /** Whether the client is taking the character nowhere. */
    private readonly idle: () => boolean
  ) {}

  /** A state in the realm, with automation on. */
  onCharacter(state: CharacterState): void {
    if (this.look === undefined || !this.look.wanted()) return;
    const room = certainRoom(state.room);
    if (room === null || state.room.description !== null || this.looked.has(room.room)) return;
    if (this.look.shipped(state.realm, room.map, room.number)) return;
    if (fightIsRunning(state) || !this.idle()) return;
    // A queue that is held or offline took nothing: asked again on the next state.
    const taken = this.queue.offer({
      command: 'l',
      priority: 'probe',
      coalesceKey: ROOM_LOOK_KEY,
      reason: t('automation.routines.reasonRoomLook'),
      decision: 'look-for-room-art'
    });
    if (taken === 'queued' || taken === 'joined') this.looked.add(room.room);
  }

  /** Out of the realm: the next entry may look at each room again. */
  left(): void {
    this.looked.clear();
  }

  reset(): void {
    this.looked.clear();
  }
}
