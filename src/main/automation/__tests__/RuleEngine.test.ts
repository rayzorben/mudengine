import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import {
  RuleEngine,
  countMobs,
  countThreats,
  interpolate,
  readField,
  testGuard
} from '../RuleEngine';
import { DEFAULT_CONFIG, normalizeRules, parseGuard } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import { classifyOccupant, type MobDisposition } from '../../../shared/mobs';
import type { Block } from '../../../shared/blocks';
import type { Rule } from '../../../shared/rules';

function stateWith(patch: Partial<CharacterState>): CharacterState {
  return { ...structuredClone(EMPTY_CHARACTER), phase: 'in-game', ...patch };
}

function vitals(patch: Partial<CharacterState['vitals']>): CharacterState {
  return stateWith({ vitals: { ...structuredClone(EMPTY_CHARACTER).vitals, ...patch } });
}

function block(type: string, groups: Record<string, string> = {}): Block {
  return {
    seq: 1,
    at: Date.now(),
    type: type as never,
    domain: 'combat',
    groups,
    text: '',
    confidence: 0.8
  };
}

let sent: string[];
let queue: CommandQueue;
let engine: RuleEngine;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  queue = new CommandQueue(
    {
      ...DEFAULT_CONFIG.automation,
      pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
    },
    { send: (command) => sent.push(command) }
  );
  engine = new RuleEngine(queue);
});

afterEach(() => {
  engine.dispose();
  queue.dispose();
  vi.useRealTimers();
});

describe('reading state', () => {
  it('computes percentages only when the maximum is known', () => {
    expect(readField('hp.percent', vitals({ hp: 25, hpMax: 50 }))).toBe(0.5);
    // Not zero: an unknown maximum is not a full or empty bar.
    expect(readField('hp.percent', vitals({ hp: 25, hpMax: null }))).toBeUndefined();
  });

  it('counts monsters rather than people', () => {
    /*
     * With no realm data and no roster this falls back to the capitalisation
     * heuristic, which is what it always was — a proper noun is a player or a
     * named NPC. What is new is that it is now the *last* test rather than the
     * only one; the cases where something better can answer are covered where
     * the classifier itself is.
     */
    expect(countMobs(occupants(['a large rat', 'Vaelor', 'an orc rogue']))).toBe(2);
    expect(countMobs([])).toBe(0);
  });

  /*
   * Monsters that will open the fight themselves, which is the number auto-
   * combat acts on. Counted against this character's own standing, and an
   * unknown standing makes a conditional monster unknown rather than harmless.
   */
  it('counts only the monsters that attack on sight', () => {
    const room = {
      ...EMPTY_CHARACTER.room,
      occupants: [
        mob('giant rat', 'hostile'),
        mob('shopkeeper', 'passive'),
        mob('town guard', 'hates-evil')
      ]
    };
    const outlaw: CharacterState = {
      ...EMPTY_CHARACTER,
      name: 'Vaelor',
      room,
      online: [
        {
          name: 'Vaelor',
          alignment: 'Outlaw',
          title: null,
          flags: null,
          gang: null,
          provisional: false
        }
      ]
    };

    // The guard attacks outlaws; the shopkeeper attacks nobody.
    expect(countThreats(outlaw)).toBe(2);
    // With no listing to say how the realm ranks this character, the guard is
    // unknown rather than harmless — and unknown is not counted.
    expect(countThreats({ ...EMPTY_CHARACTER, room })).toBe(1);
  });
});

/** `Also here:` entries, through the real classifier. */
function occupants(names: string[]): RoomOccupant[] {
  return names.map((name) =>
    classifyOccupant(name, { players: new Set<string>(), mob: () => undefined })
  );
}

/** One monster the realm data can place. */
function mob(name: string, disposition: MobDisposition): RoomOccupant {
  return classifyOccupant(name, {
    players: new Set<string>(),
    mob: () => ({ disposition, uncertain: false, costly: 'never' })
  });
}

