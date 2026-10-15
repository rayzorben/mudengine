/**
 * The room spells in a book, ranked by damage per mana across the monsters
 * in the room, and the debuff worth casting ahead of one (todo 55). A room
 * spell is one the realm aims at every enemy (`Spells.Targets` 12) with its
 * damage in the power columns; a debuff is one aimed at an enemy that lowers
 * its `M.R.` (`effectOf`). Every cast is priced by `weighCast`, the
 * single-target choice's own arithmetic. See `mudengine-automation` ›
 * `parts/combat.md` › *The room spell*.
 */
import { carriesAbility, HAZARD_ABILITY } from './abilities';
import { effectOf } from './blessingeffects';
import { magicResistance, roundsOf, scaledDuration } from './menace';
import {
  bookCost,
  castChance,
  damagesByPower,
  levelNeeded,
  levelReaches,
  weighCast,
  type SpellChoiceInput,
  type SpellTarget
} from './spellchoice';
import { spellTargeting, type CastableSpell } from './spellcraft';
import { spellReaches } from './spellReach';
import type { WorldSpell } from './world';

/**
 * Whether the realm row is a room attack: aimed at every enemy, with power,
 * and a damage row whose magnitude is that power (`AbilVal` 0). A damage row
 * stating its own figure (`banish`, `Damage 2` beside a power of 2,417) is
 * not priced off the power columns, so it is not weighed at all.
 */
export function weighsAsRoomAttack(realm: WorldSpell): boolean {
  return (
    spellTargeting(realm.targets) === 'enemies' &&
    (realm.power?.[1] ?? 0) > 0 &&
    damagesByPower(realm)
  );
}

/** Who casts, at what level, for the pricing. */
export type RoomCaster = Pick<SpellChoiceInput, 'book' | 'realm' | 'level' | 'sheet' | 'family'>;

/** Mean damage a round of `realm` does across `monsters`, each priced on its own resistances. */
export function roomRound(
  realm: WorldSpell,
  caster: RoomCaster,
  monsters: ReadonlyArray<SpellTarget>,
  level: number
): number {
  return monsters.reduce((sum, monster) => {
    const weight = weighCast(realm, caster, monster, level);
    return sum + (weight === null ? 0 : weight.expected * weight.casts);
  }, 0);
}

export interface RoomCandidate {
  spell: CastableSpell;
  realm: WorldSpell;
  cost: number | null;
  /** Mean damage a round across the room. */
  perRound: number;
  /** `perRound` over one cast's cost; null where the cost is unknown. */
  perMana: number | null;
}

/**
 * The book's room spells the character can cast at its level, best damage
 * per mana first; a spell of unknown cost after every priced one. Whether the
 * pool pays for one now is the caller's (`payable`), so the next in the list
 * is what takes over when the first cannot be paid.
 */
export function rankRoomSpells(
  caster: RoomCaster,
  monsters: ReadonlyArray<SpellTarget>,
  excluded: ReadonlySet<string>
): RoomCandidate[] {
  const ranked: RoomCandidate[] = [];
  for (const spell of caster.book) {
    if (excluded.has(spell.name)) continue;
    const realm = caster.realm(spell.name);
    if (realm === null || !weighsAsRoomAttack(realm) || !levelReaches(caster.level, spell, realm))
      continue;
    const level = caster.level ?? levelNeeded(spell, realm) ?? 1;
    const perRound = roomRound(realm, caster, monsters, level);
    if (perRound <= 0) continue;
    const cost = bookCost(spell, realm);
    const perMana = cost !== null && cost > 0 ? perRound / cost : null;
    ranked.push({ spell, realm, cost, perRound, perMana });
  }
  return ranked.sort(
    (a, b) =>
      (b.perMana ?? Number.NEGATIVE_INFINITY) - (a.perMana ?? Number.NEGATIVE_INFINITY) ||
      b.perRound - a.perRound
  );
}

