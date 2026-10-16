/**
 * The party fighting beside this character, as far as the client knows it
 * (todo 152): who draws the monsters' blows and what each member deals a
 * round. Only the hunting grounds price a spot this way; everywhere else a
 * fight is this character's own. See mudengine-world › `parts/hunting.md`
 * › *A party is priced with every member fighting*.
 */
import type { PartyMember } from './character';
import type { HuntingParty, SpotMob } from './hunting';
import type { SurvivalParty } from './survival';

/** A member in the fight: one whose own client has said its maximum health (`@health`). */
export interface PartyFighter {
  name: string;
  hpMax: number;
  /** What it deals a round, measured off this character's fight record; null deals nothing. */
  perRound: number | null;
}

/**
 * The members in the fight. A member whose maximum health no client has said
 * is left out of it: it might fall in the first round, so it draws no blows
 * and deals nothing, and it still takes its share of every kill (`killShare`).
 */
export function partyFighters(
  members: readonly PartyMember[],
  dealt: (name: string) => number | null
): PartyFighter[] {
  return members.flatMap((member) => {
    const hpMax = member.vitals?.hpMax ?? null;
    if (hpMax === null || hpMax <= 0) return [];
    return [{ name: member.name, hpMax, perRound: dealt(member.name) }];
  });
}

/**
 * The chance a monster aimed at a player with this Charm looks for a new
 * target this round: `Mob.TryFindTarget` does when
 * `rand(1, 100) + (Charm − 50) / 10 > 50`, the division an integer one
 * (GreaterMUD/Mobs/Mob.cs:1820).
 */
export function retargetChance(charm: number): number {
  const lean = Math.trunc((charm - 50) / 10);
  return Math.min(1, Math.max(0, (50 + lean) / 100));
}

/**
 * Unknown Charm, read the way that sends the most blows to this character:
 * its own as 0, so a monster aimed at it stays longest, and a member's as
 * high as Charm goes, which no table states, so a monster aimed at a member
 * looks again every round.
 */
const OWN_CHARM_UNREAD = 0;
const MEMBER_RETARGET = 1;

/** What the survey's arithmetic needs of the party: the members' damage a round. */
export type PartyPricing = Pick<HuntingParty, 'damage'>;

export function partyPricing(fighters: readonly PartyFighter[]): PartyPricing {
  return { damage: fighters.reduce((sum, fighter) => sum + (fighter.perRound ?? 0), 0) };
}

/**
 * A spawn as the party fights it: its health over this character's damage a
 * round and the members' together. Its blows stay whole on this character:
 * whether a member stands long enough to draw them is the run fight's to say
 * (`SurvivalInput.party`), so the rest a cycle costs is priced as alone.
 * Where its health or rounds are unknown the rounds stay as they are.
 */
export function withParty(mob: SpotMob, hp: number | null, party: PartyPricing): SpotMob {
  const faster =
    mob.rounds !== null && mob.rounds > 0 && hp !== null && hp > 0 && party.damage > 0
      ? hp / (hp / mob.rounds + party.damage)
      : mob.rounds;
  return { ...mob, rounds: faster };
}

/** The party as the fight odds run it beside this character. */
export function survivalParty(
  fighters: readonly PartyFighter[],
  charm: number | null
): SurvivalParty {
  return {
    members: fighters.map((fighter) => ({ hp: fighter.hpMax, perRound: fighter.perRound ?? 0 })),
    retarget: retargetChance(charm ?? OWN_CHARM_UNREAD),
    retargetMember: MEMBER_RETARGET
  };
}

/**
 * What the party's fights are kept under: each member's health, and its
 * damage in steps of `step` of itself, so a figure that settles over the
 * session does not run every lair again on each fight.
 */
export function partyKey(fighters: readonly PartyFighter[], step: number): string {
  const bucket = (value: number | null): string =>
    value === null || value <= 0
      ? '-'
      : String(Math.round(Math.log(value) / Math.log(1 + Math.max(0.01, step))));
  return fighters
    .map((fighter) => `${fighter.name.toLowerCase()}:${fighter.hpMax}:${bucket(fighter.perRound)}`)
    .sort()
    .join(',');
}

/** The party a lair is hunted beside, as the fight odds run it, and the key its fights are kept under (`partyKey`). */
export interface PartyOdds {
  key: string;
  party: SurvivalParty;
}

/** Everything the survey prices a party with, or null with nobody joined. */
export interface PartyPlan {
  /** Null where no member is in the fight: the lairs are then this character's own fights. */
  odds: PartyOdds | null;
  /** What the card says of it; its damage is what `withParty` prices with. */
  said: HuntingParty;
}

/**
 * The party the hunting grounds are priced with: `members` the joined ones,
 * `dealt` a member's measured damage a round, `step` the key's (`partyKey`).
 */
export function partyPlan(
  members: readonly PartyMember[],
  dealt: (name: string) => number | null,
  charm: number | null,
  step: number
): PartyPlan | null {
  if (members.length === 0) return null;
  const fighters = partyFighters(members, dealt);
  const pricing = partyPricing(fighters);
  return {
    odds:
      fighters.length === 0
        ? null
        : { key: partyKey(fighters, step), party: survivalParty(fighters, charm) },
    said: {
      fighters: fighters.length,
      leftOut: members.length - fighters.length,
      unmeasured: fighters.filter((fighter) => fighter.perRound === null).length,
      ...pricing
    }
  };
}
