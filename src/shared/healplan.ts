/**
 * Which heal to cast, and on whom, when more than one person is hurt (todo 05,
 * 2026-09-27): one heal on the worst of them, or a party-wide heal on all.
 *
 * Every option is valued by **relief**: the hit points it is expected to put
 * back, each weighted by how low on the bar it lands. A point mended at 30%
 * is worth more than one mended at 90%, because the first is the point that
 * keeps somebody alive. Summed over everyone a party-wide heal reaches who
 * wants a heal now, a rain that tops two people up a little is weighed
 * against a major heal that takes one of them out of danger; a member above
 * the floor adds nothing, so one person hurt is one heal (the todo's 68%,
 * 71% and 35%: the major heal on the 35%). The cheapest option whose relief is
 * within `nearEnough` of the best is cast. See `mudengine-automation` ›
 * *A party heal is weighed against a single heal*.
 */
import { joinedMembers, type CharacterState } from './character';
import {
  chooseHealSpell,
  healCasts,
  type HealCandidate,
  type HealCastInput,
  type HealChoice
} from './spellchoice';

/** Somebody the heal could reach, with the figures a choice is made on. */
export interface HealTarget {
  /** Null is this character, whose single heal is cast bare. */
  name: string | null;
  /** Whether a heal on this target alone is wanted now: under the floor, carried to the ceiling, or asked for. */
  wanted: boolean;
  hp: number;
  hpMax: number;
}

export interface HealPlanInput extends HealCastInput {
  /**
   * Everybody a party-wide heal reaches whose figures are known: this
   * character and every joined member (`Player.cs` `FullPartyArea`, server
   * source). A member the client has no figures for adds nothing to a rain's
   * worth, which undervalues the rain rather than overvaluing it.
   */
  targets: readonly HealTarget[];
  /** The share of maximum the healing runs to, 0–1. Nothing past it is relief. */
  ceiling: number;
  /** How steeply a low bar outweighs a high one: relief grows as `(1 - share) ^ urgency`. */
  urgency: number;
  /** An option within this share of the best relief is as good, and the cheapest of those wins. */
  nearEnough: number;
  /** Whether a party-wide heal may be cast at all: party healing is on. */
  partyWide: boolean;
}

export type HealOption =
  | {
      kind: 'single';
      target: HealTarget;
      choice: HealChoice & { chosen: HealCandidate };
      relief: number;
    }
  | { kind: 'area'; cast: Omit<HealCandidate, 'covers'>; reaches: number; relief: number };

/**
 * The weighted worth of taking a bar from `from` to `to` (shares of maximum):
 * the integral of `(1 - x) ^ urgency` between them, so every point counts and
 * the lowest count most.
 */
export function relief(from: number, to: number, urgency: number): number {
  if (to <= from) return 0;
  const power = urgency + 1;
  return ((1 - from) ** power - (1 - to) ** power) / power;
}

/** What one cast is expected to do for one target, capped at the ceiling. */
function reliefOf(target: HealTarget, expected: number, input: HealPlanInput): number {
  if (target.hpMax <= 0) return 0;
  const from = target.hp / target.hpMax;
  const to = Math.min(input.ceiling, from + expected / target.hpMax);
  return relief(from, to, input.urgency);
}

/**
 * The option to cast, or null where nobody wanted is healed by anything the
 * book, the level and the pool allow: the caller's configured spell decides.
 */
export function planHeal(input: HealPlanInput): HealOption | null {
  const options: HealOption[] = [];

  for (const target of input.targets) {
    if (!target.wanted) continue;
    const choice = chooseHealSpell({
      ...input,
      deficit: Math.max(0, Math.ceil(input.ceiling * target.hpMax) - target.hp),
      aim: target.name === null ? 'self' : 'party'
    });
    const chosen = choice.chosen;
    if (chosen === null) continue;
    const value = reliefOf(target, chosen.expected, input);
    options.push({ kind: 'single', target, choice: { ...choice, chosen }, relief: value });
  }

  // A rain is worth what it does for those who want a heal now.
  const wanted = input.targets.filter((target) => target.wanted);
  if (input.partyWide && wanted.length > 0) {
    for (const cast of healCasts(input, (aim) => aim === 'party').casts) {
      const value = wanted.reduce((sum, target) => sum + reliefOf(target, cast.expected, input), 0);
      options.push({ kind: 'area', cast, reaches: wanted.length, relief: value });
    }
  }

  const best = Math.max(0, ...options.map((option) => option.relief));
  if (best <= 0) return null;
  const costOf = (option: HealOption): number =>
    (option.kind === 'single' ? option.choice.chosen.cost : option.cast.cost) ??
    Number.MAX_SAFE_INTEGER;
  const [chosen] = options
    .filter((option) => option.relief >= best * (1 - input.nearEnough))
    .sort((a, b) => costOf(a) - costOf(b) || b.relief - a.relief);
  return chosen ?? null;
}

/** A member who wants a heal and whose own client has never said the figures. */
export interface UnfiguredTarget {
  name: string;
  /** The party list's share; null for somebody who asked with none listed. */
  share: number | null;
  asked: boolean;
}

/**
 * Who the heal could reach, split by whether their figures are known: this
 * character, and with `party` every joined member. `wants` is the healer's
 * own bookkeeping of the floor and ceiling, keyed by lower-cased name or
 * `self`, and is asked only of somebody with a share to ask it about.
 */
export function healTargets(
  state: CharacterState,
  party: boolean,
  wants: (key: string | null, share: number | null) => boolean,
  asked: (key: string) => boolean
): { figured: HealTarget[]; unfigured: UnfiguredTarget[] } {
  const figured: HealTarget[] = [];
  const unfigured: UnfiguredTarget[] = [];
  const { hp, hpMax } = state.vitals;
  const known = hp !== null && hpMax !== null && hpMax > 0;
  const wanted = wants(null, known ? hp / hpMax : null);
  if (known) figured.push({ name: null, wanted, hp, hpMax });
  if (!party) return { figured, unfigured };

  for (const member of joinedMembers(state)) {
    const key = member.name.toLowerCase();
    const request = asked(key);
    const low = wants(key, member.health);
    if (member.vitals !== null && member.vitals.hpMax > 0) {
      const { hp: memberHp, hpMax: memberMax } = member.vitals;
      figured.push({ name: member.name, wanted: request || low, hp: memberHp, hpMax: memberMax });
    } else if (request || low) {
      unfigured.push({
        name: member.name,
        share: member.health,
        asked: request
      });
    }
  }
  return { figured, unfigured };
}
