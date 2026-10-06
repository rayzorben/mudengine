import { describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { BlessingChoice, type BlessingChoiceParts } from '../BlessingChoice';
import type { FightCharacter } from '../FightSetup';
import type { SafetyDecision } from '../../../shared/automation';
import { blessedPlayer } from '../../../shared/blessingeffects';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import type { MobEntity } from '../../../shared/entities';
import { PLAIN_ATTACK } from '../../../shared/prowess';
import { statedBasis } from '../../../shared/stated';
import { roomId, type WorldRoom, type WorldSpell } from '../../../shared/world';

/*
 * Todo 10: the blessings kept up are chosen against the fight being hunted,
 * from runs of it on the bare character, one run a slice; the choice is
 * `chooseBlessings`' and tested there.
 */

const TORTOISE: WorldSpell = {
  id: 297,
  name: 'way of the tortoise',
  short: 'tort',
  level: 12,
  mana: 3,
  duration: 45,
  targets: 1,
  difficulty: 100,
  abilities: [[7, 0]],
  power: [20, 20],
  cap: 30
};
const OWL: WorldSpell = {
  id: 37,
  name: 'way of the owl',
  short: 'owl',
  level: 3,
  mana: 2,
  duration: 60,
  targets: 1,
  difficulty: 100,
  abilities: [[36, 0]],
  power: [10, 10],
  cap: 114
};
const SPELLS = [TORTOISE, OWL];

/** A long fight of steady blows: the damage resistance a blessing adds is what decides it. */
const ogre = {
  name: 'ogre',
  source: 'realm',
  hp: 1000,
  profiles: [
    {
      attacks: [{ kind: 'melee' as const, chance: 1, accuracy: 200, min: 3, max: 6, energy: 1000 }],
      casts: []
    }
  ]
} as unknown as MobEntity;

const LAIR = {
  map: 1,
  room: 2,
  name: 'Den',
  exits: [],
  lair: '(Max 1): 7,'
} as unknown as WorldRoom;
const EMPTY = { map: 1, room: 3, name: 'Hall', exits: [] } as unknown as WorldRoom;

const CHARACTER: FightCharacter = {
  hp: 100,
  hpMax: 100,
  mana: 100,
  manaMax: 100,
  player: { armourClass: 10, damageResist: 0, magicRes: 50 },
  sheet: {
    level: 15,
    agility: 60,
    intellect: 50,
    charm: 55,
    willpower: 50,
    health: 60,
    strength: 55,
    spellcasting: 50,
    combatLevel: 4,
    mageryLevel: null,
    encumbrancePercent: 20
  },
  weapon: { min: 5, max: 12, speed: 20, strength: 30 },
  family: 'greatermud',
  weights: {
    held: 1,
    confused: 1,
    blinded: 1,
    slowed: 1,
    afraid: 1,
    summon: 1,
    teleported: 1,
    roomWide: 1,
    lastingTicks: 20,
    unitFloor: 10,
    deathOverRounds: 5
  },
  heal: null,
  regenPerRound: 0,
  recasts: [],
  levels: { safeAbove: 0.6, riskyAbove: 0.25 },
  trials: 40,
  roundCap: 80,
  horizons: [1]
};

/** Standing in a room, mana `mana`, read `seconds` after the first line. */
function standing(
  room: WorldRoom,
  seconds: number,
  mana: number,
  over: Partial<CharacterState> = {}
) {
  return {
    ...EMPTY_CHARACTER,
    phase: 'in-game' as const,
    lastStatusAt: 1_000_000 + seconds * 1000,
    room: { ...EMPTY_CHARACTER.room, map: room.map, number: room.room },
    vitals: {
      ...EMPTY_CHARACTER.vitals,
      hp: 100,
      hpMax: 100,
      mana,
      manaMax: 100,
      manaType: 'KAI' as const
    },
    progress: { ...EMPTY_CHARACTER.progress, level: 15, spellcasting: 50, damageResist: 0 },
    spellbook: SPELLS.map((spell) => ({
      name: spell.name,
      short: spell.short ?? null,
      level: spell.level ?? null,
      cost: spell.mana ?? null
    })),
    ...over
  };
}

const config: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  enabled: true,
  spells: { ...DEFAULT_CONFIG.automation.spells, autoChooseBlessings: true }
};

function choice(on: AutomationConfig = config, realmSpeed = 1) {
  const tracker = { current: standing(LAIR, 0, 0) };
  const runs = { count: 0 };
  const notices: string[] = [];
  const decisions: SafetyDecision[] = [];
  const parts: BlessingChoiceParts = {
    tracker,
    world: {
      spellNamed: (name: string) => SPELLS.find((spell) => spell.name === name) ?? null,
      byId: (id: string) => [LAIR, EMPTY].find((room) => roomId(room.map, room.room) === id),
      lairEntities: () => [ogre]
    } as unknown as BlessingChoiceParts['world'],
    errands: {
      realmSpeed,
      fitness: (state) => `ac ${state.progress.armourClass} dr ${state.progress.damageResist}`,
      realmClass: () => ({
        combat: 4,
        magery: null,
        crits: 0,
        mageryType: null,
        family: 'greatermud',
        attack: PLAIN_ATTACK
      })
    },
    setup: {
      blessed: (_bare, set) => ({
        ...CHARACTER,
        player: set === null ? CHARACTER.player : blessedPlayer(CHARACTER.player, set)
      }),
      foes: (_state, _character, met) => {
        runs.count += 1;
        return {
          foes: met.map(({ name, subject }) => ({ name, subject })),
          casting: met.map(() => null)
        };
      },
      settingsKey: () => 'settings'
    },
    hunt: { quarry: null }
  };
  const made = new BlessingChoice(parts, {
    config: () => on,
    learnedDuration: () => null,
    notice: (message) => notices.push(message),
    decided: (decision) => decisions.push(decision)
  });
  /** Twelve lines half a minute apart, the pool rising three a line: kai measured. */
  const measure = (): void => {
    for (let line = 0; line <= 12; line += 1) {
      tracker.current = standing(LAIR, line * 30, line * 3);
      made.refresh(tracker.current);
    }
  };
  return { made, tracker, runs, notices, decisions, measure };
}

