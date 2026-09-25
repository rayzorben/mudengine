/**
 * Reading the floor after a kill, so the loot sees what dropped (todo 814).
 *
 * A monster's items reach the floor in silence: `Mob.Death` tells its cash to
 * whoever targeted it and `DropAllItems` adds the rest to the room with no
 * word (GreaterMUD `Mobs/Mob.cs` `Death`, `DoDropAllItems`; `ItemContainer.
 * AddItem`). The logs agree: coins tens of thousands of times, never an item.
 * So one bare Enter reprints the room and its `You notice … here.` is what
 * `AutoLoot` takes from — in flight until the tracker says its own claim is
 * answered, which the walk waits on, or the `get` would follow a step already
 * sent into the next room. See `mudengine-automation` › *Loot is picked up unasked*.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { REREAD_ROOM, type RereadClaim, type RereadClaims } from '../../shared/commands';
import type { CommandQueue } from './CommandQueue';

const KEY = 'loot:floor';

export class FloorAfterKill {
  /** When the wait lapses: the read's own expiry, so nothing waits on it longer than it is worth. */
  private until = 0;
  /** Whether the read is still waiting in the queue. */
  private queued = false;
  /**
   * The claim the read's bare Enter filed, once it went out. Its own room
   * closes it, never one already on the wire (todo 767): the tracker says
   * which claim a room answered, where counting rooms here let auto-combat's
   * refresh or a player's `l`, sent before, answer for it.
   */
  private sent: RereadClaim | null = null;

  constructor(
    private readonly queue: Pick<CommandQueue, 'enqueue'>,
    private readonly claims: RereadClaims,
    /**
     * Whether a take is still waiting in the queue (`AutoLoot`'s). The read's
     * answer is the takes it produces, and the walk it holds wakes on its
     * close (todo 765): a step outranks a `get`, so one left queued would
     * follow the step into the next room.
     */
    private readonly taking: () => boolean,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Whether the read asked after a kill, or a take off its answer, has still to go. */
  get inFlight(): boolean {
    if (this.now() >= this.until) return false;
    return this.queued || this.sent?.owed() === true || this.taking();
  }

  /** Something this character was paid for died here: read the room again. */
  ask(): void {
    // A lapsed window leaves nothing owed: a read the queue dropped never went
    // out, and a claim still unanswered past it is the write-off's.
    if (!this.inFlight) this.reset();
    const expiresAt = this.now() + tuning().loot.expiresMs;
    // Marked before the offer: the queue sends inside `enqueue` when it has
    // credit, and `onSent` has then already moved the read on to its claim.
    const wasQueued = this.queued;
    this.queued = true;
    const taken = this.queue.enqueue({
      command: REREAD_ROOM,
      priority: 'probe',
      // Two kills in one round are one read while the first still waits.
      coalesceKey: KEY,
      expiresAt,
      reason: t('automation.loot.reasonFloorAfterKill'),
      // Straight after the send that filed it: null outside the realm, where nothing is owed.
      onSent: () => {
        this.queued = false;
        this.sent = this.claims.lastReread;
      }
    });
    // Refused outright (a held screen, automation off): nothing is coming, so
    // nothing is waited on. Coalesced onto one still queued: the same wait.
    if (!taken && !wasQueued) {
      this.queued = false;
      return;
    }
    this.until = expiresAt;
  }

  reset(): void {
    this.until = 0;
    this.queued = false;
    this.sent = null;
  }
}
