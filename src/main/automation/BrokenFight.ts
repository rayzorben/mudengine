/**
 * The monsters of a fight that a command other than an attack ended: a heal,
 * a blessing, an instant spell. The server's `*Combat Off*` stops this character's
 * attack and nothing else, so they are still swinging, but the tracker empties
 * the fight on the Off and only a `*Combat Engaged*` takes the attackers back
 * (`parse/leftOff.ts`). Until one does, `AutoCombat` hits these back as it
 * would anything on `combat.attackers`; without them the attack after a heal
 * was weighed as opening a new fight, refused on the odds, and nothing went out
 * until the next blow (festus, todo 20). See `mudengine-automation` ›
 * `parts/combat.md` › *A fight a cast broke is hit back, not opened*.
 */
import { sameVisit, type CharacterState, type Room } from '../../shared/character';
import { mobKey } from '../../shared/world';

interface Fight {
  /** The target and attackers, as the state before the Off held them. */
  names: readonly string[];
  room: Pick<Room, 'name' | 'arrival'>;
}

export class BrokenFight {
  /** The fight the last `*Combat Off*` ended, not yet known to be broken. */
  private ended: Fight | null = null;
  private owed: Fight | null = null;

  /** A `*Combat Off*`; `before` is the state ahead of it, which still holds the fight. */
  off(before: CharacterState | null): void {
    if (before === null) {
      this.ended = null;
      return;
    }
    const { target, attackers } = before.combat;
    const names = target === null ? attackers : [target, ...attackers];
    this.ended =
      names.length === 0
        ? null
        : { names, room: { name: before.room.name, arrival: before.room.arrival } };
  }

  /** That Off was the fight breaking for a command: its monsters are owed their attack. */
  broke(): readonly string[] {
    this.owed = this.ended;
    this.ended = null;
    return this.owed?.names ?? [];
  }

  /** Every state: a new engagement or another room settles the debt for good. */
  observe(state: CharacterState): void {
    const owed = this.owed;
    if (owed === null) return;
    const engaged = state.inCombat || state.combat.target !== null;
    if (engaged || !sameVisit(state.room, owed.room)) {
      this.owed = null;
    }
  }

  /** The owed monsters `state`'s room still lists and the tracker has not filed as attackers. */
  owedIn(state: CharacterState): readonly string[] {
    if (this.owed === null) return [];
    const here = new Set(
      state.room.occupants.filter((who) => who.kind !== 'player').map((who) => mobKey(who.name))
    );
    const filed = new Set(state.combat.attackers.map(mobKey));
    return this.owed.names.filter((name) => here.has(mobKey(name)) && !filed.has(mobKey(name)));
  }

  forget(): void {
    this.ended = null;
    this.owed = null;
  }
}