/** A debuff worth its round: the spell, whether it is cast at the room, and what it buys. */
export interface DebuffChoice {
  spell: CastableSpell;
  /** Aimed at every enemy (cast bare), or at the one target (cast at it). */
  area: boolean;
  /** Extra room-spell damage over the rounds it holds, less the round it costs. */
  gain: number;
}

export interface DebuffInput {
  caster: RoomCaster;
  /** The room spell the debuff is weighed against, and what one cast of it costs. */
  room: { realm: WorldSpell; cost: number | null };
  /** Every monster in the fight or about to join it, the target first. */
  monsters: ReadonlyArray<SpellTarget>;
  /** Spells capped, refused or unpaid now, by the book's spelling. */
  excluded: ReadonlySet<string>;
}

/**
 * The debuff to cast before the room spell, or null. Weighed on `M.R.` only:
 * the room spell is what the round is spent on, and a lower armour class or
 * damage resistance helps blows nobody here is pricing (todo 55, open
 * question 1). A monster whose resistance nobody has read gains nothing, and
 * a room with any health unread gets no debuff: mana is not spent on a
 * figure the client does not have.
 *
 * It pays when the extra damage over the rounds it holds (`scaledDuration`,
 * `roundsOf`, no more than the room has health for), each monster's share
 * times the chance the debuff lands on it, beats the round of room spell it
 * costs, and buys at least the room spell's damage per mana.
 */
export function chooseDebuff(input: DebuffInput): DebuffChoice | null {
  const { caster, room, monsters } = input;
  if (monsters.length === 0) return null;
  const level = caster.level ?? 1;
  const before = roomRound(room.realm, caster, monsters, level);
  if (before <= 0) return null;
  // A room whose health nobody has read may end next round: nothing is spent on a debuff.
  if (monsters.some((m) => m.remaining === null)) return null;
  const health = monsters.reduce((sum, m) => sum + (m.remaining ?? 0), 0);
  const roundsLeft = Math.ceil(health / before);
  const roomPerMana = room.cost !== null && room.cost > 0 ? before / room.cost : null;

  let best: DebuffChoice | null = null;
  for (const spell of caster.book) {
    if (input.excluded.has(spell.name)) continue;
    const realm = caster.realm(spell.name);
    if (realm === null || !levelReaches(caster.level, spell, realm)) continue;
    // A damage spell that also lowers M.R. is a room spell, weighed by `rankRoomSpells`.
    if (carriesAbility(realm.abilities, HAZARD_ABILITY.damageWithMr)) continue;
    const aim = spellTargeting(realm.targets);
    if (aim !== 'enemy' && aim !== 'enemies') continue;
    const lowers = effectOf(realm, level)?.magicRes ?? 0;
    if (lowers >= 0) continue;
    // A monster the spell cannot touch (`spellReaches`) gains nothing from it.
    const reached = (aim === 'enemies' ? monsters : monsters.slice(0, 1)).filter(
      (m) => spellReaches(realm, m.nature) !== false
    );
    const odds = castChance(realm, caster);
    const perRound = reached.reduce((sum, m) => {
      if (m.magicRes === null) return sum;
      const lowered = { ...m, magicRes: Math.max(0, m.magicRes + lowers) };
      const extra =
        roomRound(room.realm, caster, [lowered], level) - roomRound(room.realm, caster, [m], level);
      return sum + extra * odds * (1 - magicResistance(realm, m.magicRes).resist);
    }, 0);
    if (perRound <= 0) continue;
    const bought = perRound * Math.min(roundsOf(scaledDuration(realm, level)), roundsLeft);
    const gain = bought - before;
    const cost = bookCost(spell, realm);
    const perMana = cost !== null && cost > 0 ? bought / cost : null;
    if (gain <= 0) continue;
    if (roomPerMana !== null && perMana !== null && perMana < roomPerMana) continue;
    if (best === null || gain > best.gain) best = { spell, area: aim === 'enemies', gain };
  }
  return best;
}
