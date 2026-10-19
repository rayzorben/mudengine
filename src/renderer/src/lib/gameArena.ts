/**
 * Who and what stands in the game view's arena (todo 140), from the character's
 * state: the party here on one side, the monsters on the other, other players
 * below, and the exits on the rim. Every monster's gauge is the fight ledger's
 * estimate (`combat.healthHere`, todo 20261018-1314-01); one with no maximum is
 * unknown, never full. Pure, so the suite holds that.
 */
import {
  healthLeft,
  vitalLevel,
  type CharacterState,
  type TargetHealth,
  type VitalLevel,
  type VitalThresholds
} from '@shared/character';
import type { ShopIcon } from '@shared/gameMap';
import { woundRange, type WoundBand } from '@shared/wounds';
import { mobKey, roomAddress, roomId, type Direction, type RoomId } from '@shared/world';
import { exitsOf } from './gameCommands';
import { SELF, type ArenaName } from './gameBlows';
import { t } from './i18n';
import { woundLevel } from './vitals';

export interface ArenaToken {
  key: string;
  name: string;
  side: 'party' | 'foe' | 'player';
  /** Health as a share of full, the gauge's solid fill; null is unknown. */
  health: number | null;
  /** The range above the fill it may also be in, drawn lighter; null when the fill is all that is known. */
  band: { lo: number; hi: number } | null;
  /** The gauge's colour: the vitals' lines for the party, the Combat card's for a monster. */
  level: VitalLevel;
  /** A monster whose name another here shares, so the two share one damage total. */
  shared: boolean;
  /** The target's hit points believed left of its maximum (`76/90`); null for any other, or unknown. */
  points: string | null;
  /** Mana or kai as a share; absent for a class with none, or unknown. */
  pool?: { share: number | null; kai: boolean };
  hostile: boolean;
  target: boolean;
  poisoned: boolean;
  self: boolean;
}

export interface ArenaExit {
  direction: Direction;
  label: string;
  door: boolean;
}

const share = (value: number | null, max: number | null): number | null =>
  value === null || max === null || max <= 0 ? null : Math.max(0, Math.min(1, value / max));

const keyOf = (side: 'p' | 'm' | 'o', name: string, index: number): string =>
  `${side}:${name.toLowerCase()}#${index}`;

/**
 * A monster's gauge from its name's estimate. A look's band is drawn lighter
 * above the fill, and is the whole gauge for a monster with no maximum.
 * Namesakes share one damage total, so each could be anywhere from that
 * total's estimate up to where the last look put it, or full: the band is that
 * range, kept rather than picking one. The colour is the worst end.
 */
function foeGauge(
  health: TargetHealth | undefined,
  namesakes: number
): Pick<ArenaToken, 'health' | 'band' | 'level' | 'shared'> {
  const shared = namesakes > 1;
  const looked = health?.observed == null ? null : lookedBand(health.observed, health.sinceLook);
  const left = health?.remaining ?? looked?.[0] ?? null;
  if (left === null) return { health: null, band: null, level: 'unknown', shared };
  const hi = Math.max(left, shared ? (looked?.[1] ?? 1) : (looked?.[1] ?? left));
  return {
    health: left,
    band: hi > left ? { lo: left, hi } : null,
    level: woundLevel(left),
    shared
  };
}

/** A look's band, less what the monster lost since: later blows come off both edges. */
function lookedBand(observed: WoundBand, sinceLook: number | null): [number, number] {
  const [lo, hi] = woundRange(observed);
  const fell = sinceLook ?? 0;
  const clamp = (share: number) => Math.max(0, Math.min(1, share));
  return [clamp(lo - fell), clamp(hi - fell)];
}

/** The target's `left/max`, while both are known. */
function pointsOf(health: TargetHealth | undefined): string | null {
  const left = healthLeft(health ?? null);
  return left === null || health?.max == null
    ? null
    : t('game.arena.points', { left, max: health.max });
}

/** How many monsters the room lists under each name, by `mobKey`: namesakes share one damage total. */
function namesakesOf(character: CharacterState): Map<string, { name: string; count: number }> {
  const counts = new Map<string, { name: string; count: number }>();
  for (const one of character.room.occupants) {
    if (one.kind !== 'mob') continue;
    const key = mobKey(one.name);
    const seen = counts.get(key);
    counts.set(key, { name: seen?.name ?? one.name, count: (seen?.count ?? 0) + 1 });
  }
  return counts;
}

/** `6 minotaur champion · 2 minotaur`: how many of each name the room lists, only when a name repeats. */
export function namesakeCounts(character: CharacterState): string | null {
  const all = [...namesakesOf(character).values()];
  return all.some((one) => one.count > 1)
    ? all.map((one) => t('game.arena.count', { count: one.count, name: one.name })).join('  ·  ')
    : null;
}

