import { describe, expect, it } from 'vitest';

import type { Intent } from '../CommandQueue';
import { LeaderDoors } from '../LeaderDoors';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { Block } from '../../../shared/blocks';
import type { Requirement } from '../../../shared/world';

const block = (type: string, groups: Record<string, string> = {}): Block =>
  ({ type, seq: 1, at: 0, domain: 'movement', groups }) as unknown as Block;

/** `You see Baby attempt to bash the gate to the east.` (captures/014). */
const bashSeen = (player = 'Baby'): Block =>
  block('player-bashes-door', { player, barrier: 'gate', direction: 'east' });

interface Character {
  following?: string | null;
  picklocks?: number | null;
  strength?: number | null;
  hp?: number | null;
  requirement?: Partial<Requirement> | null;
  /** Whether the realm has a record of the exit. */
  known?: boolean;
  room?: number;
}

function state({
  following = 'Baby',
  picklocks = null,
  strength = null,
  hp = 100,
  requirement = null,
  known = true,
  room = 7
}: Character = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    name: 'Vaelor',
    vitals: { ...base.vitals, hp, hpMax: 100 },
    progress: { ...base.progress, picklocks, strength },
    room: {
      ...base.room,
      map: 1,
      number: room,
      exits: [
        {
          direction: 'e',
          note: 'closed gate',
          targetMap: known ? 1 : null,
          targetRoom: 8,
          targetName: null,
          requirement:
            requirement === null ? null : ({ kind: 'door', raw: '', ...requirement } as Requirement)
        }
      ]
    },
    party: { ...base.party, following }
  };
}

function helper(party: Partial<AutomationConfig['party']> = { helpWithDoors: true }) {
  const queued: Intent[] = [];
  const notices: string[] = [];
  const config: AutomationConfig = {
    ...DEFAULT_CONFIG.automation,
    enabled: true,
    party: { ...DEFAULT_CONFIG.automation.party, ...party },
    health: { ...DEFAULT_CONFIG.automation.health, restBelow: 0.5 }
  };
  const doors = new LeaderDoors(
    config,
    { enqueue: (intent) => queued.push(intent) > 0 },
    { notice: (message) => notices.push(message) }
  );
  return { doors, queued, notices, sent: () => queued.map((intent) => intent.command) };
}

/* Todo 03: helping the leader with a door it is failing to bash. */
describe('helping the leader with doors', () => {
  it('picks when picklocks meet the door, and opens it once unlocked', () => {
    const { doors, queued, sent } = helper();
    const here = state({ picklocks: 40, strength: 90, requirement: { pickDifficulty: 30 } });
    doors.onBlock(bashSeen(), here);
    expect(sent()).toEqual(['pi e']);
    queued[0]!.onSent?.();
    doors.onBlock(block('door-changed', { state2: 'unlocked', barrier2: 'gate' }), here);
    expect(sent()).toEqual(['pi e', 'open e']);
  });

  it('opens nothing after a failed pick', () => {
    const { doors, queued, sent } = helper();
    const here = state({ picklocks: 40, requirement: { pickDifficulty: 30 } });
    doors.onBlock(bashSeen(), here);
    queued[0]!.onSent?.();
    doors.onBlock(block('skill-failed'), here);
    doors.onBlock(block('door-changed', { state2: 'unlocked' }), here);
    expect(sent()).toEqual(['pi e']);
  });

  it('bashes when only strength meets the door', () => {
    const { doors, sent } = helper();
    doors.onBlock(
      bashSeen(),
      state({ picklocks: 0, strength: 60, requirement: { pickDifficulty: 90, bashDifficulty: 60 } })
    );
    expect(sent()).toEqual(['bas e']);
  });

  it('bashes a door the realm names no figure for, and never picks on 0 picklocks', () => {
    const { doors, sent } = helper();
    doors.onBlock(bashSeen(), state({ picklocks: 0, strength: 20 }));
    expect(sent()).toEqual(['bas e']);
  });

  it('helps nobody but the leader, and nothing while switched off', () => {
    const on = helper();
    on.doors.onBlock(bashSeen('Rend'), state({ strength: 90 }));
    on.doors.onBlock(bashSeen(), state({ following: null, strength: 90 }));
    expect(on.sent()).toEqual([]);
    on.doors.onBlock(bashSeen(), state({ strength: 90 }));
    expect(on.sent()).toEqual(['bas e']);
    const off = helper({ helpWithDoors: false });
    off.doors.onBlock(bashSeen(), state({ strength: 90 }));
    expect(off.sent()).toEqual([]);
    expect(off.notices).toEqual([]);
  });

  it('says once per door when it cannot help, and why', () => {
    const { doors, sent, notices } = helper();
    const short = state({
      picklocks: 5,
      strength: 10,
      requirement: { pickDifficulty: 90, bashDifficulty: 90 }
    });
    doors.onBlock(bashSeen(), short);
    doors.onBlock(bashSeen(), short);
    expect(sent()).toEqual([]);
    expect(notices).toHaveLength(1);

    const hurt = helper();
    hurt.doors.onBlock(bashSeen(), state({ strength: 90, hp: 20 }));
    expect(hurt.sent()).toEqual([]);
    expect(hurt.notices).toHaveLength(1);

    const keyed = helper();
    keyed.doors.onBlock(
      bashSeen(),
      state({ strength: 90, requirement: { kind: 'key', keyId: 12 } })
    );
    expect(keyed.sent()).toEqual([]);
    expect(keyed.notices).toHaveLength(1);
  });

  it('picks but never bashes a door the realm has no record of', () => {
    const strong = helper();
    strong.doors.onBlock(bashSeen(), state({ strength: 90, known: false }));
    expect(strong.sent()).toEqual([]);
    expect(strong.notices).toHaveLength(1);
    const picker = helper();
    picker.doors.onBlock(bashSeen(), state({ picklocks: 40, strength: 90, known: false }));
    expect(picker.sent()).toEqual(['pi e']);
  });

  it('drops a try still queued once the room changes', () => {
    const { doors, queued } = helper();
    doors.onBlock(bashSeen(), state({ strength: 90 }));
    expect(queued[0]!.stillWanted?.()).toBe(true);
    doors.onBlock(block('prompt-status'), state({ strength: 90, room: 8 }));
    expect(queued[0]!.stillWanted?.()).toBe(false);
  });
});