describe('guards', () => {
  it('compares numbers', () => {
    const state = vitals({ hp: 20, hpMax: 100 });
    expect(testGuard({ field: 'hp.percent', op: '<', value: 0.5 }, state)).toBe(true);
    expect(testGuard({ field: 'hp.percent', op: '>', value: 0.5 }, state)).toBe(false);
  });

  it('fails a comparison against an unknown value rather than assuming zero', () => {
    // Treating "not known yet" as zero is how a bot decides it is on 0% health
    // and runs from a fight it was winning.
    const unknown = vitals({ hp: null, hpMax: null });
    expect(testGuard({ field: 'hp.percent', op: '<', value: 0.5 }, unknown)).toBe(false);
    expect(testGuard({ field: 'hp.percent', op: '!=', value: 0.5 }, unknown)).toBe(true);
  });

  it('compares booleans and strings by equality only', () => {
    const fighting = stateWith({ inCombat: true });
    expect(testGuard({ field: 'inCombat', op: '==', value: true }, fighting)).toBe(true);
    expect(testGuard({ field: 'phase', op: '==', value: 'in-game' }, fighting)).toBe(true);
    // Ordering a boolean is an authoring mistake, not a comparison to invent.
    expect(testGuard({ field: 'inCombat', op: '>', value: true }, fighting)).toBe(false);
  });
});

describe('parsing guards from config', () => {
  it('reads the written form', () => {
    expect(parseGuard('hp.percent < 0.5')).toEqual({ field: 'hp.percent', op: '<', value: 0.5 });
    expect(parseGuard('inCombat == false')).toEqual({ field: 'inCombat', op: '==', value: false });
    expect(parseGuard('phase == in-game')).toEqual({ field: 'phase', op: '==', value: 'in-game' });
  });

  it('rejects an unknown field or operator instead of accepting it', () => {
    // A guard that quietly never matches is a rule that quietly never fires.
    expect(parseGuard('hitpoints < 5')).toBeNull();
    expect(parseGuard('hp =~ 5')).toBeNull();
    expect(parseGuard('nonsense')).toBeNull();
  });
});

