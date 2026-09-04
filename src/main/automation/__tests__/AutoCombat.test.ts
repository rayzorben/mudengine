import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoCombat } from '../AutoCombat';
import type { EngageDecision } from '../../../shared/automation';
import { CommandQueue } from '../CommandQueue';
import {
  DEFAULT_CONFIG,
  type AutomationConfig,
  type CombatConfig,
  type SpellsConfig
} from '../../../shared/config';
import {
  EMPTY_CHARACTER,
  type Adventurer,
  type CharacterState,
  type RoomOccupant
} from '../../../shared/character';
import { classifyOccupant, type AlignmentCost, type MobDisposition } from '../../../shared/mobs';
import type { Block } from '../../../shared/blocks';
import type { MobEntity } from '../../../shared/entities';
import type { MobAttack } from '../../../shared/world';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  // No pacing in the way: these tests are about what is *proposed*, and the
  // queue's own pacing has its own tests.
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

const combat = (over: Partial<CombatConfig> = {}): CombatConfig => ({
  ...DEFAULT_CONFIG.automation.combat,
  enabled: true,
  ...over
});

/** One monster the realm data can place. */
function mob(
  name: string,
  disposition: MobDisposition,
  over: { uncertain?: boolean; costly?: AlignmentCost } = {}
): RoomOccupant {
  return classifyOccupant(name, {
    players: new Set<string>(),
    mob: () => ({
      disposition,
      uncertain: over.uncertain ?? false,
      costly: over.costly ?? 'never'
    })
  });
}

/** One blow a monster can land: a full-chance slot, a round's energy. */
const bite = (min: number, max: number, accuracy = 45): MobAttack => ({
  kind: 'melee',
  chance: 1,
  accuracy,
  min,
  max,
  energy: 1000
});

/** One hostile monster the realm can weigh: placed, with a fighting profile. */
function fighter(
  name: string,
  hp: number,
  attacks: MobAttack[],
  over: Partial<MobEntity> = {}
): RoomOccupant {
  const entity: MobEntity = {
    name,
    rawName: name,
    source: 'hybrid',
    charmed: false,
    disposition: 'hostile',
    uncertain: false,
    costly: 'never',
    hp,
    profiles: [{ attacks, casts: [] }],
    ...over
  };
  return { ...mob(name, 'hostile'), mob: entity };
}

/** One occupant nothing can place beyond what the name looks like. */
function unplaced(name: string): RoomOccupant {
  return classifyOccupant(name, { players: new Set<string>(), mob: () => undefined });
}

function player(name: string): RoomOccupant {
  return classifyOccupant(name, {
    players: new Set([name.toLowerCase()]),
    mob: () => undefined
  });
}

const who = (name: string, alignment: Adventurer['alignment']): Adventurer => ({
  name,
  alignment,
  title: null,
  flags: null,
  gang: null,
  provisional: false
});

/** A character standing in a room, in the realm. */
function state(over: Partial<CharacterState> = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    name: 'Vaelor',
    ...over,
    room: { ...base.room, name: 'A Road', ...(over.room ?? {}) }
  };
}

function block(type: string, groups: Record<string, string> = {}): Block {
  return { seq: 1, at: 0, type, domain: 'combat', groups, text: '', confidence: 1 } as Block;
}

let sent: string[];
let notices: string[];
let decisions: EngageDecision[];
let queue: CommandQueue;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  decisions = [];
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

function make(config: CombatConfig, enabled = true, spells?: SpellsConfig): AutoCombat {
  return new AutoCombat(
    config,
    enabled,
    queue,
    {
      notice: (m) => notices.push(m),
      decided: (decision) => decisions.push(decision)
    },
    spells ?? DEFAULT_CONFIG.automation.spells
  );
}

/** The refusals, as `target — reason` so a test reads like the card does. */
function refusals(): string[] {
  return decisions
    .filter((decision) => !decision.acted)
    .map((decision) => `${decision.target} — ${decision.refused ?? ''}`);
}

/** Runs the queue's pacing forward so whatever was proposed reaches `sent`. */
function drain(): void {
  vi.advanceTimersByTime(500);
}

