import { describe, expect, it } from 'vitest';

import type { ProwessSheet } from '../prowess';
import { chooseDebuff, rankRoomSpells, weighsAsRoomAttack, type RoomCaster } from '../roomspells';
import type { SpellTarget } from '../spellchoice';
import type { WorldSpell } from '../world';

/* Rows as the Paradigm database states them (resources/world/paradigm.jsonl.gz, todo 55's census). */
const REALM: Record<string, WorldSpell> = {
  fireball: {
    id: 1,
    name: 'fireball',
    level: 15,
    mana: 34,
    energy: 1000,
    targets: 12,
    abilities: [[17, 0]],
    power: [26, 40]
  },
  swarm: {
    id: 2,
    name: 'swarm',
    level: 12,
    mana: 28,
    energy: 1000,
    targets: 12,
    abilities: [[17, 0]],
    power: [17, 28]
  },
  banish: {
    id: 3,
    name: 'banish',
    level: 40,
    mana: 100,
    targets: 12,
    abilities: [[1, 2]],
    power: [2417, 2429]
  },
  'magic missile': {
    id: 4,
    name: 'magic missile',
    level: 1,
    mana: 1,
    targets: 8,
    abilities: [[17, 0]],
    power: [6, 15]
  },
  corrosion: {
    id: 5,
    name: 'corrosion',
    level: 24,
    mana: 15,
    targets: 12,
    duration: 1,
    durationGrowth: [1, 4],
    cap: 40,
    abilities: [
      [2, 0],
      [36, -10],
      [7, -50]
    ],
    power: [-8, -8]
  }
};

const BOOK = Object.values(REALM).map((row) => ({
  name: row.name,
  short: null,
  level: row.level ?? null,
  cost: row.mana ?? null
}));

/* No spellcasting figure: a cast's own odds are taken as certain. */
const SHEET = {
  level: 30,
  agility: null,
  intellect: null,
  charm: null,
  willpower: null,
  health: null,
  strength: null,
  spellcasting: null,
  combatLevel: null,
  mageryLevel: null,
  encumbrancePercent: null
} as ProwessSheet;

const caster: RoomCaster = {
  book: BOOK,
  realm: (name) => REALM[name] ?? null,
  level: 30,
  sheet: SHEET,
  family: null
};

const monster = (magicRes: number | null, remaining: number | null = null): SpellTarget => ({
  remaining,
  magicRes,
  abilities: undefined
});

describe('the room spells in a book', () => {
  it('weighs only a spell aimed at every enemy whose damage is its power', () => {
    expect(weighsAsRoomAttack(REALM['fireball']!)).toBe(true);
    expect(weighsAsRoomAttack(REALM['banish']!)).toBe(false);
    expect(weighsAsRoomAttack(REALM['magic missile']!)).toBe(false);
    expect(weighsAsRoomAttack(REALM['corrosion']!)).toBe(false);
  });

  it('ranks them by damage per mana across the room', () => {
    const room = [monster(80), monster(80), monster(80)];
    const ranked = rankRoomSpells(caster, room, new Set());
    expect(ranked.map((c) => c.spell.name)).toEqual(['fireball', 'swarm']);
    // 22–34 at M.R. 80, three monsters: 84 a round for 34 mana.
    expect(ranked[0]!.perRound).toBe(84);
  });

  it('leaves out what the caller excluded, so the next takes over', () => {
    const ranked = rankRoomSpells(caster, [monster(80)], new Set(['fireball']));
    expect(ranked.map((c) => c.spell.name)).toEqual(['swarm']);
  });
});

describe('the debuff before the room spell', () => {
  const room = { realm: REALM['fireball']!, cost: 34 };

  it('casts corrosion first when the room holds out long enough to pay for it', () => {
    const choice = chooseDebuff({
      caster,
      room,
      monsters: [monster(80, 1000), monster(80, 1000), monster(80, 1000)],
      excluded: new Set()
    });
    expect(choice?.spell.name).toBe('corrosion');
    expect(choice?.area).toBe(true);
  });

  it('casts nothing first when the room dies before the debuff pays (the control)', () => {
    const choice = chooseDebuff({
      caster,
      room,
      monsters: [monster(80, 30), monster(80, 30), monster(80, 30)],
      excluded: new Set()
    });
    expect(choice).toBe(null);
  });

  it('spends nothing on a resistance nobody has read', () => {
    const choice = chooseDebuff({
      caster,
      room,
      monsters: [monster(null, 1000), monster(null, 1000), monster(null, 1000)],
      excluded: new Set()
    });
    expect(choice).toBe(null);
  });

  it('spends nothing on a room whose health nobody has read', () => {
    const choice = chooseDebuff({
      caster,
      room,
      monsters: [monster(80, 1000), monster(80), monster(80, 1000)],
      excluded: new Set()
    });
    expect(choice).toBe(null);
  });

  it('casts nothing the caller excluded', () => {
    const choice = chooseDebuff({
      caster,
      room,
      monsters: [monster(80, 1000), monster(80, 1000), monster(80, 1000)],
      excluded: new Set(['corrosion'])
    });
    expect(choice).toBe(null);
  });
});
