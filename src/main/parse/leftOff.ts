/**
 * The fight a `*Combat Off*` ended, for the `*Combat Engaged*` that may follow
 * it. A cast or a switch of target mid-fight is answered by the pair, and the
 * monsters hitting the character did not stop for it, so the engagement takes
 * back the attackers and each monster's damage goes on (`FightTracker`). The
 * rule and its measurement: `mudengine-wire` › `parts/combat.md` › *A Combat
 * Off and Combat Engaged pair keeps the attackers*.
 *
 * Out of `FightTracker`, which asks it on each engagement and each prompt. Adapted from the
 * fatavatar fork's `leftOff` (`2b93e4f`, todo 843) without its target
 * carry-over.
 */
import type { CharacterState } from '../../shared/character';
import { mobKey, roomAddress, type RoomId } from '../../shared/world';
import { tuning } from '../app/tuning';

/** A `*Combat Off*`: the character's state at the Off; its fight is written down with it. */
export interface Off {
  left: CharacterState;
  at: number;
}

/** What a `*Combat Engaged*` made of the last Off. */
export interface Resumed extends Off {
  /**
   * The Off's attackers the engagement takes back, those the room still lists;
   * null when the fight ended at the Off (too late, or in another room).
   */
  attackers: readonly string[] | null;
}

export class LeftOff {
  private left: (Off & { room: RoomId | null }) | null = null;

  /** `*Combat Off*` at `at`, ending the fight `s` holds. */
  off(s: CharacterState, at: number): void {
    this.left = { left: s, at, room: roomAddress(s.room) };
  }

  /**
   * The last Off, taken by a `*Combat Engaged*` at `at`. Only the first one
   * inside `engageBindMs`, in the same placed room, goes on with its fight,
   * and only those attackers the room still lists come back, so a monster the
   * Off's kill took out stays out.
   */
  resume(s: CharacterState, at: number): Resumed | null {
    const left = this.left;
    this.left = null;
    if (left === null) return null;
    const goesOn =
      left.room !== null &&
      at - left.at <= tuning().parse.engageBindMs &&
      roomAddress(s.room) === left.room;
    if (!goesOn) return { left: left.left, at: left.at, attackers: null };
    const here = new Set(s.room.occupants.map((who) => mobKey(who.name)));
    const already = new Set(s.combat.attackers.map(mobKey));
    const attackers = left.left.combat.attackers.filter(
      (name) => here.has(mobKey(name)) && !already.has(mobKey(name))
    );
    return { left: left.left, at: left.at, attackers };
  }

  /** The last Off when no engagement took it back inside `engageBindMs`: its fight is over. */
  lapsed(at: number): Off | null {
    const left = this.left;
    if (left === null || at - left.at <= tuning().parse.engageBindMs) return null;
    this.left = null;
    return { left: left.left, at: left.at };
  }

  forget(): void {
    this.left = null;
  }
}