describe('choosing blessings for the fight being hunted', () => {
  it('refuses on a kai pool nobody has watched rise, and says so once', async () => {
    const { made, tracker, notices, decisions } = choice();
    made.refresh(tracker.current);
    const said = t('automation.blessing.refused', {
      room: 'Den',
      why: t('automation.blessing.whyUnknownMana'),
      kept: t('automation.blessing.keptList')
    });
    await vi.waitFor(() => expect(notices).toContain(said));
    made.refresh({ ...tracker.current, lastStatusAt: 1_000_500 });
    expect(notices.filter((each) => each === said)).toHaveLength(1);
    expect(made.chosen()).toBeNull();
    expect(decisions[0]).toMatchObject({ action: 'bless', acted: false });
    made.dispose();
  });

  /* 2026-10-05: the sheet's figure is a 30s tick (`DoHPTick`); read on 121s it looked wrong for kai. */
  it('reads a kai pool’s income off the stated MA Regen, with nothing watched', async () => {
    const { made, tracker } = choice();
    const read = standing(LAIR, 0, 0);
    tracker.current = {
      ...read,
      stated: {
        against: null,
        healthRegen: null,
        restingRegen: null,
        baseManaRegen: 3,
        manaRegen: 3,
        round: null,
        basis: statedBasis(read)
      }
    };
    made.refresh(tracker.current);
    await vi.waitFor(() => expect(made.chosen()).not.toBeNull());
    made.dispose();
  });

  /* orohost runs five times faster: a blessing's stated duration is a fifth there, against an income measured in real time. */
  it('weighs a measured income against the realm’s durations, a fifth as long on a realm five times faster', async () => {
    const slow = choice(config, 1);
    slow.measure();
    await vi.waitFor(() => expect(slow.made.chosen()).not.toBeNull());
    expect(slow.made.chosen()!.map((row) => row.spell)).toEqual(['way of the tortoise']);
    slow.made.dispose();
    const fast = choice(config, 5);
    fast.measure();
    await vi.waitFor(() => expect(fast.made.chosen()).not.toBeNull());
    expect(fast.made.chosen()).toEqual([]);
    fast.made.dispose();
  });

  it('chooses the same off a stated MA Regen at any speed, its ticks and the durations both the realm’s', async () => {
    const chosen = async (speed: number) => {
      const { made, tracker } = choice(config, speed);
      const read = standing(LAIR, 0, 0);
      tracker.current = {
        ...read,
        stated: {
          against: null,
          healthRegen: null,
          restingRegen: null,
          baseManaRegen: 3,
          manaRegen: 3,
          round: null,
          basis: statedBasis(read)
        }
      };
      made.refresh(tracker.current);
      await vi.waitFor(() => expect(made.chosen()).not.toBeNull());
      const rows = made.chosen()!.map((row) => row.spell);
      made.dispose();
      return rows;
    };
    expect(await chosen(1)).toEqual(['way of the tortoise']);
    expect(await chosen(5)).toEqual(['way of the tortoise']);
  });

  it('chooses once the pool has been watched rising, the blessing that pays', async () => {
    const { made, measure } = choice();
    measure();
    await vi.waitFor(() => expect(made.chosen()).not.toBeNull());
    expect(made.chosen()!.map((row) => row.spell)).toEqual(['way of the tortoise']);
    made.dispose();
  });

  it('runs nothing again when the blessing it chose goes up', async () => {
    const { made, tracker, runs, measure } = choice();
    measure();
    await vi.waitFor(() => expect(made.chosen()).not.toBeNull());
    const before = runs.count;
    // Up: the sheet prints its damage resistance, which the bare character takes off again.
    tracker.current = standing(LAIR, 390, 39, {
      buffs: [{ spell: 'way of the tortoise', by: null, appliedAt: 0 }],
      progress: { ...tracker.current.progress, damageResist: 2 }
    });
    made.refresh(tracker.current);
    await new Promise((resolve) => setImmediate(resolve));
    expect(runs.count).toBe(before);
    made.dispose();
  });

  it('keeps the last choice where nothing is hunted, running nothing', async () => {
    const { made, tracker, runs, measure } = choice();
    measure();
    await vi.waitFor(() => expect(made.chosen()).not.toBeNull());
    const chosen = made.chosen();
    const before = runs.count;
    tracker.current = standing(EMPTY, 400, 40);
    made.refresh(tracker.current);
    await new Promise((resolve) => setImmediate(resolve));
    expect(made.chosen()).toBe(chosen);
    expect(runs.count).toBe(before);
    made.dispose();
  });

  it('runs nothing at all with the switch off', async () => {
    const { made, runs, measure } = choice({
      ...config,
      spells: { ...config.spells, autoChooseBlessings: false }
    });
    measure();
    await new Promise((resolve) => setImmediate(resolve));
    expect(runs.count).toBe(0);
    expect(made.chosen()).toBeNull();
  });
});
