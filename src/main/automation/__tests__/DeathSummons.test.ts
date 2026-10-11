import { describe, expect, it } from 'vitest';
import { DeathSummons } from '../DeathSummons';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import { domainOf, type Block, type BlockType } from '../../../shared/blocks';
import type { MobEntity } from '../../../shared/entities';

let seq = 0;
function block(type: BlockType, groups: Record<string, string> = {}): Block {
  seq += 1;
  return {
    seq,
    at: 1_700_000_000_000 + seq,
    type,
    domain: domainOf(type),
    groups,
    text: '',
    terminator: 'newline',
    confidence: 0.8
  };
}

/** A monster as the wire alone knows it: a name, nothing from the realm. */
function wireMob(name: string): MobEntity {
  return {
    name,
    rawName: name,
    source: 'wire',
    charmed: false,
    disposition: null,
    uncertain: false,
    costly: 'never'
  };
}

/** Gmud's large gibbering horror: death spell 383 brings two of row 306 (todo 57 census). */
const HORROR: MobEntity = {
  ...wireMob('large gibbering horror'),
  deathSpell: 383,
  spells: { 383: { id: 383, name: 'large divides', summons: [[[306, 1]], [[306, 1]]] } }
};
const RAT: MobEntity = wireMob('giant rat');

function occupant(mob: MobEntity): RoomOccupant {
  return { name: mob.name, mob, kind: 'mob', disposition: null } as RoomOccupant;
}

function fighting(target: string | null, ...here: MobEntity[]): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    inCombat: true,
    combat: { ...base.combat, target },
    room: { ...base.room, occupants: here.map(occupant) }
  };
}

function watch(): { reads: string[]; summons: DeathSummons } {
  const reads: string[] = [];
  return { reads, summons: new DeathSummons({ ask: (reason) => reads.push(reason ?? '') }) };
}

describe('a kill whose death spell summons', () => {
  it('reads the room again when the target that paid out summons on dying', () => {
    const { reads, summons } = watch();
    summons.onBlock(
      block('user-gain-experience', { exp: '333' }),
      fighting('large gibbering horror', HORROR, RAT)
    );
    expect(reads).toHaveLength(1);
  });

  it('reads it for a sentence naming one, whoever landed the kill', () => {
    const { reads, summons } = watch();
    summons.onBlock(block('mob-dies', { line: 'large gibbering horror' }), fighting(null, HORROR));
    expect(reads).toHaveLength(1);
  });

  it('leaves the room alone for a kill whose death spell brings nobody', () => {
    const { reads, summons } = watch();
    // Positive control first: the same room with the summoner as target reads.
    summons.onBlock(
      block('user-gain-experience', { exp: '9' }),
      fighting('large gibbering horror', RAT, HORROR)
    );
    expect(reads).toHaveLength(1);
    summons.onBlock(
      block('user-gain-experience', { exp: '9' }),
      fighting('giant rat', RAT, HORROR)
    );
    summons.onBlock(block('mob-dies', { line: 'giant rat' }), fighting(null, RAT, HORROR));
    expect(reads).toHaveLength(1);
  });

  it('reads it for experience nobody can name while a summoner is in the room', () => {
    const { reads, summons } = watch();
    summons.onBlock(block('user-gain-experience', { exp: '216' }), fighting(null, RAT, HORROR));
    expect(reads).toHaveLength(1);
  });

  it('reads nothing outside the realm', () => {
    const { reads, summons } = watch();
    const outside = {
      ...fighting('large gibbering horror', HORROR),
      phase: 'authenticating' as const
    };
    summons.onBlock(block('user-gain-experience', { exp: '333' }), outside);
    expect(reads).toEqual([]);
  });
});