describe('opening a fight', () => {
  it('attacks a monster the realm data says would have attacked anyway', () => {
    const auto = make(combat());
    auto.onCharacter(
      state({ room: { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'hostile')] } })
    );
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  it('leaves a monster that only fights back alone', () => {
    const auto = make(combat());
    auto.onCharacter(
      state({ room: { ...EMPTY_CHARACTER.room, occupants: [mob('shopkeeper', 'passive')] } })
    );
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * The whole safety argument in one test. A player is never attacked, at any
   * setting: on a PvP realm the first blow opens a five-minute window in which
   * a disconnect is penalised and can kill, and the thing on the other end is a
   * person.
   */
  it('never attacks a player, even set to attack everything', () => {
    const auto = make(combat({ engage: 'all' }));
    auto.onCharacter(
      state({
        room: { ...EMPTY_CHARACTER.room, occupants: [player('Grimjaw')] },
        online: [who('Grimjaw', 'Villain')]
      })
    );
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * A capitalised stranger nothing has listed is `unknown`, and unknown is not
   * `mob`. A named quest NPC and a player who has not been listed yet look
   * identical from here.
   */
  it('never attacks something nothing has placed', () => {
    const auto = make(combat({ engage: 'all' }));
    auto.onCharacter(
      state({ room: { ...EMPTY_CHARACTER.room, occupants: [unplaced('Sheriff Lionheart')] } })
    );
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * Twenty-one names in the shipped realm cover rows that disagree — `giant
   * rat` among them. The card shows the worst of them because a readout should;
   * a swing is an action, and taking one on a coin toss is how a client starts
   * a fight with the town priest's twin.
   */
  it('leaves a name the realm data disagrees with itself about', () => {
    const auto = make(combat());
    auto.onCharacter(
      state({
        room: {
          ...EMPTY_CHARACTER.room,
          occupants: [mob('giant rat', 'hostile', { uncertain: true })]
        }
      })
    );
    drain();
    expect(sent).toEqual([]);
  });

  it('goes for an uncertain one when it is named outright', () => {
    const auto = make(combat({ prefer: ['giant rat'] }));
    auto.onCharacter(
      state({
        room: {
          ...EMPTY_CHARACTER.room,
          occupants: [mob('giant rat', 'hostile', { uncertain: true })]
        }
      })
    );
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  /*
   * The trade the `likely` setting is: two of the shipped realm's `giant rat`
   * rows are ChaoticEvil and one is Good, and a name cannot say which is in
   * front of you. Taking it is a choice somebody makes, not a default.
   */
  it('takes an uncertain name when told to take the likely ones', () => {
    const auto = make(combat({ engage: 'likely' }));
    auto.onCharacter(
      state({
        room: {
          ...EMPTY_CHARACTER.room,
          occupants: [mob('giant rat', 'hostile', { uncertain: true })]
        }
      })
    );
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  /*
   * Attacking a Good or LawfulGood monster costs ten evil points, cumulatively,
   * for as long as the character plays — `Mob.GetEPCostForAttacking`. That is
   * the character's standing rather than its health, and no setting spends it
   * unasked.
   */
  it('never attacks a monster the realm certainly calls good, even set to attack everything', () => {
    const auto = make(combat({ engage: 'all' }));
    auto.onCharacter(
      state({
        room: {
          ...EMPTY_CHARACTER.room,
          occupants: [mob('village dog', 'passive', { costly: 'always' })]
        }
      })
    );
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * A name whose rows disagree about the *cost* is the same coin toss as one
   * whose rows disagree about the behaviour, and belongs to the same setting.
   * Refusing it outright is what would have made this not work on `giant rat`.
   */
  it('treats a name that only sometimes costs alignment as a guess, not a refusal', () => {
    const room = {
      ...EMPTY_CHARACTER.room,
      occupants: [mob('giant rat', 'hostile', { uncertain: true, costly: 'sometimes' })]
    };
    const cautious = make(combat());
    cautious.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual([]);

    const willing = make(combat({ engage: 'likely' }));
    willing.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  it('attacks one anyway when it is named outright', () => {
    const auto = make(combat({ prefer: ['village dog'] }));
    auto.onCharacter(
      state({
        room: {
          ...EMPTY_CHARACTER.room,
          occupants: [mob('village dog', 'passive', { costly: 'always' })]
        }
      })
    );
    drain();
    expect(sent).toEqual(['a village dog']);
  });

  it('attacks everything when asked to', () => {
    const auto = make(combat({ engage: 'all' }));
    auto.onCharacter(
      state({ room: { ...EMPTY_CHARACTER.room, occupants: [mob('shopkeeper', 'passive')] } })
    );
    drain();
    expect(sent).toEqual(['a shopkeeper']);
  });

  it('starts nothing at all when told to only hit back', () => {
    const auto = make(combat({ engage: 'none' }));
    auto.onCharacter(
      state({ room: { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'hostile')] } })
    );
    drain();
    expect(sent).toEqual([]);
  });
});

/*
 * Two of the seven monster alignments decide by how the realm ranks *this*
 * character, and an unknown standing makes those unknown rather than harmless.
 */
describe('a monster that decides by your standing', () => {
  const guard = { ...EMPTY_CHARACTER.room, occupants: [mob('town guard', 'hates-evil')] };

  it('is attacked when the roster says the realm calls this character an outlaw', () => {
    const auto = make(combat());
    auto.onCharacter(state({ room: guard, online: [who('Vaelor', 'Outlaw')] }));
    drain();
    expect(sent).toEqual(['a town guard']);
  });

  it('is left alone when the realm calls this character good', () => {
    const auto = make(combat());
    auto.onCharacter(state({ room: guard, online: [who('Vaelor', 'Good')] }));
    drain();
    expect(sent).toEqual([]);
  });

  it('is left alone while nothing has said how the realm ranks this character', () => {
    const auto = make(combat());
    auto.onCharacter(state({ room: guard }));
    drain();
    expect(sent).toEqual([]);
  });
});

describe('which one to go for', () => {
  const room = {
    ...EMPTY_CHARACTER.room,
    occupants: [mob('giant rat', 'hostile'), mob('wererat shaman', 'hostile')]
  };

  /* Neither has a realm row behind it, so there is nothing to weigh and the
     listing's order — the server's own — is all there is. */
  it('takes them in the order the room listed them when the realm can weigh neither', () => {
    const auto = make(combat());
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  it('takes a named one first, whatever the room order', () => {
    const auto = make(combat({ prefer: ['wererat shaman'] }));
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['a wererat shaman']);
  });

  /* A 4.5-point bite over 30 hit points against a 20-point one over 40:
     the shaman costs more per hit point it has, and is listed second. */
  const weighed = {
    ...EMPTY_CHARACTER.room,
    occupants: [
      fighter('kobold thief', 30, [bite(1, 8, 15)]),
      fighter('wererat shaman', 40, [bite(10, 30, 60)])
    ]
  };

  it('takes the most dangerous first, whatever the room order', () => {
    const auto = make(combat());
    auto.onCharacter(state({ room: weighed }));
    drain();
    expect(sent).toEqual(['a wererat shaman']);
  });

  /* Smith's rule: 50 a round over 3,000 hit points is thirty rounds of
     taking the rat's 30 as well; the rat is a round or two and then gone. */
  it('ends the fight that costs most per hit point, not the biggest hitter', () => {
    const auto = make(combat());
    auto.onCharacter(
      state({
        room: {
          ...EMPTY_CHARACTER.room,
          occupants: [
            fighter('ogre', 3000, [bite(40, 60)]),
            fighter('giant rat', 100, [bite(25, 35)])
          ]
        }
      })
    );
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  /* Unknown is never the reassuring answer: something the realm cannot
     weigh is not assumed lighter than something it can. */
  it('goes first for one the realm cannot weigh', () => {
    const auto = make(combat());
    auto.onCharacter(
      state({
        room: {
          ...EMPTY_CHARACTER.room,
          occupants: [fighter('thug', 28, [bite(2, 11)]), mob('stranger', 'hostile')]
        }
      })
    );
    drain();
    expect(sent).toEqual(['a stranger']);
  });

  it('says why, with the figures the order was decided on', () => {
    const auto = make(combat());
    auto.onCharacter(state({ room: weighed }));
    drain();
    const acted = decisions.find((decision) => decision.acted);
    expect(acted?.target).toBe('wererat shaman');
    expect(acted?.because).toContain('the most dangerous of 2');
    expect(acted?.because).toContain('40 hp');
  });

  it('takes a named one first, whatever the weighing says', () => {
    const auto = make(combat({ prefer: ['kobold thief'] }));
    auto.onCharacter(state({ room: weighed }));
    drain();
    expect(sent).toEqual(['a kobold thief']);
  });

  it('skips one it was told never to attack', () => {
    const auto = make(combat({ avoid: ['giant rat'] }));
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['a wererat shaman']);
  });

  /* The config keys names the way the wire spells them, so case and the
     leading article cannot make a list silently miss. */
  it('matches a name however the config spelled it', () => {
    const auto = make(combat({ avoid: ['The Giant Rat'] }));
    auto.onCharacter(state({ room }));
    drain();
    // Normalisation happens in `normalizeCombat`, so go through it.
    expect(sent).toEqual(['a giant rat']);
  });
});

describe('refusing to start one', () => {
  const room = { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'hostile')] };

  it('does nothing at all while it is switched off', () => {
    const auto = make(combat({ enabled: false }));
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual([]);
  });

  it('does nothing while all automation is switched off', () => {
    const auto = make(combat(), false);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual([]);
  });

  it('does nothing before the character is in the realm', () => {
    const auto = make(combat());
    auto.onCharacter(state({ room, phase: 'authenticating' }));
    drain();
    expect(sent).toEqual([]);
  });

  it('does not open a second fight on the thing it is already swinging at', () => {
    const auto = make(combat());
    auto.onCharacter(
      state({
        room,
        inCombat: true,
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, target: 'giant rat' }
      })
    );
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * But being *in* a fight with nothing named to swing at is not a reason to
   * stand still, and it used to be. Killing one monster in a room holding two
   * clears the target and leaves the fight running; with `inCombat` as the
   * guard the client stood in it doing nothing until the server ended it.
   */
  it('picks a new target when a fight is running and nothing is named', () => {
    const auto = make(combat());
    auto.onCharacter(
      state({ room, inCombat: true, combat: { ...EMPTY_CHARACTER.combat, engaged: true } })
    );
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  it('refuses below the health it was given', () => {
    const auto = make(combat({ minHealth: 0.5 }));
    auto.onCharacter(state({ room, vitals: { ...EMPTY_CHARACTER.vitals, hp: 20, hpMax: 100 } }));
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * Unknown is not low. A maximum that has not arrived yet must never stop this
   * — the same rule that stops an unknown maximum starting a retreat.
   */
  it('does not treat an unknown maximum as low health', () => {
    const auto = make(combat({ minHealth: 0.5 }));
    auto.onCharacter(state({ room, vitals: { ...EMPTY_CHARACTER.vitals, hp: 20, hpMax: null } }));
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  it('refuses when the room holds more monsters than it was told to take on', () => {
    const auto = make(combat({ maxMobs: 1 }));
    auto.onCharacter(
      state({
        room: {
          ...EMPTY_CHARACTER.room,
          occupants: [mob('giant rat', 'hostile'), mob('kobold thief', 'hostile')]
        }
      })
    );
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * A walk stops the moment combat starts, so a client that attacked everything
   * between here and the bank would turn one route into a dozen.
   */
  it('leaves a planned route alone by default', () => {
    const auto = make(combat());
    auto.noteWalking(true);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual([]);
  });

  it('fights while walking when asked to', () => {
    const auto = make(combat({ whileWalking: true }));
    auto.noteWalking(true);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  /*
   * A loop's loop was chosen for what lives on it, so a loop's walk engages
   * whatever `whileWalking` says — the first live loop lapped the sewers
   * gaining nothing because every monster was met mid-step.
   */
  it('fights on a loop even when a plain walk would not', () => {
    const auto = make(combat({ whileWalking: false }));
    auto.noteWalking(true);
    auto.noteLooping(true);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  /*
   * Running away outranks fighting, and this is where that is enforced: a
   * client that ran from a room and swung on the way out would have spent the
   * escape and stayed in the fight.
   */
  it('starts nothing while an escape is in flight', () => {
    const auto = make(combat());
    auto.noteRetreating(true);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * Coalesced by intent, not by text: a status line arrives every few hundred
   * milliseconds and each one is a fresh look at the same room.
   */
  it('asks once for one monster however many times the room is republished', () => {
    const auto = make(combat());
    const here = state({ room });
    auto.onCharacter(here);
    auto.onCharacter(here);
    auto.onCharacter(here);
    drain();
    expect(sent).toEqual(['a giant rat']);
  });
});

/*
 * The walker's question, and the answer has to be the same one `engage` would
 * give — a beat held for a fight that is never opened is 4.5 seconds a lap, and
 * a step taken out of a room a fight *is* about to open in is the fight walked
 * out of. It is asked by a walk in progress, so `whyNot`'s `this.walking` half
 * is a given and only the policy is left to read.
 *
 * That policy used to be stated by `SessionManager` instead, as `a loop is
 * running` — the `looping` half of the same gate with `whileWalking` dropped.
 */
describe('the beat a walk takes for it', () => {
  const room = { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'hostile')] };

  it('is not asked for on a plain route, which engages nothing', () => {
    const auto = make(combat());
    expect(auto.quarry(state({ room }))).toBe(false);
  });

  it('is asked for on a loop, whose walk engages', () => {
    const auto = make(combat());
    auto.noteLooping(true);
    expect(auto.quarry(state({ room }))).toBe(true);
  });

  it('is asked for on a plain route when whileWalking is on', () => {
    const auto = make(combat({ whileWalking: true }));
    expect(auto.quarry(state({ room }))).toBe(true);
  });

  /* Every other gate is the engage path's own, so the two cannot disagree. */
  it('is not asked for where the fight would be refused anyway', () => {
    const auto = make(combat({ whileWalking: true, engage: 'none' }));
    expect(auto.quarry(state({ room }))).toBe(false);
  });

  it('is not asked for in a room with nothing in it worth stopping for', () => {
    const auto = make(combat({ whileWalking: true }));
    expect(auto.quarry(state())).toBe(false);
  });
});

describe('hitting back', () => {
  it('attacks whatever is hitting this character', () => {
    const auto = make(combat({ engage: 'none' }));
    auto.onCharacter(
      state({
        inCombat: true,
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, attackers: ['giant rat'] }
      })
    );
    drain();
    // `engage: none` and a fight already running: this is the one thing that
    // still acts, because something is already swinging.
    expect(sent).toEqual(['a giant rat']);
  });

  /* The tracker lists attackers most recent first; that says which swung
     last, not which is dangerous. */
  it('hits back at the most dangerous of several attackers, not the last to swing', () => {
    const auto = make(combat({ engage: 'none' }));
    auto.onCharacter(
      state({
        inCombat: true,
        room: {
          ...EMPTY_CHARACTER.room,
          occupants: [
            fighter('kobold thief', 30, [bite(1, 8, 15)]),
            fighter('wererat shaman', 40, [bite(10, 30, 60)])
          ]
        },
        combat: {
          ...EMPTY_CHARACTER.combat,
          engaged: true,
          attackers: ['kobold thief', 'wererat shaman']
        }
      })
    );
    drain();
    expect(sent).toEqual(['a wererat shaman']);
  });

  it('says nothing back once this character has a target of its own', () => {
    const auto = make(combat());
    auto.onCharacter(
      state({
        inCombat: true,
        combat: {
          ...EMPTY_CHARACTER.combat,
          engaged: true,
          target: 'giant rat',
          attackers: ['kobold thief']
        }
      })
    );
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * Somebody hitting this character does not make them a thing to swing at
   * unasked. Starting a PvP fight is the one decision this module will not make.
   */
  it('does not hit a player back', () => {
    const auto = make(combat());
    auto.onCharacter(
      state({
        inCombat: true,
        online: [who('Grimjaw', 'Villain')],
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, attackers: ['Grimjaw'] }
      })
    );
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * Not even this, while an escape is in flight. The move is sent first — it is in
   * the emergency band — so an attack queued behind it lands after the
   * character has moved and opens a fight in the room it ran *into*.
   */
  it('does not hit back while an escape is in flight', () => {
    const auto = make(combat());
    auto.noteRetreating(true);
    auto.onCharacter(
      state({
        inCombat: true,
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, attackers: ['giant rat'] }
      })
    );
    drain();
    expect(sent).toEqual([]);
  });

  it('can be switched off on its own', () => {
    const auto = make(combat({ retaliate: false, engage: 'none' }));
    auto.onCharacter(
      state({
        inCombat: true,
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, attackers: ['giant rat'] }
      })
    );
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * A step is unanswered, so whatever is swinging is in a room being left and
   * hitting it back would cross the move on the wire. Right, and right for
   * about as long as a command takes to be acknowledged.
   */
  it('does not hit back while a step is still waiting for its room', () => {
    const auto = make(combat());
    auto.noteMovePending(true);
    auto.onCharacter(
      state({
        inCombat: true,
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, attackers: ['giant rat'] }
      })
    );
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * **And the bound on it is not here any more** (2026-09-03).
   *
   * This module used to keep its own eight-second clock and say so when it
   * lapsed, because a step nothing ever answers held this gate shut for the
   * rest of the session. That was true and it was the wrong place: five other
   * things gate on the same fact — the escape, `Walker.start`,
   * `LoopRunner.advance` and the walk home — and none of them had a clock, so
   * a lost step let auto-combat recover after eight seconds and left the
   * character unable to run away, walk a route or run a loop all evening.
   *
   * The bound is on the claim now (`Expectations.expire`), so every consumer
   * recovers together and one notice says which step was given up on. What is
   * asserted here is only that this gate follows the fact it is handed.
   */
  it('follows the fact it is handed, and keeps no clock of its own', () => {
    const auto = make(combat());
    auto.noteMovePending(true);
    const beset = state({
      inCombat: true,
      combat: { ...EMPTY_CHARACTER.combat, engaged: true, attackers: ['slime beast'] }
    });
    auto.onCharacter(beset);
    drain();
    expect(sent).toEqual([]);

    // Time alone does not open it: the claim's own bound is what does, and it
    // arrives here as `noteMovePending(false)`.
    vi.advanceTimersByTime(60_000);
    auto.onCharacter({ ...beset, vitals: { ...beset.vitals, hp: 300 } });
    drain();
    expect(sent).toEqual([]);

    auto.noteMovePending(false);
    auto.onCharacter({ ...beset, vitals: { ...beset.vitals, hp: 299 } });
    drain();
    expect(sent).toEqual(['a slime beast']);
  });
});

describe('what to swing with', () => {
  const room = { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'hostile')] };

  it('uses the configured attack verb', () => {
    const auto = make(combat({ attack: 'bash' }));
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['bash giant rat']);
  });

  /* Once per fight: spending it is the point of having it. */
  it('spends the opener on the first blow and not the next one', () => {
    const auto = make(combat({ opener: 'bs' }));
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['bs giant rat']);

    // The fight ends, and another starts with something else in the room.
    auto.onCharacter(state({ room, inCombat: true }));
    auto.onCharacter(
      state({ room: { ...EMPTY_CHARACTER.room, occupants: [mob('kobold thief', 'hostile')] } })
    );
    drain();
    expect(sent).toEqual(['bs giant rat', 'bs kobold thief']);
  });

  /*
   * A fight that is running sends nothing of its own. The round verbs that
   * used to cycle here went on 2026-09-02: no class asks the realm for its
   * attack each round (captures/032 — one `bs ha`, then 94 lines of unprompted
   * jumpkicks), so every one of them was a command spent to be answered by
   * nothing, out of the budget the fight is being fought with. What is left on
   * the tick is the attack spell, which genuinely is one cast a round, and the
   * room re-read.
   */
  it('sends nothing on the mid-round tick for a fighter with no spell', () => {
    const auto = make(combat({ engage: 'none', refreshRounds: 0 }));
    auto.onCharacter(
      state({
        room,
        inCombat: true,
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, target: 'giant rat' }
      })
    );
    for (let i = 0; i < 6; i += 1) auto.onBlock(block('user-hits'));
    vi.advanceTimersByTime(200);
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * Re-reading the room, which is the correction rather than the source: the
   * server volunteers an arrival and an experience line, and this catches
   * whatever those miss. It is the backstop for the failure that made the whole
   * of this worth fixing — a monster killed out of the room stayed in the list
   * and was attacked once a round for as long as the fight lasted.
   */
  it('re-reads the room every few rounds while fighting', () => {
    const auto = make(combat({ engage: 'none', refreshRounds: 2 }));
    auto.onCharacter(
      state({
        room,
        inCombat: true,
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, target: 'giant rat' }
      })
    );
    for (let round = 0; round < 4; round += 1) {
      auto.onBlock(block('mob-hits'));
      vi.advanceTimersByTime(200);
    }
    drain();
    // A bare Enter, not `l`: the same block, without telling everybody in the
    // room that this character is looking around. See `REREAD_ROOM`.
    expect(sent).toEqual(['', '']);
  });

  it('never re-reads the room when it was not asked to', () => {
    const auto = make(combat({ engage: 'none', refreshRounds: 0 }));
    auto.onCharacter(
      state({
        room,
        inCombat: true,
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, target: 'giant rat' }
      })
    );
    for (let round = 0; round < 6; round += 1) {
      auto.onBlock(block('mob-hits'));
      vi.advanceTimersByTime(200);
    }
    drain();
    expect(sent).toEqual([]);
  });
});

/*
 * The arrival sentence is the only announcement a monster walking in gets, and
 * its name is read out of it by counting words — the verb is realm data. When
 * that lands short the occupant has no disposition, nothing here will swing at
 * it, and the character stands in the room being hit by something the client
 * is looking straight at. `Also here:` prints the server's own spelling, which
 * the realm's monster table can be asked about directly.
 */
describe('an arrival the realm data could not place', () => {
  const empty = () => state({ room: { ...EMPTY_CHARACTER.room, occupants: [] } });
  const holding = (occupant: RoomOccupant) =>
    state({ room: { ...EMPTY_CHARACTER.room, occupants: [occupant] } });

  it('asks the room to say it again, with a bare Enter rather than a look', () => {
    const auto = make(combat());
    auto.onCharacter(empty());
    auto.onBlock(block('mob-arrives-room', { line: 'thing lurches' }));
    auto.onCharacter(holding(unplaced('thing')));
    drain();
    // The read, and no attack: an occupant the realm cannot place is exactly
    // what `choose` declines.
    expect(sent).toEqual(['']);
  });

  /* `unknown` is the other half of "could not be placed": a capitalised name
     absent from the roster and from the monster table. */
  it('asks again for an arrival nothing could even call a monster', () => {
    const auto = make(combat());
    auto.onCharacter(empty());
    auto.onBlock(block('mob-arrives-room', { line: 'Grimjaw stalks' }));
    auto.onCharacter(holding(unplaced('Grimjaw')));
    drain();
    expect(sent).toEqual(['']);
  });

  it('spends nothing when the arrival was placed', () => {
    const auto = make(combat());
    auto.onCharacter(empty());
    auto.onBlock(block('mob-arrives-room', { attacker: 'giant rat' }));
    auto.onCharacter(holding(mob('giant rat', 'hostile')));
    drain();
    // The attack, and only the attack.
    expect(sent).toEqual(['a giant rat']);
  });

  /* A step is unanswered, so the room block would be attributed to the move —
     the expectation-queue bug in a new hat. */
  it('waits rather than re-reading a room it is leaving', () => {
    const auto = make(combat());
    auto.onCharacter(empty());
    auto.noteMovePending(true);
    auto.onBlock(block('mob-arrives-room', { line: 'thing lurches' }));
    auto.onCharacter(holding(unplaced('thing')));
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * A listing is not an arrival. Without this the answer to the re-read —
   * `Also here:` naming the same unplaceable thing — would be another re-read,
   * for as long as it stood there.
   */
  it('does not re-read its own answer', () => {
    const auto = make(combat());
    auto.onCharacter(empty());
    auto.onBlock(block('mob-arrives-room', { line: 'thing lurches' }));
    auto.onCharacter(holding(unplaced('thing')));
    drain();
    sent.length = 0;

    // The room, said again, still naming something nothing can place.
    auto.onCharacter(holding(unplaced('thing')));
    drain();
    expect(sent).toEqual([]);
  });
});

/*
 * The refusal is printed *in the room*, so a client that kept sending a verb
 * the character cannot use would announce it once a fight. The opener is what
 * is matched against one now that the round verbs are gone.
 */
describe('a verb the realm refuses', () => {
  it('is dropped for the rest of the session, and said once', () => {
    const auto = make(combat({ opener: 'bash' }));
    auto.onCharacter(
      state({ room: { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'hostile')] } })
    );
    drain();
    expect(sent).toEqual(['bash giant rat']);

    auto.onBlock(block('attack-refused', { skill: 'bashing' }));
    // A fight with something else, so the opener is available again.
    auto.onCharacter(
      state({ room: { ...EMPTY_CHARACTER.room, occupants: [mob('kobold thief', 'hostile')] } })
    );
    drain();
    expect(sent).toEqual(['bash giant rat', 'a kobold thief']);
    expect(notices.filter((n) => /bash/i.test(n))).toHaveLength(1);
  });

  /* The config says `bs`; the realm says `backstab`. Same verb. */
  it('recognises the verb through the realm’s abbreviations', () => {
    const auto = make(combat({ opener: 'bs' }));
    auto.onBlock(block('attack-refused', { skill: 'backstab' }));
    auto.onCharacter(
      state({ room: { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'hostile')] } })
    );
    drain();
    expect(sent).toEqual(['a giant rat']);
  });
});

/*
 * The attack is landing and doing nothing, and what to do about it is a
 * judgement with a character on the end of it. It is ranked on the Alerts card
 * and deliberately not echoed into the terminal — the server has already said
 * the words, in the room, in full.
 */
describe('what is said out loud, and what is not', () => {
  /*
   * The server has already said the words, in the room, in full. A client that
   * repeated them with a frame around them would be the mistake
   * `command-not-understood` already taught.
   */
  it('does not repeat a weapon-has-no-effect line into the terminal', () => {
    const auto = make(combat());
    auto.onBlock(block('attack-ineffective', { weapon: 'weapon', target: 'golem' }));
    expect(notices).toEqual([]);
  });

  /*
   * Nor an attack. The arbiter already puts every command it sends into the
   * terminal and the trace records the reason, so a notice per swing would be a
   * console full of them over a grind. An escape is announced because it is rare,
   * has a cooldown and moves the character.
   */
  it('does not announce every swing', () => {
    const auto = make(combat());
    auto.onCharacter(
      state({ room: { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'hostile')] } })
    );
    drain();
    expect(sent).toEqual(['a giant rat']);
    expect(notices).toEqual([]);
  });
});

describe('what survives what', () => {
  const fighting = () =>
    state({
      inCombat: true,
      combat: { ...EMPTY_CHARACTER.combat, engaged: true, target: 'giant rat' }
    });

  /* Within a session it is a fact about the class, so it holds across fights. */
  it('keeps a refusal across a fight ending', () => {
    const auto = make(combat({ opener: 'bash' }));
    auto.onCharacter(fighting());
    auto.onBlock(block('attack-refused', { skill: 'bashing' }));

    // The fight ends and another starts.
    auto.onCharacter(state());
    auto.onCharacter(
      state({ room: { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'hostile')] } })
    );
    drain();
    expect(sent).toEqual(['a giant rat']);
    expect(notices.filter((n) => /bash/i.test(n))).toHaveLength(1);
  });

  /*
   * A new connection forgets it, and the asymmetry is the argument: a session
   * can be pointed at a different character, and forgetting costs one refusal
   * announced in the room and corrects itself, while remembering wrongly leaves
   * a verb silently never sent with nothing on screen to say why.
   */
  it('forgets a refusal on a new connection', () => {
    const auto = make(combat({ opener: 'bash' }));
    auto.onBlock(block('attack-refused', { skill: 'bashing' }));
    auto.reset();

    auto.onCharacter(
      state({ room: { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'hostile')] } })
    );
    drain();
    expect(sent).toEqual(['bash giant rat']);
  });
});

/*
 * The one spell that is not a rule.
 *
 * `automation.rules` covers "cast this when that" and covers it better; what a
 * guard cannot express is *when* — the mid-round tick, ~100 ms after the last
 * swing, which is what decides whether the spell lands inside the round or
 * after it. That window belongs to this module, so the attack spell does too.
 */
describe('casting in a fight', () => {
  const fighting = () =>
    state({
      inCombat: true,
      combat: { ...EMPTY_CHARACTER.combat, engaged: true, target: 'giant rat' },
      vitals: { ...EMPTY_CHARACTER.vitals, mana: 40, manaMax: 100, manaType: 'MA' }
    });

  it('casts the attack spell on the mid-round tick', () => {
    const auto = make(combat({ engage: 'none' }), true, {
      attack: 'ma',
      areaAttack: '',
      areaMinMobs: 3,
      areaMinMana: 0,
      heal: '',
      healPartyWith: '',
      healBelow: 0,
      healBelowInCombat: 0,
      healTo: 0,
      healParty: false,
      minMana: 0.15,
      cures: { blindness: '', poison: '', disease: '' },
      blessings: [],
      notifyPartyOnWearOff: false
    });
    auto.onCharacter(fighting());
    auto.onBlock(block('user-hits'));
    vi.advanceTimersByTime(200);
    drain();
    expect(sent).toEqual(['c ma giant rat']);
  });

  it('names what it is casting at, so it cannot fall back to the last target', () => {
    const auto = make(combat({ engage: 'none' }), true, {
      attack: 'ice blade',
      areaAttack: '',
      areaMinMobs: 3,
      areaMinMana: 0,
      heal: '',
      healPartyWith: '',
      healBelow: 0,
      healBelowInCombat: 0,
      healTo: 0,
      healParty: false,
      minMana: 0,
      cures: { blindness: '', poison: '', disease: '' },
      blessings: [],
      notifyPartyOnWearOff: false
    });
    auto.onCharacter(fighting());
    auto.onBlock(block('mob-hits'));
    vi.advanceTimersByTime(200);
    drain();
    // The whole spell name, not a first word: the server matches on a prefix,
    // so `ice` would cast whatever begins with it.
    expect(sent).toEqual(['c ice blade giant rat']);
  });

  it('casts nothing when the mana is not there', () => {
    const auto = make(combat({ engage: 'none', refreshRounds: 0 }), true, {
      attack: 'ma',
      areaAttack: '',
      areaMinMobs: 3,
      areaMinMana: 0,
      heal: '',
      healPartyWith: '',
      healBelow: 0,
      healBelowInCombat: 0,
      healTo: 0,
      healParty: false,
      minMana: 0.9,
      cures: { blindness: '', poison: '', disease: '' },
      blessings: [],
      notifyPartyOnWearOff: false
    });
    auto.onCharacter(fighting());
    auto.onBlock(block('user-hits'));
    vi.advanceTimersByTime(200);
    drain();
    expect(sent).toEqual([]);
  });

  /* Unknown is not empty. The same asymmetry every threshold here uses. */
  it('casts when no maximum has arrived to compare against', () => {
    const auto = make(combat({ engage: 'none' }), true, {
      attack: 'ma',
      areaAttack: '',
      areaMinMobs: 3,
      areaMinMana: 0,
      heal: '',
      healPartyWith: '',
      healBelow: 0,
      healBelowInCombat: 0,
      healTo: 0,
      healParty: false,
      minMana: 0.9,
      cures: { blindness: '', poison: '', disease: '' },
      blessings: [],
      notifyPartyOnWearOff: false
    });
    auto.onCharacter(
      state({
        inCombat: true,
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, target: 'giant rat' }
      })
    );
    auto.onBlock(block('user-hits'));
    vi.advanceTimersByTime(200);
    drain();
    expect(sent).toEqual(['c ma giant rat']);
  });

  /*
   * A caster that asks for no room re-read used to get no mid-round tick at
   * all — so the spell would never have been sent.
   */
  it('arms the round tick for a caster that re-reads no room', () => {
    const auto = make(combat({ engage: 'none', refreshRounds: 0 }), true, {
      attack: 'ma',
      areaAttack: '',
      areaMinMobs: 3,
      areaMinMana: 0,
      heal: '',
      healPartyWith: '',
      healBelow: 0,
      healBelowInCombat: 0,
      healTo: 0,
      healParty: false,
      minMana: 0,
      cures: { blindness: '', poison: '', disease: '' },
      blessings: [],
      notifyPartyOnWearOff: false
    });
    auto.onCharacter(fighting());
    auto.onBlock(block('user-hits'));
    vi.advanceTimersByTime(200);
    drain();
    expect(sent).toEqual(['c ma giant rat']);
  });

  it('casts nothing when no spell is configured', () => {
    const auto = make(combat({ engage: 'none', refreshRounds: 0 }));
    auto.onCharacter(fighting());
    auto.onBlock(block('user-hits'));
    vi.advanceTimersByTime(200);
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * The room spell — MegaMUD's MultAttack. Chosen over the single-target
   * spell when the fight is crowded enough, cast bare because that is how the
   * wire shows an area cast (`pclo` → `You cast poison cloud on the room!`,
   * captures/131), and holding its own mana floor above the ordinary one.
   */
  describe('the crowd spell', () => {
    const spells = (over: Partial<SpellsConfig> = {}): SpellsConfig => ({
      attack: 'ma',
      areaAttack: 'poison cloud',
      areaMinMobs: 3,
      areaMinMana: 0.35,
      heal: '',
      healPartyWith: '',
      healBelow: 0,
      healBelowInCombat: 0,
      healTo: 0,
      healParty: false,
      minMana: 0.15,
      cures: { blindness: '', poison: '', disease: '' },
      blessings: [],
      notifyPartyOnWearOff: false,
      ...over
    });
    const crowded = (mobCount: number, mana = 40) =>
      state({
        inCombat: true,
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, target: 'giant rat' },
        vitals: { ...EMPTY_CHARACTER.vitals, mana, manaMax: 100, manaType: 'MA' },
        room: {
          ...EMPTY_CHARACTER.room,
          occupants: Array.from({ length: mobCount }, (_, i) =>
            mob(i === 0 ? 'giant rat' : `giant rat ${i}`, 'hostile')
          )
        }
      });

    it('casts the single-target spell when the room is not crowded', () => {
      const auto = make(combat({ engage: 'none' }), true, spells());
      auto.onCharacter(crowded(1));
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      expect(sent).toEqual(['c ma giant rat']);
    });

    it('casts the crowd spell bare at the threshold', () => {
      const auto = make(combat({ engage: 'none' }), true, spells());
      auto.onCharacter(crowded(3));
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      expect(sent).toEqual(['c poison cloud']);
    });

    it('falls back to the single-target spell under the crowd floor', () => {
      // 20% mana: under the crowd floor (35%), above the ordinary one (15%).
      const auto = make(combat({ engage: 'none' }), true, spells());
      auto.onCharacter(crowded(3, 20));
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      expect(sent).toEqual(['c ma giant rat']);
    });

    /* Unknown is not empty — the same asymmetry the single spell keeps. */
    it('casts the crowd spell when no maximum has arrived', () => {
      const auto = make(combat({ engage: 'none' }), true, spells());
      const noMana = crowded(3);
      auto.onCharacter({
        ...noMana,
        vitals: { ...noMana.vitals, mana: null, manaMax: null }
      });
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      expect(sent).toEqual(['c poison cloud']);
    });

    /* A shopkeeper is not a reason to gas the room: the crowd is threats,
       never bare mobs. */
    it('does not count a passive bystander toward the crowd', () => {
      const auto = make(combat({ engage: 'none' }), true, spells());
      const room = crowded(1);
      auto.onCharacter({
        ...room,
        room: {
          ...room.room,
          occupants: [
            ...room.room.occupants,
            mob('shopkeeper', 'passive'),
            mob('guard dog', 'passive')
          ]
        }
      });
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      expect(sent).toEqual(['c ma giant rat']);
    });

    /*
     * The ten evil points are a cost to the character and no setting spends
     * them unasked — the refusal `choose` makes one monster at a time, made
     * for the whole room, because a room spell hits everything standing in it.
     */
    it('refuses the crowd spell while a good monster stands in the room', () => {
      const auto = make(combat({ engage: 'none' }), true, spells());
      const room = crowded(3);
      auto.onCharacter({
        ...room,
        room: {
          ...room.room,
          occupants: [...room.room.occupants, mob('white knight', 'passive', { costly: 'always' })]
        }
      });
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      expect(sent).toEqual(['c ma giant rat']);
    });
  });
});

/*
 * The Arena loop and the break override, both captured live on 2026-08-26.
 * The mechanisms are documented on `endFight` and `noteUserCommand`.
 */
describe('asking once about one monster', () => {
  it('keeps the engage cooldown across the end of a fight', () => {
    // Re-attacking makes the server answer `*Combat Off*` then `*Combat
    // Engaged*`; clearing the cooldown on the Off half re-armed the very next
    // state change to ask again — ~10 wasted attacks a second, each resetting
    // the character's own combat round.
    const auto = make(combat());
    const rat = mob('small giant rat', 'hostile');
    const here = { ...EMPTY_CHARACTER.room, occupants: [rat] };

    auto.onCharacter(state({ room: here }));
    drain();
    expect(sent).toEqual(['a small giant rat']);

    // The server's pair: engaged, then off — the fight "ends" and the target
    // clears — then engaged again, off again, as fast as state changes come.
    for (let i = 0; i < 5; i += 1) {
      auto.onCharacter(state({ room: here, inCombat: true }));
      auto.onCharacter(state({ room: here, inCombat: false }));
      drain();
    }
    expect(sent).toEqual(['a small giant rat']);
  });

  it('releases the cooldown when the monster itself is gone', () => {
    // The arena spawns same-name monsters back to back. The cooldown is a
    // floor on asking about one individual, not a tax on the species: the
    // dead one leaving the room is what frees the name for the next arrival.
    const auto = make(combat());
    const rat = mob('giant rat', 'hostile');

    auto.onCharacter(state({ room: { ...EMPTY_CHARACTER.room, occupants: [rat] } }));
    drain();
    expect(sent).toEqual(['a giant rat']);

    // It dies: the experience line empties the room.
    auto.onCharacter(state({ room: { ...EMPTY_CHARACTER.room, occupants: [] } }));
    // A new giant rat walks in one second later.
    vi.advanceTimersByTime(1000);
    auto.onCharacter(state({ room: { ...EMPTY_CHARACTER.room, occupants: [rat] } }));
    drain();
    expect(sent).toEqual(['a giant rat', 'a giant rat']);
  });

  it('cancels a queued attack when its monster vanishes', () => {
    // The server holds output while the player has a half-typed line, so a
    // whole fight can arrive as one burst: an attack decided early in the
    // burst must not be sent at the corpse the burst also contains.
    const auto = make(combat());
    const rat = mob('giant rat', 'hostile');

    queue.noteTyping(true);
    auto.onCharacter(state({ room: { ...EMPTY_CHARACTER.room, occupants: [rat] } }));
    expect(sent).toEqual([]);
    auto.onCharacter(state({ room: { ...EMPTY_CHARACTER.room, occupants: [] } }));
    queue.noteTyping(false);
    drain();
    expect(sent).toEqual([]);
  });
});

describe('a typed break', () => {
  it('stands engaging down until the player moves or attacks', () => {
    const auto = make(combat());
    const slime = mob('large acid slime', 'hostile');
    const here = { ...EMPTY_CHARACTER.room, occupants: [slime] };

    auto.onCharacter(state({ room: here }));
    drain();
    expect(sent).toEqual(['a large acid slime']);

    auto.noteUserCommand('break');
    expect(notices.some((m) => m.includes('standing down'))).toBe(true);
    // The server answers the break with `*Combat Off*`; the monster is still
    // here and still hostile, and five seconds ago that re-opened the fight.
    vi.advanceTimersByTime(5000);
    auto.onCharacter(state({ room: here, inCombat: false }));
    drain();
    expect(sent).toEqual(['a large acid slime']);
  });

  it('stands hitting back down too', () => {
    // The monster still swinging is exactly what the player accepted by
    // breaking off — they are about to leave.
    const auto = make(combat({ engage: 'none' }));
    const slime = mob('large acid slime', 'hostile');
    const here = { ...EMPTY_CHARACTER.room, occupants: [slime] };

    auto.noteUserCommand('break');
    auto.onCharacter(
      state({
        room: here,
        combat: { ...EMPTY_CHARACTER.combat, attackers: ['large acid slime'] }
      })
    );
    drain();
    expect(sent).toEqual([]);
  });

  it('ends the stand-down when the player attacks', () => {
    const auto = make(combat());
    const slime = mob('large acid slime', 'hostile');
    const here = { ...EMPTY_CHARACTER.room, occupants: [slime] };

    auto.onCharacter(state({ room: here }));
    drain();
    auto.noteUserCommand('break');
    vi.advanceTimersByTime(5000);
    // The player swings at something themselves: the fight is theirs again.
    auto.noteUserCommand('pu large acid slime');
    // The slime died to them; a new one arrives.
    auto.onCharacter(state({ room: { ...EMPTY_CHARACTER.room, occupants: [] } }));
    auto.onCharacter(state({ room: here }));
    drain();
    expect(sent).toEqual(['a large acid slime', 'a large acid slime']);
  });

  it('ends the stand-down when the player moves on', () => {
    const auto = make(combat());
    const slime = mob('large acid slime', 'hostile');

    auto.onCharacter(state({ room: { ...EMPTY_CHARACTER.room, occupants: [slime] } }));
    drain();
    auto.noteUserCommand('break');
    // A different room, holding a different monster of the same disposition.
    vi.advanceTimersByTime(1000);
    auto.onCharacter(
      state({
        room: {
          ...EMPTY_CHARACTER.room,
          name: 'A Different Road',
          occupants: [mob('cave rat', 'hostile')]
        }
      })
    );
    drain();
    expect(sent).toEqual(['a large acid slime', 'a cave rat']);
  });
});

/*
 * Assisting the leader: the leader's fight is the party's, so joining it is
 * not opening one — `engage: none` does not stop it — but every other refusal
 * stands, and the target has to be a monster still standing in the room.
 */
describe('fighting what the leader fights', () => {
  const member = (name: string) => ({
    name,
    activity: null,
    className: null,
    health: 1,
    invited: false,
    vitals: null,
    mana: null,
    rank: null
  });
  const party = {
    assistLeader: true,
    defendParty: false,
    restWithLeader: false
  };
  const following = (target: string, at = Date.now()) => ({
    following: 'Soul',
    members: [member('Vaelor'), member('Soul')],
    engaged: { Soul: { target, at } },
    threatened: {}
  });

  it('swings at the leader’s target even when told to open nothing', () => {
    const auto = make({ ...DEFAULT_CONFIG.automation.combat, enabled: true, engage: 'none' });
    auto.configure(
      { ...DEFAULT_CONFIG.automation.combat, enabled: true, engage: 'none' },
      true,
      undefined,
      party
    );
    auto.onCharacter(
      state({
        party: following('giant rat'),
        room: { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'passive')] }
      })
    );
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(['a giant rat']);
  });

  it('does nothing when the leader’s target has left the room, or the sighting is stale', () => {
    const auto = make({ ...DEFAULT_CONFIG.automation.combat, enabled: true, engage: 'none' });
    auto.configure(
      { ...DEFAULT_CONFIG.automation.combat, enabled: true, engage: 'none' },
      true,
      undefined,
      party
    );
    auto.onCharacter(
      state({ party: following('giant rat'), room: { ...EMPTY_CHARACTER.room, occupants: [] } })
    );
    auto.onCharacter(
      state({
        party: following('giant rat', Date.now() - 120_000),
        room: { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'hostile')] }
      })
    );
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
  });

  /* The leader in a PvP fight is the leader's business. */
  it('never joins a fight against a player', () => {
    const auto = make({ ...DEFAULT_CONFIG.automation.combat, enabled: true, engage: 'none' });
    auto.configure(
      { ...DEFAULT_CONFIG.automation.combat, enabled: true, engage: 'none' },
      true,
      undefined,
      party
    );
    auto.onCharacter(
      state({
        party: following('Grimjaw'),
        room: { ...EMPTY_CHARACTER.room, occupants: [player('Grimjaw')] }
      })
    );
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
  });

  it('is off unless asked', () => {
    const auto = make({ ...DEFAULT_CONFIG.automation.combat, enabled: true, engage: 'none' });
    auto.onCharacter(
      state({
        party: following('giant rat'),
        room: { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'passive')] }
      })
    );
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
  });
});

describe('defending the party', () => {
  const member = (name: string) => ({
    name,
    activity: null,
    className: null,
    health: 1,
    invited: false,
    vitals: null,
    mana: null,
    rank: null
  });
  const party = {
    assistLeader: false,
    defendParty: true,
    restWithLeader: false
  };
  /** Soul is being hit by `target`; nobody here follows anybody. */
  const threatened = (target: string, at = Date.now()) => ({
    following: null,
    members: [member('Vaelor'), member('Soul')],
    engaged: {},
    threatened: { Soul: { target, at } }
  });
  const defending = (engage: 'none' | 'hostile' = 'none') => {
    const config = { ...DEFAULT_CONFIG.automation.combat, enabled: true, engage };
    const auto = make(config);
    auto.configure(config, true, undefined, party);
    return auto;
  };

  /* The fight came to the party, so `engage: none` does not gate it — the
     same argument assisting the leader already makes. */
  it('swings at a monster attacking a member even when told to open nothing', () => {
    const auto = defending();
    auto.onCharacter(
      state({
        party: threatened('giant rat'),
        room: { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'passive')] }
      })
    );
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(['a giant rat']);
  });

  it('does nothing when the attacker has left the room, or the sighting is stale', () => {
    const auto = defending();
    auto.onCharacter(
      state({ party: threatened('giant rat'), room: { ...EMPTY_CHARACTER.room, occupants: [] } })
    );
    auto.onCharacter(
      state({
        party: threatened('giant rat', Date.now() - 120_000),
        room: { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'hostile')] }
      })
    );
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
  });

  /* A person attacking a member is that member's PvP fight. */
  it('never joins a fight against a player', () => {
    const auto = defending();
    auto.onCharacter(
      state({
        party: threatened('Grimjaw'),
        room: { ...EMPTY_CHARACTER.room, occupants: [player('Grimjaw')] }
      })
    );
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
  });

  it('is off unless asked', () => {
    const auto = make({ ...DEFAULT_CONFIG.automation.combat, enabled: true, engage: 'none' });
    auto.onCharacter(
      state({
        party: threatened('giant rat'),
        room: { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'passive')] }
      })
    );
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
  });
});

/*
 * Eleven ways to decline to open a fight, and until this existed not one of
 * them said so. Answering *why did it walk past those two thugs* took replaying
 * a recorded session through a bespoke script and counting `rm` probes to work
 * out whether a loop had been running; the answer was `whileWalking` off, which
 * is one line of configuration and was invisible from everything the client
 * recorded.
 */
describe('saying why it did not open a fight', () => {
  const room = (...occupants: ReturnType<typeof mob>[]) =>
    state({ room: { ...EMPTY_CHARACTER.room, occupants } });

  it('names the setting that stopped it while a route is running', () => {
    const auto = make(combat({ whileWalking: false }));
    auto.noteWalking(true);
    auto.onCharacter(room(mob('thug', 'hostile')));
    drain();
    expect(sent).toEqual([]);
    expect(refusals()).toEqual(['thug — walking a route, and whileWalking is off']);
  });

  /* A loop's walk engages whatever `whileWalking` says: the loop was chosen for
     what lives on it. */
  it('says nothing about a walk when the walk is a loop', () => {
    const auto = make(combat({ whileWalking: false }));
    auto.noteWalking(true);
    auto.noteLooping(true);
    auto.onCharacter(room(mob('thug', 'hostile')));
    drain();
    expect(sent).toEqual(['a thug']);
    expect(refusals()).toEqual([]);
  });

  it('names the count when there are more monsters than maxMobs', () => {
    const auto = make(combat({ maxMobs: 1 }));
    auto.onCharacter(room(mob('thug', 'hostile'), mob('nasty thug', 'hostile')));
    drain();
    expect(refusals()).toEqual(['thug — 2 monsters here, and maxMobs is 1']);
  });

  it('names the health floor', () => {
    const auto = make(combat({ minHealth: 0.5 }));
    auto.onCharacter({
      ...room(mob('thug', 'hostile')),
      vitals: { ...EMPTY_CHARACTER.vitals, hp: 30, hpMax: 100 }
    });
    drain();
    expect(refusals()).toEqual(['thug — health is 30% and minHealth is 50%']);
  });

  it('names the policy when engage is none', () => {
    const auto = make(combat({ engage: 'none' }));
    auto.onCharacter(room(mob('thug', 'hostile')));
    drain();
    expect(refusals()).toEqual(['thug — engage is set to none, so nothing is opened unasked']);
  });

  /* The reason belongs to the monster, not to a setting: at `likely` a passive
     one is simply not something the realm says will attack first. */
  it('names the monster when the realm does not say it attacks first', () => {
    const auto = make(combat());
    auto.onCharacter(room(mob('shopkeeper', 'passive')));
    drain();
    expect(refusals()).toEqual(['shopkeeper — the realm does not say shopkeeper attacks first']);
  });

  it('names the avoid list', () => {
    const auto = make(combat({ avoid: ['thug'] }));
    auto.onCharacter(room(mob('thug', 'hostile')));
    drain();
    expect(refusals()).toEqual(['thug — thug is on the avoid list']);
  });

  /*
   * An empty corridor is not a decision. A trace with a line for every room a
   * character walks through is the terminal again, which is the thing every
   * readout in this client exists instead of.
   */
  it('says nothing at all about a room with no monster in it', () => {
    const auto = make(combat({ engage: 'none' }));
    auto.onCharacter(state({}));
    drain();
    expect(decisions).toEqual([]);
  });

  /*
   * A status line arrives every few hundred milliseconds and the room does not
   * change between them.
   */
  it('says it once, not once per status line', () => {
    const auto = make(combat({ whileWalking: false }));
    auto.noteWalking(true);
    const here = room(mob('thug', 'hostile'));
    auto.onCharacter(here);
    auto.onCharacter(here);
    auto.onCharacter(here);
    drain();
    expect(refusals()).toHaveLength(1);
  });

  /* And says it again when the answer changes. */
  it('says it again when a different monster is refused', () => {
    const auto = make(combat({ whileWalking: false }));
    auto.noteWalking(true);
    auto.onCharacter(room(mob('thug', 'hostile')));
    auto.onCharacter(room(mob('orc rogue', 'hostile')));
    drain();
    expect(refusals()).toHaveLength(2);
  });

  /*
   * Both can be true at once, and the gate is the one that answers "why did
   * nothing happen" — it would have stopped a fight the policy was happy with.
   * Named against the monster `choose` stopped on, never against the room: the
   * trace's second column is a monster, and a place there would read as one.
   */
  it('names the gate over the policy, against the monster it looked at', () => {
    const auto = make(combat({ whileWalking: false }));
    auto.noteWalking(true);
    auto.onCharacter(room(mob('shopkeeper', 'passive')));
    drain();
    expect(refusals()).toEqual(['shopkeeper — walking a route, and whileWalking is off']);
  });

  it('records the fight it did open', () => {
    const auto = make(combat());
    auto.onCharacter(room(mob('thug', 'hostile')));
    drain();
    expect(decisions.filter((d) => d.acted).map((d) => d.target)).toEqual(['thug']);
  });
});

/*
 * Refusals about a **kind** of monster rather than a name.
 *
 * Before the room's occupants carried their realm rows, the only way to say
 * "not the skeletons" was to list every skeleton in the realm by name — and
 * two of these three facts (a death spell, a health figure) cannot be learned
 * by fighting carefully at all.
 */
describe('what the realm says about the kind', () => {
  /** A hostile the realm can place, with whatever row the case is about. */
  const known = (name: string, row: Partial<NonNullable<RoomOccupant['mob']>>): RoomOccupant => {
    const base = mob(name, 'hostile');
    return {
      ...base,
      mob: {
        name,
        rawName: name,
        source: 'hybrid',
        charmed: false,
        disposition: 'hostile',
        uncertain: false,
        costly: 'never',
        ...row
      }
    };
  };

  const inRoom = (...occupants: RoomOccupant[]): CharacterState =>
    state({ room: { ...EMPTY_CHARACTER.room, occupants } });

  it('declines the undead, and says which fact decided it', () => {
    const auto = make(combat({ engage: 'all', avoidUndead: true }));
    auto.onCharacter(inRoom(known('skeleton', { undead: true })));
    drain();
    expect(sent).toEqual([]);
    expect(refusals()).toEqual(['skeleton — the realm marks skeleton undead']);
  });

  it('declines something that casts a spell when it dies', () => {
    const auto = make(combat({ engage: 'all', avoidDeathSpell: true }));
    auto.onCharacter(inRoom(known('bloated corpse', { deathSpell: 99 })));
    drain();
    expect(sent).toEqual([]);
    expect(refusals()[0]).toContain('casts a spell when it dies');
  });

  it('declines anything over the health ceiling and takes what is under it', () => {
    const auto = make(combat({ engage: 'all', maxTargetHealth: 100 }));
    auto.onCharacter(inRoom(known('ancient dragon', { hp: 4000 }), known('giant rat', { hp: 12 })));
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  /*
   * A monster the realm cannot place is not refused by these. `engage:
   * hostile` already declines it, and refusing here as well would make
   * `engage: all` do nothing at all on a realm this client has no data for.
   */
  it('does not refuse a monster the realm cannot place', () => {
    const auto = make(
      combat({ engage: 'all', avoidUndead: true, avoidDeathSpell: true, maxTargetHealth: 10 })
    );
    auto.onCharacter(inRoom(unplaced('thing from the deep')));
    drain();
    expect(sent).toEqual(['a thing from the deep']);
  });

  /* All three off is the shipped default, and off refuses nothing. */
  it('refuses nothing while all three are off', () => {
    const auto = make(combat({ engage: 'all' }));
    auto.onCharacter(inRoom(known('skeleton', { undead: true, deathSpell: 99, hp: 9000 })));
    drain();
    expect(sent).toEqual(['a skeleton']);
  });
});

/*
 * The two gates MegaMUD has that this client did not — its `MinMstrs` and
 * `MaxMstrExp` (measured 2026-09-02 from the installed MegaMUD 2.1's own
 * `Chars/sample.ini`).
 */
describe('the size of the room and the size of the monster', () => {
  const known = (name: string, row: Partial<NonNullable<RoomOccupant['mob']>>): RoomOccupant => ({
    ...mob(name, 'hostile'),
    mob: {
      name,
      rawName: name,
      source: 'hybrid',
      charmed: false,
      disposition: 'hostile',
      uncertain: false,
      costly: 'never',
      ...row
    }
  });
  const inRoom = (...occupants: RoomOccupant[]): CharacterState =>
    state({ room: { ...EMPTY_CHARACTER.room, occupants } });

  /*
   * The mirror of `maxMobs`: a character whose whole value is an area spell
   * spends the round and the mana on one monster for a fraction of what the
   * spell is for.
   */
  it('will not open in a room too small to be worth it', () => {
    const auto = make(combat({ engage: 'all', minMobs: 3 }));
    auto.onCharacter(inRoom(mob('giant rat', 'hostile'), mob('kobold', 'hostile')));
    drain();
    expect(sent).toEqual([]);

    sent.length = 0;
    const enough = make(combat({ engage: 'all', minMobs: 3 }));
    enough.onCharacter(
      inRoom(mob('giant rat', 'hostile'), mob('kobold', 'hostile'), mob('thug', 'hostile'))
    );
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  it('declines a monster worth more experience than the cap', () => {
    const auto = make(combat({ engage: 'all', maxMonsterExperience: 500 }));
    auto.onCharacter(inRoom(known('ancient dragon', { experience: 90_000 })));
    drain();
    expect(sent).toEqual([]);
    expect(refusals()[0]).toContain('maxMonsterExperience');
  });

  /* Unranked by the realm is not refused, for `maxTargetHealth`'s reason. */
  it('does not refuse a monster the realm gives no experience for', () => {
    const auto = make(combat({ engage: 'all', maxMonsterExperience: 1 }));
    auto.onCharacter(inRoom(unplaced('thing from the deep')));
    drain();
    expect(sent).toEqual(['a thing from the deep']);
  });
});
