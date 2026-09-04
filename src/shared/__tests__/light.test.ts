import { describe, expect, it } from 'vitest';

import { ABILITY } from '../abilities';
import {
  abilitySum,
  CAN_SEE_FROM,
  canSeeAt,
  carriedLights,
  chooseLight,
  LIGHT_REACH_ABILITY,
  lightPhrase,
  needsLightAt,
  NIGHT_VISION_ABILITY,
  ROOM_LIGHT_ABILITY,
  seenAt,
  sightOf,
  wornVision,
  type CarriedLight
} from '../light';
import { wireItem } from '../entities';

/*
 * The server's own arithmetic (`Room.GetLightLevelDesc`, `Player.ShowRoom`),
 * confirmed on the wire: `rm` prints `Room Illu: <room> (<seen>)`, and every
 * recorded session agrees with the sum below exactly. The four rows in the
 * table are those measurements (2026-09-03).
 */
describe('the light arithmetic', () => {
  it('names the three ability ids the way the realm does, so the two tables cannot drift', () => {
    expect(ABILITY[NIGHT_VISION_ABILITY]?.name).toBe('Illu');
    expect(ABILITY[ROOM_LIGHT_ABILITY]?.name).toBe('RoomIllu');
    expect(ABILITY[LIGHT_REACH_ABILITY]?.name).toBe('IlluTarget');
  });

  it('reads the four phrases off the bands the server uses', () => {
    expect(lightPhrase(-201)).toBe('pitch black');
    expect(lightPhrase(-200)).toBe('very dark');
    expect(lightPhrase(-151)).toBe('very dark');
    expect(lightPhrase(-150)).toBe('barely visible');
    expect(lightPhrase(-100)).toBe('dimly lit');
    expect(lightPhrase(-1)).toBe('dimly lit');
    expect(lightPhrase(0)).toBeNull();
    expect(lightPhrase(200)).toBeNull();
  });

  it('is readable from very dark upwards, and not below', () => {
    expect(CAN_SEE_FROM).toBe(-150);
    expect(canSeeAt(-150)).toBe(true);
    expect(canSeeAt(-151)).toBe(false);
  });

  /* A Gaunt One (night vision 200) in the Dark Cave, −175: `Room Illu: -175 (25)`. */
  it('agrees with the wire for a Gaunt One in a −175 cave', () => {
    const sight = sightOf(200, [], true);
    expect(seenAt(-175, sight)).toBe(25);
    expect(needsLightAt(-175, 200)).toBe(false);
  });

  /* A Kang with a torch lit and a carved ivory mask (Illu 25): `Room Illu: -175 (-50)`. */
  it('agrees with the wire for a Kang with a torch and a mask', () => {
    const torch: CarriedLight = { name: 'torch', reach: 100, charges: 62, lit: true };
    const sight = sightOf(25, [torch], true);
    expect(sight.total).toBe(125);
    expect(seenAt(-175, sight)).toBe(-50);
    expect(lightPhrase(-50)).toBe('dimly lit');
  });

  it('sums a worn item’s night vision and reads the pack’s lights off the realm', () => {
    const mask = {
      ...wireItem('carved ivory mask', { equipped: true }),
      abilities: [[13, 25]] as Array<[number, number]>
    };
    const torch = {
      ...wireItem('torch', { equipped: true, slot: 'Readied', charges: 62 }),
      kind: 'light' as const,
      abilities: [[54, 100]] as Array<[number, number]>
    };
    const spare = {
      ...wireItem('torch'),
      kind: 'light' as const,
      abilities: [[54, 100]] as Array<[number, number]>
    };
    expect(wornVision([mask, torch, spare])).toBe(25);
    expect(carriedLights([mask, torch, spare])).toEqual([
      { name: 'torch', reach: 100, charges: 62, lit: true },
      { name: 'torch', reach: 100, charges: null, lit: false }
    ]);
    expect(
      abilitySum(
        [
          [13, 25],
          [54, 100],
          [13, 5]
        ],
        13
      )
    ).toBe(30);
  });
});

describe('choosing a light', () => {
  const torch: CarriedLight = { name: 'torch', reach: 100, charges: null, lit: false };
  const pearl: CarriedLight = { name: 'glowing pearl', reach: 25, charges: 981, lit: false };
  const lamp: CarriedLight = { name: 'moon-lamp', reach: 200, charges: 4000, lit: false };

  it('picks the weakest light that makes the room readable', () => {
    // −175 with no night vision: the pearl leaves it at −150, which is readable.
    expect(chooseLight(-175, 0, [lamp, torch, pearl])).toEqual({
      kind: 'ready',
      light: pearl,
      guess: false
    });
    // −260: the pearl and the torch both leave it unreadable; the lamp does not.
    expect(chooseLight(-260, 0, [lamp, torch, pearl])).toEqual({
      kind: 'ready',
      light: lamp,
      guess: false
    });
  });

  it('refuses a light that would burn for nothing', () => {
    expect(chooseLight(-999, 0, [lamp, torch])).toEqual({
      kind: 'none',
      reason: 'nothing reaches'
    });
  });

  it('counts a lit light as already provided, and a spent one as nothing', () => {
    expect(chooseLight(-175, 0, [{ ...torch, lit: true }])).toEqual({ kind: 'lit' });
    expect(chooseLight(-175, 0, [{ ...torch, lit: true, charges: 0 }])).toEqual({
      kind: 'none',
      reason: 'nothing usable'
    });
    expect(chooseLight(-175, 0, [{ ...torch, lit: true, charges: 0 }, pearl])).toEqual({
      kind: 'ready',
      light: pearl,
      guess: false
    });
  });

  it('says so when the pack holds no light at all', () => {
    expect(chooseLight(-175, 0, [])).toEqual({ kind: 'none', reason: 'nothing carried' });
  });

  it('offers a light the realm cannot measure only as a guess, and never over a measured one', () => {
    const strange: CarriedLight = { name: 'odd lantern', reach: null, charges: null, lit: false };
    expect(chooseLight(-175, 0, [strange])).toEqual({ kind: 'ready', light: strange, guess: true });
    expect(chooseLight(-175, 0, [strange, torch])).toEqual({
      kind: 'ready',
      light: torch,
      guess: false
    });
  });

  it('widens the question to dim rooms when asked', () => {
    // −50 is dimly lit: readable, so not needed — unless dim rooms count.
    expect(needsLightAt(-50, 0)).toBe(false);
    expect(needsLightAt(-50, 0, true)).toBe(true);
    expect(chooseLight(-50, 0, [torch], true)).toEqual({
      kind: 'ready',
      light: torch,
      guess: false
    });
  });

  it('does not light for a race that sees the room already', () => {
    expect(needsLightAt(-175, 200)).toBe(false);
    expect(chooseLight(-175, 200, [torch])).toEqual({ kind: 'unneeded' });
  });
});
