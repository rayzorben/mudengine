/**
 * A room that hurt the character on the wire, whatever the world database says
 * (todo 20261103-0140-01): health lost `tuning.roomHarm.drops` times inside
 * `withinMs` in one room with the same maximum. Not while a fight is here
 * (`fightHere`), inside `MOB_ENGAGED_MS` of a monster's damage line
 * (`monsterHit`), poisoned, bleeding on the ground, paying for its own bash
 * (`paidFor`) or under a spell that takes health each tick (`ticking`). A room
 * the data gives no spell still counts, since unknown is the unsafe case. A
 * mark clears after `clearAfterMs` standing in the room unhurt. Read through
 * `RoomHazards`; the cases behind each rule are in `mudengine-automation` ›
 * `parts/safety.md`.
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
    /** A spell up on the character that takes health every tick (`RoomHazards`). */
    private readonly ticking: (state: CharacterState) => boolean,
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
    const at = this.now();
    if (here !== this.room) {
      this.room = here;
      this.drops = [];
      this.paid = 0;
      this.quietSince = hp === null ? null : at;
      return;
    }
    if (here === null || hp === null || before === null) return;
    // What was paid is spent on the first line that moves health, a drop or not, so it
    // excuses no later one. The bash line itself moves nothing: the server shows the
    // fall on the prompt after it (Gnome Village, Rayzor on OCI, 2026-11-07).
    const paid = hp === before ? 0 : this.paid;
    if (hp !== before) this.paid = 0;
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
      this.blows.monsterHit(at) ||
      this.ticking(state)
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
