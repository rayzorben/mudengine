import { describe, expect, it } from 'vitest';

import { AttackLast } from '../AttackLast';
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import { DEFAULT_CONFIG } from '../../../shared/config';
import {
  EMPTY_CHARACTER,
  type CharacterState,
  type PartyMember,
  type RoomOccupant
} from '../../../shared/character';
import type { Block } from '../../../shared/blocks';

const block = (type: string, groups: Record<string, string> = {}): Block =>
  ({ type, seq: 1, at: 0, domain: 'combat', groups }) as unknown as Block;

/** `Flint moves to attack massive ice dragon.` (captures/046). */
const attacks = (attacker: string, target: string): Block =>
  block('player-attacks', { attacker, target });

const member = (name: string, invited = false): PartyMember =>
  ({
    name,
    className: null,
    health: null,
    mana: null,
    rank: null,
    activity: null,
    invited
  }) as PartyMember;
const mob = (name: string): RoomOccupant => ({ name, kind: 'mob' }) as RoomOccupant;

function state({
  monsters = ['massive ice dragon'],
  arrival = 1,
  members = [member('Flint')],
  fighting = 'massive ice dragon' as string | null,
  flintOn = null as string | null
} = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    name: 'Raistlin',
    inCombat: fighting !== null,
    combat: { ...base.combat, target: fighting },
    room: { ...base.room, name: 'Massive Frozen Cavern', arrival, occupants: monsters.map(mob) },
    party: {
      ...base.party,
      members,
      engaged: flintOn === null ? {} : { Flint: { kind: 'mob', target: flintOn, at: Date.now() } }
    }
  };
}

function helper(attackLast = true) {
  const notices: string[] = [];
  const last = new AttackLast(
    { ...DEFAULT_CONFIG.automation.party, attackLast },
    { notice: (m) => notices.push(m) }
  );
  return { last, notices };
}

const DRAGON = 'massive ice dragon';
const stoppedOn = (target: string): string =>
  t('automation.party.attackLastStopped', { member: 'Flint', target });

describe('AttackLast', () => {
  it('answers a party member attacking the monster this character fights', () => {
    const { last } = helper();
    expect(last.heard(attacks('Flint', `${DRAGON}.`), state())).toEqual({
      target: DRAGON,
      member: 'Flint'
    });
  });

  // The user, 2026-10-25: "if brackle moves onto another mob, same thing".
  it('answers a member moving to another monster, and a member opening a fight', () => {
    const { last } = helper();
    const two = state({ monsters: [DRAGON, 'cave bear'] });
    expect(last.heard(attacks('Flint', 'cave bear.'), two)?.target).toBe('cave bear');
    const idle = state({ monsters: ['cave bear'], fighting: null });
    expect(last.heard(attacks('Flint', 'cave bear.'), idle)?.target).toBe('cave bear');
  });

  it('answers nothing with the setting off', () => {
    const { last } = helper(false);
    expect(last.heard(attacks('Flint', `${DRAGON}.`), state())).toBeNull();
  });

  it('answers nobody outside the party, and nobody only invited', () => {
    const { last } = helper();
    expect(last.heard(attacks('Cacophonix', `${DRAGON}.`), state())).toBeNull();
    const invited = state({ members: [member('Flint', true)] });
    expect(last.heard(attacks('Flint', `${DRAGON}.`), invited)).toBeNull();
    // Positive control: the same line from a joined member.
    expect(last.heard(attacks('Flint', `${DRAGON}.`), state())).not.toBeNull();
  });

  it('answers an area attack at the monster this character fights', () => {
    const { last } = helper();
    expect(last.heard(attacks('Flint', 'everyone in the room.'), state())).toEqual({
      target: DRAGON,
      member: 'Flint'
    });
  });

  it('answers nothing aimed at this character or at a monster not here', () => {
    const { last } = helper();
    expect(last.heard(attacks('Flint', 'you!'), state())).toBeNull();
    expect(last.heard(attacks('Flint', 'cave bear.'), state())).toBeNull();
  });

  // Mutant: no count, so two members attacking last answer each other for ever.
  it('stops on a monster after its tries with no round between, said once', () => {
    const { last, notices } = helper();
    for (let tried = 0; tried < tuning().combat.attackLastTries; tried += 1) {
      expect(last.heard(attacks('Flint', `${DRAGON}.`), state())).not.toBeNull();
      last.sent(DRAGON);
    }
    expect(last.heard(attacks('Flint', `${DRAGON}.`), state())).toBeNull();
    expect(last.heard(attacks('Flint', `${DRAGON}.`), state())).toBeNull();
    expect(notices).toEqual([stoppedOn(DRAGON)]);
  });

  // The user: "it should continue attacking last EVERY TIME they attack in case they buf, attack, heal, attack".
  it('answers every attack across rounds, however many', () => {
    const { last, notices } = helper();
    for (let round = 0; round < 10; round += 1) {
      expect(last.heard(attacks('Flint', `${DRAGON}.`), state())).not.toBeNull();
      last.sent(DRAGON);
      last.roundFought();
    }
    expect(notices).toEqual([]);
  });

  it('starts over on the next monster, and on the stopped one once it has gone', () => {
    const { last } = helper();
    const two = state({ monsters: [DRAGON, 'cave bear'] });
    for (let tried = 0; tried <= tuning().combat.attackLastTries; tried += 1) {
      last.heard(attacks('Flint', `${DRAGON}.`), two);
      last.sent(DRAGON);
    }
    expect(last.heard(attacks('Flint', `${DRAGON}.`), two)).toBeNull();
    // Another monster in the same room is answered.
    expect(last.heard(attacks('Flint', 'cave bear.'), two)?.target).toBe('cave bear');
    // The dragon dies; one of the same name later is the next monster.
    last.observe(state({ monsters: ['cave bear'] }));
    expect(last.heard(attacks('Flint', `${DRAGON}.`), two)?.target).toBe(DRAGON);
  });
});
