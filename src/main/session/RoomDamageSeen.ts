/**
 * A room that hurt the character on the wire, whatever the world database says
 * (todo 20261103-0140-01): health lost `tuning.roomHarm.drops` times inside
 * `withinMs` in one room, not poisoned, not bleeding on the ground and with
 * the same maximum, is the room's damage. Not while a fight is here
 * (`fightHere`), nor inside `MOB_ENGAGED_MS` of a monster's damage line
 * (`HangUpWatch.monsterHit`), wherever that monster is now, nor what the
 * character paid for its own bash (`paidFor`, the user, 2026-11-05: Rayzor
 * was led out of Slum Street, Western Door for it). Unknown is the
 * unsafe case, so a room the data gives no spell still counts once the server
 * has taken health there twice. A mark is cleared once the character has
 * stood in the room `clearAfterMs` and lost no health (the user, 2026-11-05:
 * a false mark kept Rayzor from Brakkle's room). Read through `RoomHazards`.
 * `mudengine-automation` › `parts/safety.md`.
 */
import { tuning } from '../app/tuning';
import type { HangUpWatch } from '../automation/HangUp';
import { fightHere, type CharacterState, type FightSigns } from '../../shared/character';
import type { Block } from '../../shared/blocks';
import { roomAddress, type RoomId } from '../../shared/world';

export class RoomDamageSeen {
  private room: RoomId | null = null;
  private hp: number | null = null;
  private hpMax: number | null = null;
  private drops: number[] = [];
  /** Since when this character has stood in `room` losing no health; null with none of it known. */
  private quietSince: number | null = null;
  /** Health the server said this character paid for its own command, still to show on a status line. */
  private paid = 0;
  /** In the order seen, so the oldest goes first past `keptRooms`. */
  private readonly seen = new Set<RoomId>();

  constructor(
    private readonly signs: FightSigns,
    private readonly blows: Pick<HangUpWatch, 'monsterHit'>,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** `You take 2 damage for bashing the door!`: a drop the character's own command explains. */
  observe(block: Pick<Block, 'type' | 'groups'>): void {
    if (block.type !== 'user-takes-damage' || block.groups['paidFor'] === undefined) return;
    const damage = Number(block.groups['damage']);
    if (Number.isFinite(damage)) this.paid += damage;
  }

  /** Every status line: a drop in health nothing in the room explains. */
  note(state: CharacterState): void {
    const here = roomAddress(state.room);
    const { hp, hpMax } = state.vitals;
    const before = this.hp;
    const maxBefore = this.hpMax;
    this.hp = hp;
    this.hpMax = hpMax;
    // What was paid is spent on this line, a drop or not, so it excuses no later one.
    const paid = this.paid;
    this.paid = 0;
    const at = this.now();
    if (here !== this.room) {
      this.room = here;
      this.drops = [];
      this.quietSince = hp === null ? null : at;
      return;
    }
    if (here === null || hp === null || before === null) return;
    if (hp >= before) {
      this.quietSince ??= at;
      if (this.seen.has(here) && at - this.quietSince >= tuning().roomHarm.clearAfterMs)
        this.seen.delete(here);
      return;
    }
    this.quietSince = at;
    if (before - hp <= paid) return;
    // A maximum that fell (gear taken off) lowers the figure without a blow.
    if (
      hpMax !== maxBefore ||
      !unexplained(state, before, this.signs, at) ||
      this.blows.monsterHit(at)
    )
      return;
    const { drops, withinMs, keptRooms } = tuning().roomHarm;
    this.drops = [...this.drops.filter((then) => at - then <= withinMs), at];
    if (this.drops.length < drops || this.seen.has(here)) return;
    this.seen.add(here);
    if (this.seen.size > keptRooms) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  /** Whether the server took health in this room as a room that hurts does. */
  hurts(room: RoomId): boolean {
    return this.seen.has(room);
  }

  forget(): void {
    this.room = null;
    this.hp = null;
    this.hpMax = null;
    this.drops = [];
    this.quietSince = null;
    this.paid = 0;
    this.seen.clear();
  }
}

/**
 * No fight, a monster's recent blow, poison or bleeding on the ground accounts
 * for it: what is left is the room. Below 1 the character bleeds a point a
 * tick, so a fall from there is not counted.
 */
function unexplained(
  state: CharacterState,
  before: number,
  signs: FightSigns,
  now: number
): boolean {
  return (
    !fightHere(state, signs, now) &&
    state.afflictions.poisoned !== 'yes' &&
    !state.mortallyWounded &&
    before > 0
  );
}
