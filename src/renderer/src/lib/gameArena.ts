/**
 * Who and what stands in the game view's arena (todo 140), from the character's
 * state: the party here on one side, the monsters on the other, other players
 * below, and the exits on the rim. Only the target shows a wound band; every
 * other monster's health is unknown, never full (user, 2026-10-14). Pure, so
 * the suite holds that.
 */
import type { CharacterState } from '@shared/character';
import type { ShopIcon } from '@shared/gameMap';
import { woundRange } from '@shared/wounds';
import { roomAddress, roomId, type Direction, type RoomId } from '@shared/world';
import { exitsOf } from './gameCommands';
import { SELF, type ArenaName } from './gameBlows';
import { t } from './i18n';

export interface ArenaToken {
  key: string;
  name: string;
  side: 'party' | 'foe' | 'player';
  /** Health as a share of full; null is unknown. */
  health: number | null;
  /** The wound band's span, for the target; null when unknown. */
  band: { lo: number; hi: number } | null;
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

export function arenaTokensOf(character: CharacterState, picked: string | null): ArenaToken[] {
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
      ...(member.mana === null ? {} : { pool: { share: member.mana, kai: false } }),
      hostile: false,
      target: false,
      poisoned: false,
      self: false
    });
  });
  const aimedAt = picked ?? combat.target;
  room.occupants.forEach((one, index) => {
    if (one.kind === 'player') {
      if (members.has(one.name.toLowerCase())) return;
      tokens.push({
        key: keyOf('o', one.name, index),
        name: one.name,
        side: 'player',
        health: null,
        band: null,
        hostile: false,
        target: false,
        poisoned: false,
        self: false
      });
      return;
    }
    if (one.kind !== 'mob') return;
    const target = one.name === aimedAt;
    const observed =
      target && one.name === combat.target ? (combat.health?.observed ?? null) : null;
    const [lo, hi] = observed === null ? [0, 1] : woundRange(observed);
    tokens.push({
      key: keyOf('m', one.name, index),
      name: one.name,
      side: 'foe',
      health: null,
      band: observed === null ? null : { lo, hi },
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
