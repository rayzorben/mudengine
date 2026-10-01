/**
 * Who else is here to share a kill with (todos 70, AutoHunt's company): a
 * person standing in the room or holding a claim, never this character and
 * never a party member. `Mob.cs:2270` divides a kill's experience among
 * everybody who hit it, so this is what a measured rate, and a learned kill,
 * must know about.
 */
import type { CharacterState } from './character';

/**
 * The first other person here, or null. `unplaced`: a name the realm cannot
 * place counts as a player, since learning from a shared kill would record a
 * share.
 */
export function companyIn(
  state: Pick<CharacterState, 'name' | 'party' | 'room' | 'combat'>,
  unplaced = false
): string | null {
  const mine = new Set(state.party.members.map((member) => member.name.toLowerCase()));
  const own = state.name?.toLowerCase() ?? '';
  const other = (name: string): boolean => {
    const key = name.toLowerCase();
    return key !== own && !mine.has(key);
  };
  return (
    state.room.occupants.find(
      (who) => (who.kind === 'player' || (unplaced && who.kind === 'unknown')) && other(who.name)
    )?.name ??
    Object.values(state.combat.claimed).find((claim) => other(claim.by))?.by ??
    null
  );
}

/** A kill nobody could have shared: no party, and nobody else here. */
export function killedAlone(
  state: Pick<CharacterState, 'name' | 'party' | 'room' | 'combat'>
): boolean {
  return state.party.members.length === 0 && companyIn(state, true) === null;
}
