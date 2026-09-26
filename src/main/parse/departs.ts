/**
 * A monster leaving the room: killed (`FightTracker`) or walked out
 * (`mob-leaves-room`, todo 826). One namesake goes when `one`, as one
 * sentence is one monster; the target, its bar and the attacker entry go with
 * the last of the name. See `mudengine-wire` › parts/room.md.
 */
import type { CharacterState } from '../../shared/character';
import { mobKey } from '../../shared/world';

/** A monster leaves the room, the target and the attacker list. */
export function leavesRoom(s: CharacterState, killed: string, one: boolean): CharacterState {
  let dropped = false;
  const occupants = s.room.occupants.filter((who) => {
    if (mobKey(who.name) !== killed) return true;
    if (one && dropped) return true;
    dropped = true;
    return false;
  });
  const stillHere = occupants.some((who) => mobKey(who.name) === killed);
  /*
   * Whether what left is what this character is fighting.
   *
   * `diedNamed` exists for the kill this character did *not* land, so the
   * two are routinely different — and clearing the target on somebody
   * else's kill loses the only thing that can attribute this character's
   * own. Live, 2026-09-14: one of four dark monks was taken out of the room
   * by a sentence, the target went with it, and the experience line that
   * followed a real kill two lines later had nothing to name — so the
   * monster the character had actually killed stayed in the room for the
   * rest of the session and auto-combat went on choosing its corpse.
   */
  const wasTarget = mobKey(s.combat.target ?? '') === killed;
  const keepsTarget = !wasTarget || stillHere;
  return {
    ...s,
    room: { ...s.room, occupants },
    /*
     * The bar goes with the target — a reading of a monster that is not
     * there is the stale-target problem wearing a percentage — and so
     * does the dead monster's entry in `attackers`. It used to stay,
     * and in the two lines between this and `*Combat Off*` retaliation
     * read it as something still swinging and attacked a corpse —
     * `Your command had no effect.`, once per kill, out of the budget
     * the next fight needs (captured live, 2026-08-26).
     */
    combat: {
      ...s.combat,
      // A namesake still standing keeps the target and the bar: the fight
      // with it is the same fight, and `aa` switches to it by itself.
      target: keepsTarget ? s.combat.target : null,
      health: keepsTarget ? s.combat.health : null,
      attackers: stillHere
        ? s.combat.attackers
        : s.combat.attackers.filter((name) => mobKey(name) !== killed)
    }
  };
}
