import { describe, expect, it } from 'vitest';

import { Appraisal, type AppraisalParts } from '../Appraisal';
import { tuning } from '../../app/tuning';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import type { MobEntity } from '../../../shared/entities';
import { weighRoom, type MenacePlayer } from '../../../shared/menace';

const player: MenacePlayer = { armourClass: 10, damageResist: 2, magicRes: 20 };
const skeleton = {
  hp: 300,
  profiles: [
    {
      attacks: [{ kind: 'melee', chance: 1, accuracy: 60, min: 25, max: 45, energy: 500 }],
      casts: []
    }
  ]
} as unknown as MobEntity;

const occupant = (name: string, mob: MobEntity | undefined): RoomOccupant => ({
  name,
  ...(mob === undefined ? {} : { mob }),
  kind: 'mob',
  disposition: null,
  uncertain: false,
  costly: 'none' as RoomOccupant['costly'],
  charmed: false,
  hidden: false,
  free: false
});

function appraisal(): Appraisal {
  const parts = {
    tracker: { current: EMPTY_CHARACTER },
    world: undefined,
    errands: {
      menacePlayer: () => player,
      realmClass: () => ({ combat: null, magery: null, family: null, attack: null })
    },
    setup: { character: () => null, foes: () => ({}) },
    odds: { mob: () => undefined }
  } as unknown as AppraisalParts;
  return new Appraisal(parts, {
    config: () => DEFAULT_CONFIG.automation,
    watched: () => ({})
  });
}

const fighting = (occupants: RoomOccupant[]): CharacterState => {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    room: { ...base.room, occupants },
    combat: { ...base.combat, attackers: occupants.map((who) => who.name) }
  };
};

describe('what the monsters in the fight hit for a round', () => {
  it('is the world database figure, summed over what fights', () => {
    const [one] = weighRoom([skeleton, skeleton], player, tuning().menace);
    const both = appraisal().fightPerRound(
      fighting([occupant('thin blood skeleton', skeleton), occupant('blood skeleton', skeleton)])
    );
    expect(one).not.toBeNull();
    expect(both).toBeCloseTo(2 * (one?.perRound ?? 0));
    expect(both).toBeGreaterThan(0);
  });

  it('is unknown when the world database cannot weigh one of them', () => {
    const state = fighting([
      occupant('thin blood skeleton', skeleton),
      occupant('something new', undefined)
    ]);
    expect(appraisal().fightPerRound(state)).toBeNull();
  });

  it('is unknown with nothing fighting', () => {
    const state = fighting([]);
    expect(appraisal().fightPerRound(state)).toBeNull();
  });
});