export function arenaTokensOf(
  character: CharacterState,
  picked: string | null,
  hpLines: VitalThresholds
): ArenaToken[] {
  const { vitals, room, combat, party, afflictions } = character;
  const here = new Set(
    room.occupants.filter((one) => one.kind === 'player').map((one) => one.name.toLowerCase())
  );
  const tokens: ArenaToken[] = [
    {
      key: SELF,
      name: character.name ?? t('game.arena.you'),
      side: 'party',
      health: share(vitals.hp, vitals.hpMax),
      band: null,
      level: vitalLevel(vitals.hp, vitals.hpMax, hpLines),
      shared: false,
      points: null,
      ...(vitals.manaType === null
        ? {}
        : { pool: { share: share(vitals.mana, vitals.manaMax), kai: vitals.manaType === 'KAI' } }),
      hostile: false,
      target: false,
      poisoned: afflictions.poisoned === 'yes',
      self: true
    }
  ];
  const members = new Set<string>();
  party.members.forEach((member, index) => {
    const name = member.name.toLowerCase();
    if (name === character.name?.toLowerCase() || !here.has(name)) return;
    members.add(name);
    tokens.push({
      key: keyOf('p', member.name, index),
      name: member.name,
      side: 'party',
      health: member.health,
      band: null,
      level: vitalLevel(member.health, 1, hpLines),
      shared: false,
      points: null,
      ...(member.mana === null ? {} : { pool: { share: member.mana, kai: false } }),
      hostile: false,
      target: false,
      poisoned: false,
      self: false
    });
  });
  const aimedAt = picked ?? combat.target;
  const namesakes = namesakesOf(character);
  room.occupants.forEach((one, index) => {
    if (one.kind === 'player') {
      if (members.has(one.name.toLowerCase())) return;
      tokens.push({
        key: keyOf('o', one.name, index),
        name: one.name,
        side: 'player',
        health: null,
        band: null,
        level: 'unknown',
        shared: false,
        points: null,
        hostile: false,
        target: false,
        poisoned: false,
        self: false
      });
      return;
    }
    if (one.kind !== 'mob') return;
    const target = one.name === aimedAt;
    const key = mobKey(one.name);
    tokens.push({
      key: keyOf('m', one.name, index),
      name: one.name,
      side: 'foe',
      ...foeGauge(combat.healthHere[key], namesakes.get(key)?.count ?? 1),
      points: target ? pointsOf(combat.healthHere[key]) : null,
      hostile: one.disposition === 'hostile',
      target,
      poisoned: false,
      self: false
    });
  });
  return tokens;
}

/** The names a fight line can name, for `blowOf`: everyone on the arena but the character. */
export function arenaNames(tokens: readonly ArenaToken[]): ArenaName[] {
  return tokens.filter((one) => !one.self).map((one) => ({ key: one.key, name: one.name }));
}

/**
 * The rim's exits, each named by the next room: the wire's name, else the
 * map's (`nameAt`, from the plane the view is drawing), else none.
 */
export function arenaExitsOf(
  character: CharacterState,
  nameAt: (direction: Direction) => string | null = () => null
): ArenaExit[] {
  return exitsOf(character).map((exit) => {
    const name = exit.name ?? nameAt(exit.direction);
    return {
      direction: exit.direction,
      label: exit.blocked
        ? t('game.arena.exitDoor', { name: name ?? exit.direction })
        : (name ?? ''),
      door: exit.blocked
    };
  });
}

/** A lost room's candidates, the places it might be. */
export function candidatesOf(character: CharacterState): RoomId[] {
  return roomAddress(character.room) === null
    ? character.room.candidates.map((one) => roomId(one.map, one.room))
    : [];
}

const PLACE_LABEL: Record<ShopIcon, () => string> = {
  bank: () => t('game.places.bank'),
  temple: () => t('game.places.temple'),
  tavern: () => t('game.places.tavern'),
  inn: () => t('game.places.inn'),
  trainer: () => t('game.places.trainer'),
  weapons: () => t('game.places.weapons'),
  bows: () => t('game.places.bows'),
  armour: () => t('game.places.armour'),
  shields: () => t('game.places.shields'),
  clothing: () => t('game.places.clothing'),
  magic: () => t('game.places.magic'),
  songs: () => t('game.places.songs'),
  jewels: () => t('game.places.jewels'),
  goods: () => t('game.places.goods'),
  potions: () => t('game.places.potions'),
  food: () => t('game.places.food'),
  boats: () => t('game.places.boats'),
  keys: () => t('game.places.keys'),
  deeds: () => t('game.places.deeds'),
  recycler: () => t('game.places.recycler'),
  oddities: () => t('game.places.oddities'),
  furniture: () => t('game.places.furniture'),
  guild: () => t('game.places.guild')
};

/** What a place's icon says, for the legend and the arena's banner. */
export function placeLabel(icon: ShopIcon): string {
  return PLACE_LABEL[icon]();
}
