/**
 * A party member's health between party lists (the user, 2026-10-10): a blow the
 * room sees land on a member takes its damage off the figures the member's
 * `@health` answer gave, and a heal cast on one puts its amount back, so a
 * healer works from the bar as it is rather than as the last `par` left it.
 * Without those figures there is no maximum to take a share of, and the bar
 * waits for the next party list, which seeds them from the registry's last
 * maximum (todo 142). `mudengine-wire` › *The party roster*.
 */
import type { Block } from '../../shared/blocks';
import { castEffect } from '../../shared/casts';
import {
  joinedMembers,
  standingHere,
  type CharacterState,
  type PartyMember
} from '../../shared/character';
import type { PlayerVitals } from '../../shared/players';
import { figure } from '../../shared/values';

/** The state with the hit points this block moved on members, or `state` unchanged. */
export function withMemberBars(state: CharacterState, block: Block): CharacterState {
  const changes = hitPointChanges(state, block);
  if (changes.length === 0) return state;
  let moved = false;
  const members = state.party.members.map((entry) => {
    const by = changes.find((change) => change.who === entry.name.toLowerCase())?.by;
    const vitals = entry.vitals;
    if (by === undefined || vitals == null || vitals.hpMax <= 0) return entry;
    moved = true;
    const hp = Math.min(vitals.hpMax, vitals.hp + by);
    return { ...entry, vitals: { ...vitals, hp }, health: Math.max(0, hp / vitals.hpMax) };
  });
  return moved ? { ...state, party: { ...state.party, members } } : state;
}

/**
 * The party list's share laid over the figures a member's client answered with:
 * kept where the share still reads as those figures (the party list prints whole
 * percent, rounded down, `PartyCommand.cs`), and moved to the share where it
 * does not, so the next blow is taken off the bar the party list just stated.
 *
 * A member with no figures on the row (a rejoin, or a party list that came before
 * their answer) takes the maximum from `recalled`, the player registry's last
 * figures for them, and the share for the current one (todo 142). Their
 * `@health` answer then replaces both.
 */
export function listedVitals(
  held: PartyMember['vitals'],
  health: number | null,
  mana: number | null,
  recalled: PlayerVitals | null = null
): PartyMember['vitals'] {
  if (held === null) return seeded(recalled, health, mana);
  return {
    ...held,
    hp: onShare(held.hp, held.hpMax, health),
    mana:
      held.mana === null || held.manaMax === null
        ? held.mana
        : onShare(held.mana, held.manaMax, mana)
  };
}

function seeded(
  recalled: PlayerVitals | null,
  health: number | null,
  mana: number | null
): PartyMember['vitals'] {
  if (recalled === null || health === null || recalled.hpMax <= 0) return null;
  const manaMax = mana === null ? null : recalled.manaMax;
  return {
    hp: Math.round(health * recalled.hpMax),
    hpMax: recalled.hpMax,
    mana: manaMax === null || mana === null ? null : Math.round(mana * manaMax),
    manaMax
  };
}

function onShare(value: number, max: number, share: number | null): number {
  if (share === null || max <= 0) return value;
  const percent = Math.round(share * 100);
  return Math.floor((value * 100) / max) === percent ? value : Math.round(share * max);
}

interface HitPointChange {
  /** Lower-cased. */
  who: string;
  by: number;
}

function hitPointChanges(state: CharacterState, block: Block): HitPointChange[] {
  const g = block.groups;
  if (block.type === 'spell-cast') {
    const amount = figure(g['amount']);
    const who = g['target'];
    if (amount === null || who === undefined) return [];
    const by = castEffect(g) === 'harm' ? -amount : amount;
    /*
     * `You cast healing rain on your party, healing 12 damage!` (captures/045,
     * 103): one amount for every member in the room, as `Spell.cs:1371` adds
     * the one figure to each target (source; a capture shows only the caster's
     * line). Another caster's rain prints no figure (`on the room!`).
     */
    if (who.toLowerCase() === 'your party') {
      const here = standingHere(state);
      return joinedMembers(state)
        .filter((member) => here.has(member.name.toLowerCase()))
        .map((member) => ({ who: member.name.toLowerCase(), by }));
    }
    return [{ who: who.toLowerCase(), by }];
  }
  // The victim as the Classifier resolved it; one the room does not list goes unread.
  if (block.type !== 'user-hits' || g['attacker'] === 'You') return [];
  const damage = figure(g['damage']);
  const who = g['target']?.toLowerCase();
  if (damage === null || who === undefined) return [];
  const member = joinedMembers(state).some((entry) => entry.name.toLowerCase() === who);
  return member ? [{ who, by: -damage }] : [];
}