describe('loading rules', () => {
  it('accepts a well-formed rule', () => {
    const rules = normalizeRules([
      { name: 'rest', when: 'state', if: ['hp.percent < 0.5'], then: 'rest' }
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ name: 'rest', when: { kind: 'state' } });
    expect(rules[0]?.then[0]).toMatchObject({ command: 'rest', priority: 'combat' });
  });

  it('refuses a rule whose guard did not parse', () => {
    // Dropping a guard *widens* a rule, so the whole rule goes instead.
    expect(normalizeRules([{ name: 'x', when: 'state', if: ['bogus < 1'], then: 'rest' }])).toEqual(
      []
    );
  });

  it('refuses a rule with nothing to do', () => {
    expect(normalizeRules([{ name: 'x', when: 'state', then: [] }])).toEqual([]);
  });

  it('reads the trigger forms', () => {
    const read = (when: string) => normalizeRules([{ name: when, when, then: 'x' }])[0]?.when;
    expect(read('state')).toEqual({ kind: 'state' });
    expect(read('mid-round')).toEqual({ kind: 'mid-round' });
    expect(read('every 30s')).toEqual({ kind: 'timer', everyMs: 30_000 });
    expect(read('every 500ms')).toEqual({ kind: 'timer', everyMs: 500 });
    expect(read('mob-hits')).toEqual({ kind: 'block', type: 'mob-hits' });
  });

  it('drops a duplicate rule name, keeping the first', () => {
    const rules = normalizeRules([
      { name: 'a', when: 'state', then: 'first' },
      { name: 'a', when: 'state', then: 'second' }
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.then[0]?.command).toBe('first');
  });
});

describe('firing', () => {
  const restRule: Rule = {
    name: 'rest when hurt',
    enabled: true,
    when: { kind: 'state' },
    if: [
      { field: 'hp.percent', op: '<', value: 0.5 },
      { field: 'inCombat', op: '==', value: false }
    ],
    then: [{ command: 'rest', priority: 'combat', coalesce: 'rest' }],
    cooldownMs: 0
  };

  it('fires when every guard holds', () => {
    engine.load([restRule]);
    engine.onState(vitals({ hp: 20, hpMax: 100 }));
    expect(sent).toEqual(['rest']);
  });

  it('does not fire when a guard fails, and says which', () => {
    engine.load([restRule]);
    engine.onState(
      stateWith({ inCombat: true, vitals: { ...EMPTY_CHARACTER.vitals, hp: 20, hpMax: 100 } })
    );
    expect(sent).toEqual([]);
    expect(engine.firings.at(-1)?.blockedBy).toContain('inCombat');
  });

  it('never fires outside the realm', () => {
    // Rules describe what to do about a situation; at a login menu there is not
    // one, and sending `rest` to a password prompt is worse than doing nothing.
    engine.load([restRule]);
    engine.onState({ ...vitals({ hp: 1, hpMax: 100 }), phase: 'authenticating' });
    expect(sent).toEqual([]);
  });

  it('respects a cooldown', () => {
    engine.load([{ ...restRule, cooldownMs: 5000 }]);
    const hurt = vitals({ hp: 20, hpMax: 100 });
    engine.onState(hurt);
    engine.onState(hurt);
    expect(sent).toEqual(['rest']);

    vi.advanceTimersByTime(5100);
    engine.onState(hurt);
    expect(sent).toEqual(['rest', 'rest']);
  });

  it('fires on a block trigger and interpolates its captures', () => {
    engine.load([
      {
        name: 'fight back',
        enabled: true,
        when: { kind: 'block', type: 'mob-hits' },
        if: [],
        then: [{ command: 'attack {attacker}', priority: 'combat' }],
        cooldownMs: 0
      }
    ]);
    engine.onState(stateWith({}));
    engine.onBlock(block('mob-hits', { attacker: 'orc rogue' }));
    expect(sent).toEqual(['attack orc rogue']);
  });

  it('sends nothing when a placeholder cannot be filled', () => {
    // Typing `attack {target}` into the game is worse than doing nothing.
    engine.load([
      {
        name: 'fight back',
        enabled: true,
        when: { kind: 'block', type: 'mob-hits' },
        if: [],
        then: [{ command: 'attack {target}', priority: 'combat' }],
        cooldownMs: 0
      }
    ]);
    engine.onState(stateWith({}));
    engine.onBlock(block('mob-hits', { attacker: 'orc' }));
    expect(sent).toEqual([]);
  });

  /*
   * And says so. The rule matched, every action came out empty, nothing was
   * sent and — because `record` sits after the return — nothing reached the
   * trace either. The only symptom was a rule the player was sure should have
   * fired, which is the silent decline this codebase refuses everywhere else.
   */
  it('says once that a matched rule had nothing to fill its placeholder with', () => {
    const notices: string[] = [];
    engine.dispose();
    engine = new RuleEngine(queue, { notice: (message) => notices.push(message) });
    engine.load([
      {
        name: 'fight back',
        enabled: true,
        when: { kind: 'block', type: 'mob-hits' },
        if: [],
        then: [{ command: 'attack {target}', priority: 'combat' }],
        cooldownMs: 0
      }
    ]);
    engine.onState(stateWith({}));
    engine.onBlock(block('mob-hits', { attacker: 'orc' }));
    engine.onBlock(block('mob-hits', { attacker: 'orc' }));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('fight back');
    expect(notices[0]).toContain('attack {target}');

    // A fresh connection says it again: the reason may well have changed.
    engine.reset();
    engine.onState(stateWith({}));
    engine.onBlock(block('mob-hits', { attacker: 'orc' }));
    expect(notices).toHaveLength(2);
  });

  it('fires mid-round, shortly after a combat message', () => {
    // Inside a round rather than between rounds — the one piece of timing
    // knowledge worth taking from tproxy.
    engine.load([
      {
        name: 'mid round',
        enabled: true,
        when: { kind: 'mid-round' },
        if: [],
        then: [{ command: 'bash', priority: 'combat' }],
        cooldownMs: 0
      }
    ]);
    engine.onState(stateWith({}));
    engine.onBlock(block('user-hits', {}));
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(150);
    expect(sent).toEqual(['bash']);
  });

  it('keeps a trace of what it did and why', () => {
    engine.load([restRule]);
    engine.onState(vitals({ hp: 20, hpMax: 100 }));
    expect(engine.firings.at(-1)).toMatchObject({ rule: 'rest when hurt', commands: ['rest'] });
  });

  it('does nothing before any state has been seen', () => {
    engine.load([restRule]);
    engine.onBlock(block('mob-hits', {}));
    expect(sent).toEqual([]);
  });
});

describe('interpolate', () => {
  it('prefers a block capture, then falls back to state', () => {
    const state = vitals({ hp: 42, hpMax: 100 });
    expect(interpolate('attack {attacker}', block('mob-hits', { attacker: 'rat' }), state)).toBe(
      'attack rat'
    );
    expect(interpolate('say {hp}', null, state)).toBe('say 42');
  });

  it('leaves an unresolvable placeholder in place, so the caller can refuse it', () => {
    expect(interpolate('attack {nobody}', null, stateWith({}))).toBe('attack {nobody}');
  });
});

/*
 * A rule that says "run below 30%" is one anybody can write. A rule that says
 * "attack what is already attacking me", or "leave when there are three of
 * them", needs the client to know what fight it is in.
 */
describe('guards over the fight', () => {
  const fighting = (over: Partial<CharacterState['combat']> = {}): CharacterState => ({
    ...EMPTY_CHARACTER,
    phase: 'in-game',
    inCombat: true,
    combat: {
      engaged: true,
      target: null,
      targetEntity: null,
      attackers: [],
      health: null,
      lastBlowAt: 1,
      blows: 1,
      ...over
    }
  });

  it('reads what this character is fighting, by name', () => {
    expect(readField('target', fighting({ target: 'orc rogue' }))).toBe('orc rogue');
  });

  /*
   * Unknown, not empty. An unknown value fails every comparison but `!=`, which
   * is what stops a rule that attacks `{target}` firing before there is one.
   */
  it('reports no target as unknown rather than as nothing', () => {
    expect(readField('target', fighting())).toBeUndefined();
    expect(testGuard({ field: 'target', op: '!=', value: 'orc rogue' }, fighting())).toBe(true);
    expect(testGuard({ field: 'target', op: '==', value: 'orc rogue' }, fighting())).toBe(false);
  });

  it('counts what is hitting this character', () => {
    expect(readField('attackers', fighting({ attackers: ['orc rogue', 'cave rat'] }))).toBe(2);
    expect(
      testGuard({ field: 'attackers', op: '>', value: 1 }, fighting({ attackers: ['a', 'b'] }))
    ).toBe(true);
  });

  it('counts nothing as nothing, because zero attackers is a known quantity', () => {
    // Distinct from `target`, which is genuinely unknown until it swings: an
    // empty attacker list is a measurement, not an absence.
    expect(readField('attackers', fighting())).toBe(0);
  });
});

/*
 * The party listing is the only place another member's health is visible, and
 * it is only as current as the last `party`. A rule keeps it fresh — one
 * command while there is a party to watch, and none at all when there is not.
 */
describe('guards over the party', () => {
  const withParty = (count: number): CharacterState => ({
    ...EMPTY_CHARACTER,
    phase: 'in-game',
    party: {
      engaged: {},
      threatened: {},
      following: null,
      members: Array.from({ length: count }, (_, i) => ({
        name: `Member${i}`,
        activity: null,
        className: null,
        health: null,
        invited: false,
        vitals: null,
        mana: null,
        rank: null
      }))
    }
  });

  it('counts who is travelling with this character', () => {
    expect(readField('partySize', withParty(3))).toBe(3);
  });

  /* Zero is a measurement, not an absence: "alone" is something a rule can
     legitimately compare against, unlike an unknown target. */
  it('reports being alone as zero rather than as unknown', () => {
    expect(readField('partySize', withParty(0))).toBe(0);
    expect(testGuard({ field: 'partySize', op: '>', value: 0 }, withParty(0))).toBe(false);
    expect(testGuard({ field: 'partySize', op: '>', value: 0 }, withParty(2))).toBe(true);
  });
});

/*
 * Sneaking is what decides whether the things in the next room notice you
 * arrive, so a rule that walks somewhere dangerous wants to guard on it.
 */
describe('guards over stealth', () => {
  const moving = (stealth: CharacterState['stealth']): CharacterState => ({
    ...EMPTY_CHARACTER,
    phase: 'in-game',
    stealth
  });

  it('reads what the server said', () => {
    expect(readField('stealth', moving('sneaking'))).toBe('sneaking');
    expect(readField('stealth', moving('seen'))).toBe('seen');
  });

  /*
   * Unknown is not `seen`. A rule that guards on being unseen must not fire
   * because nothing has happened yet, and one that guards on being seen must
   * not fire before anybody has looked.
   */
  it('reports "nobody has said" as unknown rather than as seen', () => {
    expect(readField('stealth', moving('unknown'))).toBeUndefined();
    expect(testGuard({ field: 'stealth', op: '==', value: 'seen' }, moving('unknown'))).toBe(false);
    expect(testGuard({ field: 'stealth', op: '==', value: 'sneaking' }, moving('unknown'))).toBe(
      false
    );
  });
});
