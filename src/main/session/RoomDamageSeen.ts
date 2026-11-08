/**
 * A room that hurt the character on the wire, whatever the world database says
 * (todo 20261103-0140-01): health lost `tuning.roomHarm.drops` times inside
 * `withinMs` in one room with the same maximum. Not while a fight is here
 * (`fightHere`), inside `MOB_ENGAGED_MS` of a monster's damage line
 * (`monsterHit`), poisoned, bleeding on the ground, in a room where it has
 * bashed since it came in (`bashedIn`) or under a spell that takes health each
 * tick (`ticking`). A room the data gives no spell still counts, since unknown
 * is the unsafe case. A mark clears after `clearAfterMs` standing in the room
 * unhurt. Read through `RoomHazards`; the cases behind each rule are in
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
  /**
   * The room where the character has bashed since it came in (the user,
   * 2026-11-07): no fall there is the room's. Kept while the room reads
   * unplaced, dropped only in another room, and taken up by the first room
   * placed after a bash made unplaced. Bashing a door never marks a room.
   */
  private bashedIn: RoomId | null = null;
  private bashedUnplaced = false;
  /** In the order seen, so the oldest goes first past `keptRooms`. */
  private readonly seen = new Set<RoomId>();

  constructor(
    private readonly signs: FightSigns,
    private readonly blows: Pick<HangUpWatch, 'monsterHit'>,
    /** A spell up on the character that takes health every tick (`RoomHazards`). */
    private readonly ticking: (state: CharacterState) => boolean,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * `Your attempts to bash through fail!` or `You take 2 damage for bashing the
   * door!`: the character's own bash, whose cost shows on a later prompt, after
   * a regen tick or with other falls. Nothing in this room counts until it leaves.
   */
  observe(block: Pick<Block, 'type' | 'groups'>): void {
    const paidFor = block.type === 'user-takes-damage' && block.groups['paidFor'] !== undefined;
    if (block.type !== 'bash-failed' && !paidFor) return;
    this.bashedIn = this.room;
    this.bashedUnplaced = this.room === null;
    this.drops = [];
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
      if (here !== null && here !== this.bashedIn) {
        this.bashedIn = this.bashedUnplaced ? here : null;
        this.bashedUnplaced = false;
      }
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
    if (here === this.bashedIn) return;
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
    this.bashedIn = null;
    this.bashedUnplaced = false;
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
