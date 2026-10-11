/**
 * A party member's health between listings (the user, 2026-10-10): a blow the
 * room sees land on a member takes its damage off the figures the member's
 * `@health` answer gave, and a heal cast on one puts its amount back, so a
 * healer works from the bar as it is rather than as the last `par` left it.
 * Without those figures there is no maximum to take a share of, and the bar
 * waits for the next listing. `mudengine-wire` › *The party roster*.
 */
import type { Block } from '../../shared/blocks';
import { joinedMembers, type CharacterState, type PartyMember } from '../../shared/character';
import { figure } from '../../shared/values';

/** The state with the hit points this block moved on a member, or `state` unchanged. */
export function withMemberBars(state: CharacterState, block: Block): CharacterState {
  const change = hitPointChange(state, block);
  if (change === null) return state;
  const index = state.party.members.findIndex(
    (held) => held.name.toLowerCase() === change.who.toLowerCase()
  );
  const held = index === -1 ? undefined : state.party.members[index];
  const vitals = held?.vitals;
  if (held === undefined || vitals == null || vitals.hpMax <= 0) return state;
  const hp = Math.min(vitals.hpMax, vitals.hp + change.by);
  const members = state.party.members.map((entry, at) =>
    at === index
      ? {
          ...entry,
          vitals: { ...vitals, hp },
          health: Math.max(0, Math.min(1, hp / vitals.hpMax))
        }
      : entry
  );
  return { ...state, party: { ...state.party, members } };
}

/**
 * The listing's share laid over the figures a member's client answered with:
 * kept where the share still reads as those figures (the listing prints whole
 * percent, rounded down, `PartyCommand.cs`), and moved to the share where it
 * does not, so the next blow is taken off the bar the listing just stated.
 */
export function listedVitals(
  held: PartyMember['vitals'],
  health: number | null,
  mana: number | null
): PartyMember['vitals'] {
  if (held === null) return null;
  return {
    ...held,
    hp: onShare(held.hp, held.hpMax, health),
    mana:
      held.mana === null || held.manaMax === null
        ? held.mana
        : onShare(held.mana, held.manaMax, mana)
  };
}

function onShare(value: number, max: number, share: number | null): number {
  if (share === null || max <= 0) return value;
  const percent = Math.round(share * 100);
  return Math.floor((value * 100) / max) === percent ? value : Math.round(share * max);
}

interface HitPointChange {
  who: string;
  by: number;
}

function hitPointChange(state: CharacterState, block: Block): HitPointChange | null {
  const g = block.groups;
  if (block.type === 'spell-cast') {
    const amount = figure(g['amount']);
    const who = g['target'];
    if (amount === null || who === undefined) return null;
    return { who, by: g['kind'] === 'for' ? -amount : amount };
  }
  // The victim as the Classifier resolved it; one the room does not list goes unread.
  if (block.type !== 'user-hits' || g['attacker'] === 'You') return null;
  const damage = figure(g['damage']);
  const who = g['target'];
  if (damage === null || who === undefined) return null;
  const member = joinedMembers(state).some(
    (entry) => entry.name.toLowerCase() === who.toLowerCase()
  );
  return member ? { who, by: -damage } : null;
}
