/**
 * Who outside the party wants curing, from the sheets other players share
 * with this character (todo 20261031-1156-01): a sharer its own client says
 * is poisoned, diseased or held, while the room's own list shows them here.
 * A sheet's room never decides that, since a sheet can lie and a cast at
 * somebody elsewhere is refused. `PartyCures` casts what this finds, through
 * the same queue and waits as for a member. `mudengine-session` ›
 * `parts/peers.md`.
 */
import {
  joinedMembers,
  standingHere,
  type Afflictions,
  type CharacterState
} from '../../shared/character';
import type { Cure } from '../../shared/config';
import { newestSheets, type SharedSheet } from '../../shared/peers';
import { playerKey } from '../../shared/players';

/** The cures cast at another character, and the condition each answers. */
export type OtherCure = Extract<Cure, 'poison' | 'disease' | 'freedom'>;

/** A character to cure, and of what. */
export interface CureNeed {
  member: string;
  cure: OtherCure;
}

/** The cures a shared sheet's conditions call for, in the order they are cast. */
function curesFor(afflictions: Afflictions): OtherCure[] {
  return [
    ...(afflictions.held === 'yes' ? (['freedom'] as const) : []),
    ...(afflictions.poisoned === 'yes' ? (['poison'] as const) : []),
    ...(afflictions.diseased === 'yes' ? (['disease'] as const) : [])
  ];
}

/** Sharers standing here who are not in this character's party, and what each wants cured. */
export function peerCareNeeds(state: CharacterState, sheets: readonly SharedSheet[]): CureNeed[] {
  const here = standingHere(state);
  const party = new Set(joinedMembers(state).map((member) => playerKey(member.name)));
  const self = state.name === null ? null : playerKey(state.name);
  const needs: CureNeed[] = [];
  for (const [key, shared] of newestSheets(sheets)) {
    const { afflictions } = shared.sheet;
    if (key === self || party.has(key) || !here.has(key) || afflictions === null) continue;
    for (const cure of curesFor(afflictions)) needs.push({ member: shared.from.name, cure });
  }
  return needs;
}
