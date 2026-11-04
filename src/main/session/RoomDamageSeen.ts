/**
 * A room that hurt the character on the wire, whatever the world database says
 * (todo 20261103-0140-01): health lost `tuning.roomHarm.drops` times inside
 * `withinMs` in one room, not poisoned, not bleeding on the ground and with
 * the same maximum, is the room's damage. Not while a fight is here
 * (`fightHere`), nor inside `MOB_ENGAGED_MS` of a monster's damage line
 * (`HangUpWatch.monsterHit`), wherever that monster is now. Unknown is the
 * unsafe case, so a room the data gives no spell still counts once the server
 * has taken health there twice. Read through `RoomHazards`.
 * `mudengine-automation` › `parts/safety.md`.
 */
import { tuning } from '../app/tuning';
import type { HangUpWatch } from '../automation/HangUp';
import { fightHere, type CharacterState, type FightSigns } from '../../shared/character';
import { roomAddress, type RoomId } from '../../shared/world';

export class RoomDamageSeen {
  private room: RoomId | null = null;
  private hp: number | null = null;
  private hpMax: number | null = null;
  private drops: number[] = [];
  /** In the order seen, so the oldest goes first past `keptRooms`. */
  private readonly seen = new Set<RoomId>();

  constructor(
    private readonly signs: FightSigns,
    private readonly blows: Pick<HangUpWatch, 'monsterHit'>,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Every status line: a drop in health nothing in the room explains. */
  note(state: CharacterState): void {
    const here = roomAddress(state.room);
    const { hp, hpMax } = state.vitals;
    const before = this.hp;
    const maxBefore = this.hpMax;
    this.hp = hp;
    this.hpMax = hpMax;
    if (here !== this.room) {
      this.room = here;
      this.drops = [];
      return;
    }
    if (here === null || hp === null || before === null || hp >= before) return;
    // A maximum that fell (gear taken off) lowers the figure without a blow.
    const at = this.now();
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
