/**
 * Who was attacking this character when a `*Combat Off*` ended the fight, for
 * the `*Combat Engaged*` that may follow it. A cast or a switch of target
 * mid-fight is answered by the pair, and the monsters hitting the character
 * did not stop for it. The rule and its measurement: `mudengine-wire` ›
 * `parts/combat.md` › *A Combat Off and Combat Engaged pair keeps the attackers*.
 *
 * Out of `FightTracker`, which asks it on each engagement. Adapted from the
 * fatavatar fork's `leftOff` (`2b93e4f`, todo 843) without its target
 * carry-over.
 */
import type { CharacterState } from '../../shared/character';
import { mobKey, roomAddress, type RoomId } from '../../shared/world';
import { tuning } from '../app/tuning';

interface Left {
  attackers: readonly string[];
  /** Where the fight ended; a `*Combat Engaged*` anywhere else starts a new fight. */
  room: RoomId;
  at: number;
}

export class LeftOff {
  private left: Left | null = null;

  /** `*Combat Off*` at `at`, ending the fight `s` holds. */
  off(s: CharacterState, at: number): void {
    const room = roomAddress(s.room);
    this.left =
      room === null || s.combat.attackers.length === 0
        ? null
        : { attackers: s.combat.attackers, room, at };
  }

  /**
   * The attackers a `*Combat Engaged*` at `at` takes back, and nothing after:
   * only the first one inside `engageBindMs`, in the same room, and only
   * those the room still lists, so a monster the Off's kill took out stays out.
   */
  resume(s: CharacterState, at: number): readonly string[] {
    const left = this.left;
    this.left = null;
    if (left === null || at - left.at > tuning().parse.engageBindMs) return [];
    if (roomAddress(s.room) !== left.room) return [];
    const here = new Set(s.room.occupants.map((who) => mobKey(who.name)));
    const already = new Set(s.combat.attackers.map(mobKey));
    return left.attackers.filter((name) => here.has(mobKey(name)) && !already.has(mobKey(name)));
  }

  forget(): void {
    this.left = null;
  }
}
