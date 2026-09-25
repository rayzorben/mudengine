import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
import type { ItemEntity, MobEntity } from '../../../shared/entities';
import { GUARDED_BY_ABILITY } from '../../../shared/guards';
import { WEAPON_HAND } from '../../../shared/items';
import type { RealmFamily } from '../../../shared/realm';
import type { MobAttack, WorldSpell } from '../../../shared/world';
import type { InstantSpellLore } from '../../../shared/lore';
import { RealmLore } from '../../world/RealmLore';

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
/** On the ground, as `Grounded.down` answers it (todo 760). */
let down: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  down = false;
  sent = [];
  notices = [];
  decisions = [];
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

function make(
  config: CombatConfig,
  enabled = true,
  spells?: SpellsConfig,
  realmClass?: () => { combat: number | null; magery: number | null; family: RealmFamily | null },
  /** Whether the class can get into the shadows; undefined is unknown (todo 28). */
  canHide?: () => boolean | null,
  /** What the realm's wire taught about its attack spells (todo 820). */
  instants?: InstantSpellLore
): AutoCombat {
  return new AutoCombat(
    config,
    enabled,
    queue,
    {
      notice: (m) => notices.push(m),
      decided: (decision) => decisions.push(decision),
      ...(canHide === undefined ? {} : { canHide }),
      onTheGround: () => down
    },
    spells ?? DEFAULT_CONFIG.automation.spells,
    undefined,
    realmClass,
    instants
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

  /* MegaMUD's PoliteAttacks: a monster a stranger was seen fighting is left to
     them, and the trace says whose it was. Joining is the default, as it is
     MegaMUD's own, so the switch is what makes a character stand aside. */
  it('leaves a monster somebody outside the party is already fighting, when told to', () => {
    const spokenFor = (at: number) =>
      state({
        room: { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'hostile')] },
        combat: { ...EMPTY_CHARACTER.combat, claimed: { 'giant rat': { by: 'Rend', at } } }
      });
    const polite = make(combat({ politeAttacks: true }));
    polite.onCharacter(spokenFor(Date.now()));
    drain();
    expect(sent).toEqual([]);
    expect(refusals()).toEqual([
      'giant rat — Rend is already fighting giant rat, and politeAttacks is on'
    ]);

    // The default joins, which is MegaMUD's own `PoliteAttacks=0`.
    make(combat()).onCharacter(spokenFor(Date.now()));
    drain();
    expect(sent).toEqual(['a giant rat']);

    // And a sighting two minutes old says nothing about now, polite or not.
    sent = [];
    make(combat({ politeAttacks: true })).onCharacter(spokenFor(Date.now() - 120_000));
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

  /* `engage: likely` is how somebody takes the coin toss on purpose; naming
     the monster outright was the other way, and went with `prefer` (todo 00). */
  it('goes for an uncertain one when asked to take the coin toss', () => {
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

  /* And there is no longer any way to ask for it: `prefer` was the one door
     through this refusal and it went with the list (todo 00). Spending a
     character's standing stays a decision the client never makes. */
  it('refuses a certainly costly one at every setting', () => {
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

  /* The character's own side of the arithmetic: a sheet `prowess` can read, a
     sword in hand, the class row the sheet does not print, and the server's
     family — the four things `verdictFor` needs before rounds are knowable. */
  const armed = () => ({ combat: 4, magery: null, family: 'greatermud' as const });
  const sword: ItemEntity = {
    name: 'short sword',
    source: 'hybrid',
    slot: 'Weapon Hand',
    equipped: true,
    charges: null,
    kind: 'weapon',
    weapon: { min: 5, max: 12, speed: 20, strength: 30 }
  };
  const swordsman = (room: CharacterState['room']): CharacterState =>
    state({
      room,
      progress: {
        ...EMPTY_CHARACTER.progress,
        level: 10,
        agility: 60,
        intellect: 50,
        charm: 55,
        willpower: 50,
        health: 60,
        strength: 55
      },
      inventory: { ...EMPTY_CHARACTER.inventory, items: [sword] }
    });

  /* Once the order is decided on rounds, the sentence names rounds — not the
     health the ranking stopped using. */
  it('names the rounds and the health the fight costs when it ranked on them', () => {
    const auto = make(combat(), true, undefined, armed);
    auto.onCharacter(swordsman(weighed));
    drain();
    const acted = decisions.find((decision) => decision.acted);
    expect(acted?.because).toMatch(/up to \d+ rounds and \d+ hp to kill/);
    expect(acted?.because).not.toContain('40 hp');
  });

  /* The monster's own armour reaches the roll. Two fighters alike in every
     way but one in plate: it turns blows away, takes more rounds to remove,
     and so costs more per round of the time it takes — second, whatever the
     room order says. With `{}` as the target every monster was unarmoured. */
  it('prices the monster’s armour into the rounds, so the armoured one waits', () => {
    const auto = make(combat(), true, undefined, armed);
    auto.onCharacter(
      swordsman({
        ...EMPTY_CHARACTER.room,
        occupants: [
          fighter('armoured thug', 60, [bite(4, 9)], { armour: 400 }),
          fighter('thug', 60, [bite(4, 9)])
        ]
      })
    );
    drain();
    expect(sent).toEqual(['a thug']);
  });

  it('skips one it was told never to attack', () => {
    const auto = make(combat({ mobRules: [{ mob: 'giant rat', treat: 'never' }] }));
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['a wererat shaman']);
  });

  /* Both sides go through `mobKey`, as the ranking's rows already did: a row
     typed on the settings screen has not been through `normalizeCombat` yet,
     and a refusal that did nothing until the file was reloaded would be the
     control lying about itself while somebody watched it. */
  it('leaves it alone however the row spelled the name', () => {
    const auto = make(combat({ mobRules: [{ mob: 'The Giant Rat', treat: 'never' }] }));
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['a wererat shaman']);
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

  /*
   * There is no health floor on *opening* a fight (todo 13): the goal of the
   * game is survival, and a character that will not swing at what is swinging
   * at it is not safer. Low health is the retreat's business and the rest's,
   * and both act on the character rather than on the decision to engage.
   */
  it('opens a fight at low health, because the floor on opening is gone', () => {
    const auto = make(combat({}));
    auto.onCharacter(state({ room, vitals: { ...EMPTY_CHARACTER.vitals, hp: 20, hpMax: 100 } }));
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
   * Going somewhere fights, whichever kind of going it is (todo 00).
   *
   * `whileWalking` used to ask this per route and a lap overrode it. Both went:
   * the player asked to go somewhere, and what lives between here and there is
   * the realm's business — a client that walks a character through a corridor
   * of monsters without swinging comes back at the level it left.
   */
  it('fights along a plain route', () => {
    const auto = make(combat());
    auto.noteWalking(true);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  it('fights on a lap', () => {
    const auto = make(combat());
    auto.noteLooping(true);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  /* And through the block's own switch, which is what the journey overrides. */
  it('fights on a route with the block switched off', () => {
    const auto = make(combat({ enabled: false }));
    auto.noteWalking(true);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  it('fights on a lap with the block switched off', () => {
    const auto = make(combat({ enabled: false }));
    auto.noteLooping(true);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  /* Standing still it stays off, which is what the switch is for. */
  it('fights nothing standing still with the block switched off', () => {
    const auto = make(combat({ enabled: false }));
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * The player overruling the journey, and the overruling outlasting the room
   * it was made in: the switch going off mid-journey is caught on the edge in
   * `configure`, and `acting` ignores `config.enabled` while travelling, so
   * without the decline the toolbar's switch would do nothing until the
   * character stopped walking.
   */
  it('stops fighting for the rest of a journey once the switch goes off', () => {
    const auto = make(combat({ enabled: true }));
    auto.noteWalking(true);
    auto.configure(combat({ enabled: false }), true);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * *Run it* (todo 06) declines the journey the moment the walk starts and
   * asks the file to turn the switch off in the same breath — but the file
   * answers through `configure` half a second later, and until then the
   * switch still reads on. The decline has to hold across that, or the first
   * step beside a monster opens the fight the press was made to avoid.
   */
  it('stays declined while the switch still reads on, until it is turned back on', () => {
    const auto = make(combat({ enabled: true }));
    auto.noteWalking(true);
    auto.declineWhileTravelling();
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual([]);
    // The file lands: still declined, and not a journey that fights.
    auto.configure(combat({ enabled: false }), true);
    expect(auto.fightingBecauseTravelling).toBe(false);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual([]);
    // Turned back on by hand: the journey fights again.
    auto.configure(combat({ enabled: true }), true);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  /*
   * The decline is the journey's and ends with it (2026-09-23). `acting` read
   * it bare, so a journey declined and then ended beside a switch that reads
   * on left the character refusing every fight until a reload happened to
   * clear it, and saying nothing.
   */
  it('ends the decline with the journey, so a switch that reads on fights again', () => {
    const auto = make(combat({ enabled: true }));
    auto.noteWalking(true);
    auto.declineWhileTravelling();
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual([]);
    auto.noteWalking(false);
    expect(auto.willFight).toBe(true);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  /* And the decline is reported for that half second, not only obeyed. */
  it('reports the decline while the switch still reads on, and sends nothing', () => {
    const auto = make(combat({ enabled: true }));
    auto.noteWalking(true);
    auto.declineWhileTravelling();
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual([]);
    expect(refusals()).toEqual(['giant rat — you turned auto-combat off for this journey']);
  });

  /*
   * A reload that reads on is the player's hand whichever edge it arrived on:
   * a run's write and the toolbar's press inside one poll reach `configure`
   * as on → on, and a decline left standing there would be auto-combat dead
   * with the switch reading on and nothing to say why.
   */
  it('takes the decline back on any reload that reads on', () => {
    const auto = make(combat({ enabled: true }));
    auto.noteWalking(true);
    auto.declineWhileTravelling();
    auto.configure(combat({ enabled: true }), true);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  /*
   * And **nothing swings** on that path, retaliation included.
   *
   * `declinedOnly` opens a door through the `acting` early return purely so
   * `whyNot` can report the refusal — but `retaliation` runs before `engage`
   * in `onCharacter`, so the door let a declined journey hit back where the
   * block's own switch had always stopped it. A player who turns the switch
   * off mid-route, reads the refusal in the trace and watches the client keep
   * fighting is holding a control that does not control anything.
   */
  it('does not hit back on a journey the player declined', () => {
    const auto = make(combat({ enabled: true, engage: 'none' }));
    auto.noteWalking(true);
    auto.configure(combat({ enabled: false, engage: 'none' }), true);
    auto.onCharacter(
      state({
        inCombat: true,
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, attackers: ['giant rat'] }
      })
    );
    drain();
    expect(sent).toEqual([]);
  });

  /* The positive control: the same blow, standing still with the block on. */
  it('still hits back standing still with the block on', () => {
    const auto = make(combat({ enabled: true, engage: 'none' }));
    auto.onCharacter(
      state({
        inCombat: true,
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, attackers: ['giant rat'] }
      })
    );
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  /* And the next journey asks again: it was *not this route*, not *never*. */
  it('fights again on the next journey after one was declined', () => {
    const auto = make(combat({ enabled: true }));
    auto.noteWalking(true);
    auto.configure(combat({ enabled: false }), true);
    auto.noteWalking(false);
    auto.noteWalking(true);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  /*
   * `CombatLease` lent the switch and handed it back (todo 00): the off edge
   * that follows is the lease's, so the journey is put back as it was when
   * the switch was lent — declined after a *Run it*, fighting on a route.
   */
  it('puts a declined journey back declined when the lease hands the switch back', () => {
    const auto = make(combat({ enabled: false }));
    auto.noteWalking(true);
    auto.declineWhileTravelling();
    // Lent: the reload reads on and the journey fights.
    auto.configure(combat({ enabled: true }), true);
    expect(auto.journeyDeclined).toBe(false);
    auto.leaseReturned(true);
    auto.configure(combat({ enabled: false }), true, undefined, undefined, true);
    expect(auto.journeyDeclined).toBe(true);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual([]);
  });

  it('leaves a route that was fighting still fighting when the lease hands the switch back', () => {
    const auto = make(combat({ enabled: true }));
    auto.noteWalking(true);
    auto.leaseReturned(false);
    auto.configure(combat({ enabled: false }), true, undefined, undefined, true);
    expect(auto.journeyDeclined).toBe(false);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['a giant rat']);
    // Nothing is left over: the player's own off edge declines as it always did.
    auto.configure(combat({ enabled: true }), true);
    auto.configure(combat({ enabled: false }), true);
    expect(auto.journeyDeclined).toBe(true);
  });

  /* Turning it back on mid-journey answers in the other direction too. */
  it('fights again when the switch goes back on mid-journey', () => {
    const auto = make(combat({ enabled: true }));
    auto.noteWalking(true);
    auto.configure(combat({ enabled: false }), true);
    auto.configure(combat({ enabled: true }), true);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  /*
   * The master switch is not overridden by anything: with automation off, only
   * what the player types is ever sent.
   */
  it('fights nothing on a loop when automation itself is off', () => {
    const auto = make(combat({ enabled: true }), false);
    auto.noteLooping(true);
    auto.onCharacter(state({ room }));
    drain();
    expect(sent).toEqual([]);
  });

  /* What the route and the lap read to know whether they have something to say. */
  it('says when the journey is the only reason it is fighting', () => {
    expect(make(combat({ enabled: false })).fightingBecauseTravelling).toBe(true);
    expect(make(combat({ enabled: true })).fightingBecauseTravelling).toBe(false);
    expect(make(combat({ enabled: false }), false).fightingBecauseTravelling).toBe(false);
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
 * out of. Both read `acting`, which is where the journey's own override and
 * the player's refusal of it live, so the two cannot disagree.
 */
describe('the beat a walk takes for it', () => {
  const room = { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'hostile')] };

  /* A journey the player turned fighting off for holds no beat either: the
     walker would be stopping for a fight that is never opened. */
  it('is not asked for on a journey the player declined', () => {
    const auto = make(combat({ enabled: true }));
    auto.noteWalking(true);
    auto.configure(combat({ enabled: false }), true);
    expect(auto.quarry(state({ room }))).toBe(false);
  });

  it('is asked for on a loop, whose walk engages', () => {
    const auto = make(combat());
    auto.noteLooping(true);
    expect(auto.quarry(state({ room }))).toBe(true);
  });

  it('is asked for on a plain route, which fights like a lap', () => {
    const auto = make(combat());
    auto.noteWalking(true);
    expect(auto.quarry(state({ room }))).toBe(true);
  });

  /* Every other gate is the engage path's own, so the two cannot disagree. */
  it('is not asked for where the fight would be refused anyway', () => {
    const auto = make(combat({ engage: 'none' }));
    auto.noteWalking(true);
    expect(auto.quarry(state({ room }))).toBe(false);
  });

  it('is not asked for in a room too small for engage to open in', () => {
    const auto = make(combat({ engage: 'all', minMobs: 2 }));
    auto.noteWalking(true);
    expect(auto.quarry(state({ room }))).toBe(false);
    const two = { ...room, occupants: [...room.occupants, mob('kobold', 'hostile')] };
    expect(auto.quarry(state({ room: two }))).toBe(true);
  });

  it('is not asked for in a room with nothing in it worth stopping for', () => {
    const auto = make(combat());
    auto.noteWalking(true);
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
   * A backstab from a character the server can see is **not refused** — it is
   * silently downgraded: `AttackCommand.cs:408` clears `CanBackstab` when `bs`
   * arrives from somebody neither sneaking nor hiding, and `Room.cs:681` gives
   * it an ordinary round. So spending the opener there buys exactly what
   * `attack` buys, and the opener is held instead.
   */
  it('does not spend a backstab opener on a character the realm can see', () => {
    const auto = make(combat({ opener: 'bs' }));
    auto.onCharacter(state({ room, stealth: 'seen' }));
    drain();
    expect(sent).toEqual(['a giant rat']);
    expect(notices.filter((n) => /sneaking/.test(n))).toHaveLength(1);
  });

  /*
   * And a class that cannot get into the shadows at all never lands one
   * (todo 28). `combat.opener` survives a reroll: a profile set up for a
   * Ninja was still asking for `bs` as a Mage, a Priest and a Witchunter, and
   * each was told why it was withheld *this time* — advice none of them could
   * take. Read from the realm's class row, not from the momentary state.
   */
  it('drops a backstab opener the class can never use, and says why once', () => {
    const auto = make(combat({ opener: 'bs' }), true, undefined, undefined, () => false);
    // Sneaking, which is the state the stealth gate would let through.
    auto.onCharacter(state({ room, stealth: 'sneaking' }));
    auto.onCharacter(state({ room, stealth: 'sneaking' }));
    drain();
    expect(sent).toEqual(['a giant rat']);
    expect(notices.filter((n) => /cannot get into the shadows/i.test(n))).toHaveLength(1);
  });

  /* Unknown class never refuses, the rule every threshold here follows. */
  it('keeps the opener while the class is unread', () => {
    const auto = make(combat({ opener: 'bs' }), true, undefined, undefined, () => null);
    auto.onCharacter(state({ room, stealth: 'sneaking' }));
    drain();
    expect(sent).toEqual(['bs giant rat']);
  });

  /*
   * `unknown` is nobody having said, and it never refuses — the rule every
   * threshold in this client follows. Hiding is not tracked on `Stealth` at
   * all (no success line for `hide` has ever been captured), so a hidden
   * character reads `unknown` and keeps its backstab.
   */
  it('spends it on a character nobody has said anything about', () => {
    const auto = make(combat({ opener: 'bs' }));
    auto.onCharacter(state({ room, stealth: 'unknown' }));
    drain();
    expect(sent).toEqual(['bs giant rat']);
  });

  /* And an opener that has nothing to do with stealth is unaffected. */
  it('spends a jumpkick opener whatever the realm can see', () => {
    const auto = make(combat({ opener: 'ju' }));
    auto.onCharacter(state({ room, stealth: 'seen' }));
    drain();
    expect(sent).toEqual(['ju giant rat']);
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

  /*
   * And the count is rounds **between looks**, not rounds of one fight.
   *
   * It restarted with every `*Combat Off*` — the very event that makes the
   * room list stale — so a room of four monsters fought one at a time, three
   * or four rounds each, got no look at all: every fight ended before the
   * third round was counted and took the count with it (live, 2026-09-14,
   * Rhudaur Town Centre, 134 fights and 113 looks where the setting asks for
   * one every three rounds).
   */
  it('counts the rounds between looks across the fights they fall in', () => {
    const auto = make(combat({ engage: 'none', refreshRounds: 3 }));
    const fighting = (inCombat: boolean) =>
      state({
        room,
        inCombat,
        combat: {
          ...EMPTY_CHARACTER.combat,
          engaged: inCombat,
          target: inCombat ? 'giant rat' : null
        }
      });

    auto.onCharacter(fighting(true));
    for (let round = 0; round < 2; round += 1) {
      auto.onBlock(block('mob-hits'));
      vi.advanceTimersByTime(200);
    }
    drain();
    expect(sent).toEqual([]);

    // The monster dies and the next one in the room is engaged a moment later.
    auto.onCharacter(fighting(false));
    auto.onCharacter(fighting(true));
    auto.onBlock(block('mob-hits'));
    vi.advanceTimersByTime(200);
    drain();
    expect(sent).toEqual(['']);
  });

  /*
   * A monster goes on hitting a character lying mortally wounded, and each
   * blow arms the round clock, which ticks on the last state the session
   * handed over: the one standing (todo 760). Down, the round sends nothing;
   * up, the same blows are rounds again.
   */
  it('keeps no rounds while the character is on the ground', () => {
    const auto = make(combat({ engage: 'none', refreshRounds: 1 }));
    auto.onCharacter(
      state({
        room,
        inCombat: true,
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, target: 'giant rat' }
      })
    );
    down = true;
    for (let round = 0; round < 3; round += 1) {
      auto.onBlock(block('mob-hits'));
      vi.advanceTimersByTime(200);
    }
    drain();
    expect(sent).toEqual([]);

    down = false;
    auto.onBlock(block('mob-hits'));
    vi.advanceTimersByTime(200);
    drain();
    expect(sent).toEqual(['']);
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

  /*
   * And the backstab refusal is about the **weapon**, not the character:
   * `AttackCommand.cs:115` reads `WeaponSlot.EquippedItem.CanBackstab` where
   * every other arm of that switch reads `GetAbility`.
   *
   * Reported 2026-09-11 out of the player's own log — `bs du` holding a golden
   * pike answered `You may not backstab with this weapon!`, the pike was
   * swapped for an ice crystal falchion that backstabs perfectly well, and
   * every fight for the rest of the session opened with plain `attack`.
   */
  describe('a refusal the realm blamed on the weapon', () => {
    const holding = (weapon: string, room?: CharacterState['room']): CharacterState =>
      state({
        ...(room === undefined ? {} : { room }),
        inventory: {
          ...EMPTY_CHARACTER.inventory,
          items: [
            {
              name: weapon,
              source: 'wire',
              slot: WEAPON_HAND,
              equipped: true,
              charges: null
            }
          ]
        }
      });
    const rat = { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'hostile')] };

    it('comes back the moment the hand holds something else', () => {
      const auto = make(combat({ opener: 'bs' }));
      auto.onCharacter(holding('golden pike'));
      auto.onBlock(block('attack-refused', { skill: 'backstab', weapon: 'this weapon' }));

      // Still the pike, so still refused.
      auto.onCharacter(holding('golden pike', rat));
      drain();
      expect(sent).toEqual(['a giant rat']);

      // `You are now holding ice crystal falchion.`, and the first fight ends
      // so the opener is available again.
      auto.onCharacter({ ...holding('ice crystal falchion', rat), inCombat: true });
      auto.onCharacter(
        holding('ice crystal falchion', {
          ...EMPTY_CHARACTER.room,
          occupants: [mob('kobold thief', 'hostile')]
        })
      );
      drain();
      expect(sent).toEqual(['a giant rat', 'bs kobold thief']);
      expect(notices.filter((n) => /no longer in hand/.test(n))).toHaveLength(1);
    });

    /*
     * A refusal taken before any listing named the weapon is still a weapon's
     * refusal, not the character's — collapsing the two made it permanent.
     */
    it('is released by the first listing that names a weapon', () => {
      const auto = make(combat({ opener: 'bs' }));
      auto.onBlock(block('attack-refused', { skill: 'backstab', weapon: 'this weapon' }));
      auto.onCharacter(holding('ice crystal falchion', rat));
      drain();
      expect(sent).toEqual(['bs giant rat']);
    });

    /* And a class refusal is not released by a weapon change. */
    it('does not release a refusal the realm blamed on the character', () => {
      const auto = make(combat({ opener: 'bash' }));
      auto.onBlock(block('attack-refused', { skill: 'bashing' }));
      auto.onCharacter(holding('ice crystal falchion', rat));
      drain();
      expect(sent).toEqual(['a giant rat']);
    });
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

  /*
   * *Auto Choose Best Spell* (todo 09): the round spell is derived from the
   * book and the realm's figures. The reviewer's example — a lightning-
   * resisting monster — never sees the bolt.
   */
  it('derives the round spell from the book, skipping what the target resists, and says so once', () => {
    const realm = (name: string) =>
      (
        ({
          'lightning bolt': {
            id: 8,
            name: 'lightning bolt',
            short: 'lbol',
            level: 8,
            mana: 3,
            targets: 8,
            power: [40, 60],
            element: 'lightning'
          },
          'fire jet': {
            id: 9,
            name: 'fire jet',
            short: 'fjet',
            level: 6,
            mana: 5,
            targets: 8,
            power: [30, 55],
            element: 'fire'
          }
        }) as Record<string, WorldSpell>
      )[name] ?? null;
    const auto = new AutoCombat(
      combat({ engage: 'none' }),
      true,
      queue,
      { notice: (m) => notices.push(m), onTheGround: () => down },
      { ...DEFAULT_CONFIG.automation.spells, autoChoose: true, minMana: 0 },
      realm
    );
    const target: MobEntity = {
      name: 'mutant',
      rawName: 'mutant',
      source: 'hybrid',
      charmed: false,
      disposition: 'hostile',
      uncertain: false,
      costly: 'never',
      hp: 100,
      abilities: [[66, 100]]
    };
    const fight = state({
      inCombat: true,
      combat: { ...EMPTY_CHARACTER.combat, engaged: true, target: 'mutant', targetEntity: target },
      vitals: { ...EMPTY_CHARACTER.vitals, mana: 40, manaMax: 100, manaType: 'MA' },
      progress: { ...EMPTY_CHARACTER.progress, level: 10 },
      spellbook: [
        { name: 'lightning bolt', short: 'lbol', level: 8, cost: 3 },
        { name: 'fire jet', short: 'fjet', level: 6, cost: 5 }
      ]
    });
    auto.onCharacter(fight);
    auto.onBlock(block('user-hits'));
    vi.advanceTimersByTime(200);
    drain();
    expect(sent).toEqual(['fjet mutant']);
    expect(notices.filter((n) => /Casting fire jet/.test(n))).toHaveLength(1);
    // Said once: the next round repeats the choice and not the sentence.
    auto.onBlock(block('user-hits'));
    vi.advanceTimersByTime(200);
    drain();
    expect(notices.filter((n) => /Casting fire jet/.test(n))).toHaveLength(1);
  });

  it('asks for the book once when the choice has none to read', () => {
    let asked = 0;
    const auto = new AutoCombat(
      combat({ engage: 'none' }),
      true,
      queue,
      { notice: (m) => notices.push(m), needBook: () => (asked += 1), onTheGround: () => down },
      { ...DEFAULT_CONFIG.automation.spells, autoChoose: true, minMana: 0 }
    );
    const fight = state({
      inCombat: true,
      combat: { ...EMPTY_CHARACTER.combat, engaged: true, target: 'giant rat' },
      vitals: { ...EMPTY_CHARACTER.vitals, mana: 40, manaMax: 100, manaType: 'MA' },
      spellbook: null
    });
    auto.onCharacter(fight);
    auto.onBlock(block('user-hits'));
    auto.onBlock(block('user-hits'));
    vi.advanceTimersByTime(200);
    drain();
    expect(sent).toEqual([]);
    expect(asked).toBe(1);
    expect(notices.some((n) => /no spellbook to choose from/.test(n))).toBe(true);
  });

  it('casts the attack spell on the mid-round tick', () => {
    const auto = make(combat({ engage: 'none' }), true, {
      attack: 'ma',
      areaAttack: '',
      areaMinMobs: 3,
      areaMinMana: 0,
      attackFallback: '',
      attackCasts: 0,
      areaCasts: 0,
      heal: '',
      healPartyWith: '',
      healBelow: 0,
      healBelowInCombat: 0,
      healTo: 0,
      healParty: false,
      invokeItems: false,
      minMana: 0.15,
      cures: { blindness: '', poison: '', disease: '', freedom: '' },
      blessings: [],
      notifyPartyOnWearOff: false,
      autoBless: true,
      autoChoose: false
    });
    auto.onCharacter(fighting());
    auto.onBlock(block('user-hits'));
    vi.advanceTimersByTime(200);
    drain();
    expect(sent).toEqual(['ma giant rat']);
  });

  /* The refused half of a round on the ground: the cast (`CastCommand`, todo 760). */
  it('casts nothing while the character is on the ground, and casts once up', () => {
    const auto = make(combat({ engage: 'none', refreshRounds: 0 }), true, {
      ...DEFAULT_CONFIG.automation.spells,
      attack: 'ma',
      autoChoose: false,
      minMana: 0
    });
    auto.onCharacter(fighting());
    down = true;
    auto.onBlock(block('user-hits'));
    vi.advanceTimersByTime(200);
    drain();
    expect(sent).toEqual([]);
    down = false;
    auto.onBlock(block('user-hits'));
    vi.advanceTimersByTime(200);
    drain();
    expect(sent).toEqual(['ma giant rat']);
  });

  it('names what it is casting at, so it cannot fall back to the last target', () => {
    const auto = make(combat({ engage: 'none' }), true, {
      attack: 'ice blade',
      areaAttack: '',
      areaMinMobs: 3,
      areaMinMana: 0,
      attackFallback: '',
      attackCasts: 0,
      areaCasts: 0,
      heal: '',
      healPartyWith: '',
      healBelow: 0,
      healBelowInCombat: 0,
      healTo: 0,
      healParty: false,
      invokeItems: false,
      minMana: 0,
      cures: { blindness: '', poison: '', disease: '', freedom: '' },
      blessings: [],
      notifyPartyOnWearOff: false,
      autoBless: true,
      autoChoose: false
    });
    auto.onCharacter(fighting());
    auto.onBlock(block('mob-hits'));
    vi.advanceTimersByTime(200);
    drain();
    // The whole spell name, not a first word: the server matches on a prefix,
    // so `ice` would cast whatever begins with it.
    expect(sent).toEqual(['ice blade giant rat']);
  });

  it('casts nothing when the mana is not there', () => {
    const auto = make(combat({ engage: 'none', refreshRounds: 0 }), true, {
      attack: 'ma',
      areaAttack: '',
      areaMinMobs: 3,
      areaMinMana: 0,
      attackFallback: '',
      attackCasts: 0,
      areaCasts: 0,
      heal: '',
      healPartyWith: '',
      healBelow: 0,
      healBelowInCombat: 0,
      healTo: 0,
      healParty: false,
      invokeItems: false,
      minMana: 0.9,
      cures: { blindness: '', poison: '', disease: '', freedom: '' },
      blessings: [],
      notifyPartyOnWearOff: false,
      autoBless: true,
      autoChoose: false
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
      attackFallback: '',
      attackCasts: 0,
      areaCasts: 0,
      heal: '',
      healPartyWith: '',
      healBelow: 0,
      healBelowInCombat: 0,
      healTo: 0,
      healParty: false,
      invokeItems: false,
      minMana: 0.9,
      cures: { blindness: '', poison: '', disease: '', freedom: '' },
      blessings: [],
      notifyPartyOnWearOff: false,
      autoBless: true,
      autoChoose: false
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
    expect(sent).toEqual(['ma giant rat']);
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
      attackFallback: '',
      attackCasts: 0,
      areaCasts: 0,
      heal: '',
      healPartyWith: '',
      healBelow: 0,
      healBelowInCombat: 0,
      healTo: 0,
      healParty: false,
      invokeItems: false,
      minMana: 0,
      cures: { blindness: '', poison: '', disease: '', freedom: '' },
      blessings: [],
      notifyPartyOnWearOff: false,
      autoBless: true,
      autoChoose: false
    });
    auto.onCharacter(fighting());
    auto.onBlock(block('user-hits'));
    vi.advanceTimersByTime(200);
    drain();
    expect(sent).toEqual(['ma giant rat']);
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
      attackFallback: '',
      attackCasts: 0,
      areaCasts: 0,
      heal: '',
      healPartyWith: '',
      healBelow: 0,
      healBelowInCombat: 0,
      healTo: 0,
      healParty: false,
      invokeItems: false,
      minMana: 0.15,
      cures: { blindness: '', poison: '', disease: '', freedom: '' },
      blessings: [],
      notifyPartyOnWearOff: false,
      autoBless: true,
      autoChoose: false,
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
      expect(sent).toEqual(['ma giant rat']);
    });

    /* MegaMUD's FailoverSpellAttacks: the server says the round spell has no
       effect on this target, so the fallback stands in for the rest of the
       fight rather than the same immune spell being paid for every round. */
    /* These run several rounds, so the room re-read `refreshRounds` sends on
       the third is switched off: what is under test is what a round *casts*. */
    const rounds = () => combat({ engage: 'none', refreshRounds: 0 });

    it('casts the fallback once the round spell is refused as having no effect', () => {
      const auto = make(rounds(), true, spells({ attackFallback: 'mmis' }));
      auto.onCharacter(crowded(1));
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      expect(sent).toEqual(['ma giant rat']);
      auto.onBlock(block('spell-ineffective', { target: 'giant rat' }));
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      expect(sent).toEqual(['ma giant rat', 'mmis giant rat']);
      expect(notices.some((line) => line.includes('mmis'))).toBe(true);
    });

    /* The server goes on casting a spell with no effect for as long as it is
       the character's attack, so with no fallback the round changes to the
       attack verb — once, and said once. */
    it('hands the fight to the attack verb with no fallback, and says so once', () => {
      const auto = make(rounds(), true, spells());
      auto.onCharacter(crowded(1));
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      auto.onBlock(block('spell-ineffective', { target: 'giant rat' }));
      auto.onBlock(block('spell-ineffective', { target: 'giant rat' }));
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      expect(sent).toEqual(['ma giant rat', 'a giant rat']);
      expect(notices.filter((line) => line.includes('no effect'))).toHaveLength(1);
    });

    /* MegaMUD's MaxCastCnt, counted on the server's own repeats: a fizzle is
       not a cast and needs nothing sent, since the server casts again next
       round by itself (todo 816); the cap spent, the round changes to `a`. */
    it('stops casting after the configured casts per target', () => {
      const auto = make(rounds(), true, spells({ attackCasts: 1 }));
      auto.onCharacter(crowded(1));
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      auto.onBlock(block('combat-status', { status: 'Engaged' }));
      auto.onBlock(block('spell-failed'));
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      expect(sent).toEqual(['ma giant rat']);
      auto.onBlock(block('spell-cast', { caster: 'You', spell: 'ma', target: 'giant rat' }));
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      expect(sent).toEqual(['ma giant rat', 'a giant rat']);
    });

    /* A heal confirmed in the same window is a different spell and spends
       nothing of the round spell's count. */
    it('counts only the spell it proposed', () => {
      const auto = make(rounds(), true, spells({ attackCasts: 1 }));
      auto.onCharacter(crowded(1));
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      auto.onBlock(block('spell-cast', { caster: 'You', spell: 'minor healing' }));
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      expect(sent).toEqual(['ma giant rat']);
    });

    /* The fight over — an Off that answers no attack — the next monster's
       fight is its own, with the whole cap to spend. */
    it('starts the count again on a new target', () => {
      const auto = make(rounds(), true, spells({ attackCasts: 1 }));
      auto.onCharacter(crowded(1));
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      auto.onBlock(block('spell-cast', { caster: 'You', spell: 'ma', target: 'giant rat' }));
      auto.onBlock(block('combat-status', { status: 'Off' }), null);
      const next = crowded(1);
      auto.onCharacter({ ...next, combat: { ...next.combat, target: 'kobold thief' } });
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      expect(sent).toEqual(['ma giant rat', 'ma kobold thief']);
    });

    it('casts the crowd spell bare at the threshold', () => {
      const auto = make(combat({ engage: 'none' }), true, spells());
      auto.onCharacter(crowded(3));
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      expect(sent).toEqual(['poison cloud']);
    });

    it('falls back to the single-target spell under the crowd floor', () => {
      // 20% mana: under the crowd floor (35%), above the ordinary one (15%).
      const auto = make(combat({ engage: 'none' }), true, spells());
      auto.onCharacter(crowded(3, 20));
      auto.onBlock(block('user-hits'));
      vi.advanceTimersByTime(200);
      drain();
      expect(sent).toEqual(['ma giant rat']);
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
      expect(sent).toEqual(['poison cloud']);
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
      expect(sent).toEqual(['ma giant rat']);
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
      expect(sent).toEqual(['ma giant rat']);
    });
  });
});

/*
 * Todo 816: an attack spell opens the fight in place of `a`, and the server
 * casts it every round from then on — GreaterMUD wire, vaelor2 2026-09-01:
 * `harm k`, `*Combat Off*`, `*Combat Engaged*`, then `You cast harm at tall
 * kobold thief for 15 damage!` twice in the next round, nothing typed.
 */
describe('an attack spell opens the fight', () => {
  const caster = (over: Partial<SpellsConfig> = {}): SpellsConfig => ({
    ...DEFAULT_CONFIG.automation.spells,
    attack: 'harm',
    autoChoose: false,
    minMana: 0,
    ...over
  });
  const fights = (over: Partial<CombatConfig> = {}) => combat({ refreshRounds: 0, ...over });
  const room = { ...EMPTY_CHARACTER.room, occupants: [mob('tall kobold thief', 'hostile')] };
  const vitals = (mana: number) => ({
    ...EMPTY_CHARACTER.vitals,
    mana,
    manaMax: 100,
    manaType: 'MA' as const
  });
  const standing = (mana = 40) => state({ room, vitals: vitals(mana) });
  const fighting = (mana = 40) =>
    state({
      room,
      vitals: vitals(mana),
      inCombat: true,
      combat: { ...EMPTY_CHARACTER.combat, engaged: true, target: 'tall kobold thief' }
    });
  /** One of the server's own casts, as the wire prints it: a blow. */
  const repeat = (auto: AutoCombat, spell = 'harm') =>
    auto.onBlock(
      block('user-hits', {
        attacker: 'You',
        line: `cast ${spell} at tall kobold thief`,
        damage: '15'
      })
    );
  const round = () => {
    vi.advanceTimersByTime(200);
    drain();
  };
  /** The engagement the opener's cast is answered with, and the state it leaves. */
  const engaged = (auto: AutoCombat, mana = 40) => {
    auto.onBlock(block('combat-status', { status: 'Engaged' }));
    auto.onCharacter(fighting(mana));
  };

  it('casts at the monster instead of attacking it', () => {
    const auto = make(fights(), true, caster());
    auto.onCharacter(standing());
    drain();
    expect(sent).toEqual(['harm tall kobold thief']);
  });

  it('sends nothing more while the server repeats the spell', () => {
    const auto = make(fights(), true, caster());
    auto.onCharacter(standing());
    drain();
    engaged(auto);
    for (let i = 0; i < 3; i += 1) {
      repeat(auto);
      round();
    }
    expect(sent).toEqual(['harm tall kobold thief']);
  });

  it("counts the server's repeats toward the cap, then changes to the attack verb once", () => {
    const auto = make(fights(), true, caster({ attackCasts: 2 }));
    auto.onCharacter(standing());
    drain();
    engaged(auto);
    repeat(auto);
    round();
    expect(sent).toEqual(['harm tall kobold thief']);
    repeat(auto);
    round();
    auto.onBlock(block('user-hits'));
    round();
    expect(sent).toEqual(['harm tall kobold thief', 'a tall kobold thief']);
  });

  /* A cast into a fight answers `*Combat Off*` and `*Combat Engaged*`: the
     Off is its own, so neither the count nor the engage cooldown goes. */
  it('keeps the count and the cooldown through its own re-engagement', () => {
    const auto = make(fights(), true, caster({ attackCasts: 2 }));
    auto.onCharacter(standing());
    drain();
    engaged(auto);
    repeat(auto);
    auto.onBlock(block('combat-status', { status: 'Off' }), 'harm tall kobold thief');
    auto.onCharacter(standing());
    drain();
    expect(sent).toEqual(['harm tall kobold thief']);
    engaged(auto);
    repeat(auto);
    round();
    expect(sent).toEqual(['harm tall kobold thief', 'a tall kobold thief']);
  });

  /* `DoMagicRound` casts nothing a round the pool cannot pay for, and the
     character would stand in the fight doing nothing. */
  it('changes to the attack verb when the mana floor is reached', () => {
    const auto = make(fights(), true, caster({ minMana: 0.3 }));
    auto.onCharacter(standing(60));
    drain();
    engaged(auto, 20);
    repeat(auto);
    round();
    expect(sent).toEqual(['harm tall kobold thief', 'a tall kobold thief']);
  });

  it('opens with the class opener, and the round changes to the spell', () => {
    const auto = make(fights({ opener: 'bs' }), true, caster());
    auto.onCharacter(standing());
    drain();
    auto.onCharacter(fighting());
    auto.onBlock(block('user-hits'));
    round();
    expect(sent).toEqual(['bs tall kobold thief', 'harm tall kobold thief']);
  });

  it('does not backstab a monster its row says not to', () => {
    const rules = [{ mob: 'tall kobold thief', treat: 'default' as const, noBackstab: true }];
    const auto = make(fights({ opener: 'bs', mobRules: rules }));
    auto.onCharacter(standing());
    drain();
    expect(sent).toEqual(['a tall kobold thief']);
  });

  it('fights a monster with the spell its row names, at most as often as it says', () => {
    const rules = [
      { mob: 'tall kobold thief', treat: 'default' as const, cast: { spell: 'mmis', times: 1 } }
    ];
    const auto = make(fights({ mobRules: rules }), true, caster());
    auto.onCharacter(standing());
    drain();
    auto.onCharacter(fighting());
    repeat(auto, 'mmis');
    round();
    expect(sent).toEqual(['mmis tall kobold thief', 'harm tall kobold thief']);
  });

  /* A bare cast names nobody for the engagement to bind. */
  it('never opens with the room spell', () => {
    const auto = make(
      fights(),
      true,
      caster({ attack: '', areaAttack: 'pclo', areaMinMobs: 1, areaMinMana: 0 })
    );
    auto.onCharacter(standing());
    drain();
    expect(sent).toEqual(['a tall kobold thief']);
  });

  /* The player's spell is theirs: with nothing configured, a round must not
     put the character back on melee (816 review). */
  it("leaves the player's own spell alone with none configured", () => {
    const auto = make(fights(), true, caster({ attack: '' }));
    const book = [{ name: 'harm', short: 'harm', level: 1, cost: 1 }];
    auto.onCharacter({ ...fighting(), spellbook: book });
    auto.noteUserCommand('harm tall');
    auto.onBlock(block('user-hits'));
    round();
    auto.onBlock(block('user-hits'));
    round();
    expect(sent).toEqual([]);
  });

  /*
   * An instant spell breaks the fight it is cast into and engages nothing
   * (`Player.cs:6044-6049`), so its Off is no re-engagement: the monster is
   * owed its attack back at once (todo 03). A combat spell's Off is followed
   * by its engagement, which keeps the cooldown (the control).
   */
  describe('a cast whose Off the next line explains', () => {
    const book = [
      { name: 'hold person', short: 'hold', level: 1, cost: 1 },
      { name: 'harm', short: 'harm', level: 1, cost: 1 }
    ];
    const opened = (auto: AutoCombat) => {
      auto.onCharacter({ ...standing(), spellbook: book });
      drain();
      auto.onCharacter({ ...fighting(), spellbook: book });
    };

    it('re-engages at once after an instant spell cast into the fight', () => {
      const auto = make(fights());
      opened(auto);
      auto.onBlock(block('combat-status', { status: 'Off' }), 'hold tall kobold thief');
      auto.onBlock(
        block('spell-cast', { caster: 'You', spell: 'hold person', target: 'tall kobold thief' })
      );
      auto.onCharacter({ ...standing(), spellbook: book });
      drain();
      expect(sent).toEqual(['a tall kobold thief', 'a tall kobold thief']);
    });

    it('keeps the cooldown when the engagement follows', () => {
      const auto = make(fights());
      opened(auto);
      auto.onBlock(block('combat-status', { status: 'Off' }), 'harm tall kobold thief');
      auto.onBlock(block('status-line'));
      auto.onBlock(block('combat-status', { status: 'Engaged' }));
      auto.onCharacter({ ...standing(), spellbook: book });
      drain();
      expect(sent).toEqual(['a tall kobold thief']);
    });
  });

  /* A cast answered by its own result before any engagement is instant: it
     no longer opens a fight, and is cast each round instead. */
  it('learns an instant attack spell from its answer, and stops opening with it', () => {
    const book = [{ name: 'hold person', short: 'hold', level: 1, cost: 1 }];
    const auto = make(fights(), true, caster({ attack: 'hold person' }));
    auto.onCharacter({ ...standing(), spellbook: book });
    drain();
    expect(sent).toEqual(['hold tall kobold thief']);
    auto.onBlock(
      block('spell-cast', { caster: 'You', spell: 'hold person', target: 'tall kobold thief' })
    );
    expect(notices.some((line) => line.includes('instant'))).toBe(true);
    const rat = {
      ...EMPTY_CHARACTER.room,
      name: 'A Lane',
      occupants: [mob('small rat', 'hostile')]
    };
    auto.onCharacter(state({ room: rat, vitals: vitals(40), spellbook: book }));
    drain();
    expect(sent).toEqual(['hold tall kobold thief', 'a small rat']);
    const onRat = state({
      room: rat,
      vitals: vitals(40),
      spellbook: book,
      inCombat: true,
      combat: { ...EMPTY_CHARACTER.combat, engaged: true, target: 'small rat' }
    });
    auto.onCharacter(onRat);
    auto.onBlock(block('user-hits'));
    round();
    auto.onBlock(block('user-hits'));
    round();
    expect(sent).toEqual([
      'hold tall kobold thief',
      'a small rat',
      'hold small rat',
      'hold small rat'
    ]);
  });

  it('keeps opening with a spell whose engagement answers it', () => {
    const book = [{ name: 'harm', short: 'harm', level: 1, cost: 1 }];
    const auto = make(fights(), true, caster());
    auto.onCharacter({ ...standing(), spellbook: book });
    drain();
    auto.onBlock(block('combat-status', { status: 'Engaged' }));
    repeat(auto);
    auto.onBlock(block('combat-status', { status: 'Off' }), null);
    const rat = {
      ...EMPTY_CHARACTER.room,
      name: 'A Lane',
      occupants: [mob('small rat', 'hostile')]
    };
    auto.onCharacter(state({ room: rat, vitals: vitals(40), spellbook: book }));
    drain();
    expect(sent).toEqual(['harm tall kobold thief', 'harm small rat']);
    expect(notices.some((line) => line.includes('instant'))).toBe(false);
  });

  /*
   * Todo 820: what the wire taught is the realm's, kept in `RealmLore` beside
   * the death sentences, so the one misjudged opening is paid once per realm
   * rather than once per connection. Each `launch` is a fresh store over the
   * same file, as the next start of the client is.
   */
  describe('an instant spell, remembered per realm', () => {
    const book = [
      { name: 'hold person', short: 'hold', level: 1, cost: 1 },
      { name: 'harm', short: 'harm', level: 1, cost: 1 }
    ];
    let dir: string;
    let file: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-instants-'));
      file = path.join(dir, 'mob-lore.json');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const launch = () => new RealmLore({ file, saveDelayMs: 0 });
    /** One connection: a fresh unit opening on the kobold, and what it sent. */
    const connect = (lore: RealmLore, attack: string): { auto: AutoCombat; opened: string[] } => {
      sent = [];
      const auto = make(
        fights(),
        true,
        caster({ attack }),
        undefined,
        undefined,
        lore.forRealm('greatermud', undefined)
      );
      auto.onCharacter({ ...standing(), spellbook: book });
      drain();
      return { auto, opened: [...sent] };
    };
    /** The first connection pays the one opening and learns the spell instant. */
    const learnHold = (): void => {
      const lore = launch();
      const { auto, opened } = connect(lore, 'hold person');
      expect(opened).toEqual(['hold tall kobold thief']);
      auto.onBlock(
        block('spell-cast', { caster: 'You', spell: 'hold person', target: 'tall kobold thief' })
      );
      lore.flush();
    };

    it('opens the next connection with the melee verb, and says why once', () => {
      learnHold();
      notices = [];
      const { auto, opened } = connect(launch(), 'hold person');
      expect(opened).toEqual(['a tall kobold thief']);
      auto.onCharacter({ ...fighting(), spellbook: book });
      auto.onBlock(block('user-hits'));
      round();
      const said = notices.filter((line) => line.includes('hold person'));
      expect(said).toHaveLength(1);
      expect(said[0]).toMatch(/instant/);
    });

    it('still opens with a spell this realm never answered instantly (the control)', () => {
      learnHold();
      expect(connect(launch(), 'harm').opened).toEqual(['harm tall kobold thief']);
    });

    it('is forgotten with the realm lore, when the player deletes the file', () => {
      learnHold();
      expect(fs.existsSync(file)).toBe(true);
      fs.rmSync(file);
      expect(connect(launch(), 'hold person').opened).toEqual(['hold tall kobold thief']);
    });
  });

  it('takes a spell the player cast as what the server repeats', () => {
    const auto = make(fights(), true, caster());
    const book = [{ name: 'harm', short: 'harm', level: 1, cost: 1 }];
    auto.onCharacter({ ...fighting(), spellbook: book });
    auto.noteUserCommand('harm tall');
    auto.onBlock(block('user-hits'));
    round();
    expect(sent).toEqual([]);
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

  /*
   * festus, 2026-09-23 (todo 03): `aa dustdevil`, then a lapsed `gbls` 167ms
   * later — an instant spell ends the fight — and the cooldown the `aa` had
   * just armed refused the re-engage until the dustdevil had swung twice.
   */
  it('re-engages at once when a cast, not an attack, ended the fight', () => {
    const auto = make(combat());
    const devil = mob('dustdevil', 'hostile');
    const here = { ...EMPTY_CHARACTER.room, occupants: [devil] };

    auto.onCharacter(state({ room: here }));
    drain();
    expect(sent).toEqual(['a dustdevil']);

    auto.onCharacter(
      state({
        room: here,
        inCombat: true,
        combat: { ...EMPTY_CHARACTER.combat, target: 'dustdevil', engaged: true }
      })
    );
    auto.onBlock(block('combat-status', { status: 'Off' }), 'gbls');
    auto.onCharacter(state({ room: here, inCombat: false }));
    drain();
    expect(sent).toEqual(['a dustdevil', 'a dustdevil']);
  });

  it('keeps the cooldown when the Off answers the attack itself', () => {
    const auto = make(combat());
    const devil = mob('dustdevil', 'hostile');
    const here = { ...EMPTY_CHARACTER.room, occupants: [devil] };

    auto.onCharacter(state({ room: here }));
    drain();
    auto.onCharacter(
      state({
        room: here,
        inCombat: true,
        combat: { ...EMPTY_CHARACTER.combat, target: 'dustdevil', engaged: true }
      })
    );
    // A re-attack's own pair, and a bare prompt's Off: neither releases it.
    auto.onBlock(block('combat-status', { status: 'Off' }), 'aa dustdevil');
    auto.onBlock(block('combat-status', { status: 'Off' }), null);
    auto.onCharacter(state({ room: here, inCombat: false }));
    drain();
    expect(sent).toEqual(['a dustdevil']);
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

  /*
   * The case the single-slot cooldown could not answer (todo 07). Two monsters
   * in the room, and `aa <mob>` is answered by `*Combat Off*` then `*Combat
   * Engaged*` — so between the two blocks the target is null and the room
   * looks like one nobody is fighting in. Attacking the second overwrote the
   * first's record, so the first read as never asked about, and the live
   * transcript shows `aa thin gnoll scout` / `aa gnoll scout` alternating once
   * a prompt for ever, neither monster ever swinging back.
   */
  it('does not alternate between two monsters in the room', () => {
    const auto = make(combat());
    const here = {
      ...EMPTY_CHARACTER.room,
      occupants: [mob('thin gnoll scout', 'hostile'), mob('gnoll scout', 'hostile')]
    };
    auto.onCharacter(state({ room: here }));
    drain();
    expect(sent).toHaveLength(1);
    const first = sent[0]!;

    /*
     * Twenty of the server's own answers: `*Combat Off*` and `*Combat Engaged*`
     * are one answer arriving as two blocks, and every Off used to be read as
     * a room with a free hand in it.
     *
     * Asserted on the **set** of things swung at rather than the count of
     * swings: re-asking about the *same* monster once the engage cooldown has
     * run out is the settled behaviour (an attack refused for a reason this
     * client cannot see leaves the room exactly as it was), and twenty drains
     * is twice that cooldown. The bug was never the count — it was that the
     * second monster was ever swung at at all.
     */
    for (let i = 0; i < 20; i += 1) {
      auto.onCharacter(state({ room: here, inCombat: false }));
      auto.onCharacter(
        state({
          room: here,
          inCombat: true,
          combat: { ...EMPTY_CHARACTER.combat, engaged: true, target: first.slice(2) }
        })
      );
      drain();
    }
    expect([...new Set(sent)]).toEqual([first]);
  });

  it('goes for the other one once the first is dead, without waiting out a cooldown', () => {
    // The guard above must not become a tax on the next fight: a kill clears
    // the target, and the room still holds something worth swinging at.
    const auto = make(combat());
    const thin = mob('thin gnoll scout', 'hostile');
    const stout = mob('gnoll scout', 'hostile');
    auto.onCharacter(state({ room: { ...EMPTY_CHARACTER.room, occupants: [thin, stout] } }));
    drain();
    expect(sent).toHaveLength(1);
    // The one it went for dies and leaves the room.
    const dead = sent[0]!.slice(2);
    const left = [thin, stout].filter((who) => who.name !== dead);
    auto.onCharacter(state({ room: { ...EMPTY_CHARACTER.room, occupants: left } }));
    drain();
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toBe(sent[0]);
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

/*
 * One target, kept until it is dead (todo 00, 2026-09-23). Festus's desert
 * fight: the leader died, `aa saracen raider` went out, and each raider's
 * first swing before the engagement came back — the tracker files the newest
 * attacker first, and equal verdicts tie in that order — sent another `aa`,
 * three a round, every round, each cancelling the last.
 */
describe('one target until it is dead', () => {
  const raider = (name: string): RoomOccupant => fighter(name, 250, [bite(5, 18, 105)]);
  const desert = {
    ...EMPTY_CHARACTER.room,
    occupants: [
      raider('saracen raider'),
      raider('small saracen raider'),
      raider('fat saracen raider')
    ]
  };
  const swinging = (attackers: string[], target: string | null = null): CharacterState =>
    state({
      room: desert,
      inCombat: target !== null,
      combat: { ...EMPTY_CHARACTER.combat, engaged: target !== null, target, attackers }
    });

  it('does not open on each new attacker before the first attack is answered', () => {
    const auto = make(combat({ attack: 'aa', engage: 'hostile' }));
    auto.onCharacter(swinging([]));
    drain();
    expect(sent).toEqual(['aa saracen raider']);

    auto.onCharacter(swinging(['saracen raider']));
    auto.onCharacter(swinging(['small saracen raider', 'saracen raider']));
    auto.onCharacter(swinging(['fat saracen raider', 'small saracen raider', 'saracen raider']));
    drain();
    expect(sent).toEqual(['aa saracen raider']);
  });

  it('goes back to the same one after the fight drops, past the cooldown', () => {
    const auto = make(combat({ attack: 'aa', engage: 'hostile' }));
    auto.onCharacter(swinging([]));
    drain();
    auto.onCharacter(swinging([], 'saracen raider'));
    // A heal's `*Combat Off*` a round later: target and attackers cleared,
    // and the others' blows arrive newest first.
    vi.advanceTimersByTime(5_000);
    auto.onCharacter(swinging([]));
    auto.onCharacter(swinging(['fat saracen raider']));
    auto.onCharacter(swinging(['small saracen raider', 'fat saracen raider']));
    drain();
    expect(sent).toEqual(['aa saracen raider', 'aa saracen raider']);
    expect(decisions.filter((one) => one.acted).at(-1)?.because).toContain('still on');
  });

  it('chooses afresh once it is dead', () => {
    const auto = make(combat({ attack: 'aa', engage: 'hostile' }));
    auto.onCharacter(swinging([]));
    drain();
    const rest = desert.occupants.filter((who) => who.name !== 'saracen raider');
    auto.onCharacter(state({ room: { ...desert, occupants: rest } }));
    drain();
    expect(sent).toEqual(['aa saracen raider', 'aa small saracen raider']);
  });

  it('keeps the one the player chose', () => {
    const auto = make(combat({ attack: 'aa', engage: 'hostile' }));
    auto.onCharacter(swinging([]));
    drain();
    auto.noteUserCommand('aa fat');
    vi.advanceTimersByTime(5_000);
    auto.onCharacter(swinging(['saracen raider']));
    drain();
    expect(sent).toEqual(['aa saracen raider', 'aa fat saracen raider']);
  });

  it('chooses afresh in a new room, whatever its monsters are called', () => {
    const auto = make(combat({ attack: 'aa', engage: 'hostile' }));
    auto.onCharacter(swinging([]));
    drain();
    expect(sent).toEqual(['aa saracen raider']);
    vi.advanceTimersByTime(5_000);
    // A step into the next `Scorching Desert`: a namesake, and a leader.
    auto.onCharacter(
      state({
        inCombat: true,
        room: {
          ...desert,
          arrival: 1,
          occupants: [
            raider('saracen raider'),
            fighter('fierce saracen leader', 350, [bite(8, 24, 110), bite(40, 80, 110)])
          ]
        },
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, attackers: ['saracen raider'] }
      })
    );
    drain();
    expect(sent).toEqual(['aa saracen raider', 'aa fierce saracen leader']);
  });

  /*
   * A monster that has not swung is one retaliation would be opening on, so
   * every refusal `choose` makes of it stands: the heavier one is not picked.
   */
  describe('weighing the whole fight passes the refusals opening would', () => {
    const ogre = (over: Partial<MobEntity> = {}): RoomOccupant =>
      fighter('orc warrior', 60, [bite(20, 60, 90)], over);
    const rat = fighter('giant rat', 20, [bite(1, 3, 20)]);
    const bitten = (occupants: RoomOccupant[], claimed = {}): CharacterState =>
      state({
        inCombat: true,
        room: { ...EMPTY_CHARACTER.room, occupants },
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, attackers: ['giant rat'], claimed }
      });

    it('positive control: the heavier bystander is taken first', () => {
      make(combat({ engage: 'hostile' })).onCharacter(bitten([ogre(), rat]));
      drain();
      expect(sent).toEqual(['a orc warrior']);
    });

    it('leaves a stranger’s monster to them', () => {
      make(combat({ engage: 'hostile', politeAttacks: true })).onCharacter(
        bitten([ogre(), rat], { 'orc warrior': { by: 'Rend', at: Date.now() } })
      );
      drain();
      expect(sent).toEqual(['a giant rat']);
    });

    it('leaves what a guard left alone protects', () => {
      const guard: RoomOccupant = {
        ...fighter('kobold thief', 30, [bite(1, 8, 15)]),
        mob: { ...fighter('kobold thief', 30, []).mob!, ids: [10] }
      };
      const ward = ogre({ ids: [20], abilities: [[GUARDED_BY_ABILITY, 10]] });
      make(
        combat({ engage: 'hostile', mobRules: [{ mob: 'kobold thief', treat: 'never' }] })
      ).onCharacter(bitten([guard, ward, rat]));
      drain();
      expect(sent).toEqual(['a giant rat']);
    });

    it('keeps to the caps', () => {
      make(combat({ engage: 'hostile', maxTargetHealth: 50 })).onCharacter(bitten([ogre(), rat]));
      make(combat({ engage: 'hostile', maxMonsterExperience: 100 })).onCharacter(
        bitten([ogre({ experience: 5_000 }), rat])
      );
      drain();
      expect(sent).toEqual(['a giant rat', 'a giant rat']);
    });
  });

  /* The first to swing is the order the server walks the room in, not the worst. */
  it('hits back at the worst of the whole fight, not the first to swing', () => {
    const auto = make(combat({ engage: 'hostile' }));
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
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, attackers: ['kobold thief'] }
      })
    );
    drain();
    expect(sent).toEqual(['a wererat shaman']);
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
    restWithLeader: false,
    askForHealBelow: 0
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
    restWithLeader: false,
    askForHealBelow: 0
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
 * a recorded session through a bespoke script and counting `rm` probes, for an
 * answer that was one line of configuration and invisible from everything the
 * client recorded.
 */
describe('saying why it did not open a fight', () => {
  const room = (...occupants: ReturnType<typeof mob>[]) =>
    state({ room: { ...EMPTY_CHARACTER.room, occupants } });

  it('names the journey the player turned fighting off for', () => {
    const auto = make(combat({ enabled: true }));
    auto.noteWalking(true);
    auto.configure(combat({ enabled: false }), true);
    auto.onCharacter(room(mob('thug', 'hostile')));
    drain();
    expect(sent).toEqual([]);
    expect(refusals()).toEqual(['thug — you turned auto-combat off for this journey']);
  });

  /* A journey nobody declined fights, whichever kind of journey it is. */
  it('says nothing about a walk that was not declined', () => {
    const auto = make(combat());
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

  it('names a row set to never attack', () => {
    const auto = make(combat({ mobRules: [{ mob: 'thug', treat: 'never' }] }));
    auto.onCharacter(room(mob('thug', 'hostile')));
    drain();
    expect(refusals()).toEqual(['thug — thug is set to never attack']);
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
    const auto = make(combat({ enabled: true }));
    auto.noteWalking(true);
    auto.configure(combat({ enabled: false }), true);
    const here = room(mob('thug', 'hostile'));
    auto.onCharacter(here);
    auto.onCharacter(here);
    auto.onCharacter(here);
    drain();
    expect(refusals()).toHaveLength(1);
  });

  /* And says it again when the answer changes. */
  it('says it again when a different monster is refused', () => {
    const auto = make(combat({ enabled: true }));
    auto.noteWalking(true);
    auto.configure(combat({ enabled: false }), true);
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
    const auto = make(combat({ enabled: true }));
    auto.noteWalking(true);
    auto.configure(combat({ enabled: false }), true);
    auto.onCharacter(room(mob('shopkeeper', 'passive')));
    drain();
    expect(refusals()).toEqual(['shopkeeper — you turned auto-combat off for this journey']);
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
    const auto = make(combat({ engage: 'all', maxTargetHealth: 10 }));
    auto.onCharacter(inRoom(unplaced('thing from the deep')));
    drain();
    expect(sent).toEqual(['a thing from the deep']);
  });

  /* Off is the shipped default, and off refuses nothing. Undead and a death
     spell are no longer refusals at all (todo 00): `avoid` says it by name. */
  it('refuses nothing while the ceiling is off', () => {
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

describe('a monster that protects another', () => {
  /** `who`, as realm rows `ids`, protected by the rows in `by` (`MonsGuards`). */
  function rows(who: RoomOccupant, ids: number[], by: number[] = []): RoomOccupant {
    return {
      ...who,
      mob: {
        ...who.mob!,
        ids,
        ...(by.length === 0
          ? {}
          : { abilities: by.map((row): [number, number] => [GUARDED_BY_ABILITY, row]) })
      }
    };
  }

  /** `who`, as a monster the realm says leaves this character alone. */
  function passive(who: RoomOccupant): RoomOccupant {
    return { ...who, disposition: 'passive', mob: { ...who.mob!, disposition: 'passive' } };
  }

  // The shaman is the one the weighing takes first ('which one to go for').
  const shaman = (by: number[]): RoomOccupant =>
    rows(fighter('wererat shaman', 40, [bite(10, 30, 60)]), [20], by);
  const kobold = rows(fighter('kobold thief', 30, [bite(1, 8, 15)]), [10]);

  function fightIn(occupants: RoomOccupant[], config = combat()): AutoCombat {
    const auto = make(config);
    auto.onCharacter(state({ room: { ...EMPTY_CHARACTER.room, occupants } }));
    drain();
    return auto;
  }

  /* `AttackCommand.cs`: the guard moves to protect, and the blow is its. */
  it('goes for the guard before what it protects, whatever the weighing says', () => {
    fightIn([kobold, shaman([10])]);
    expect(sent).toEqual(['a kobold thief']);
    expect(decisions.find((decision) => decision.acted)?.because).toBe(
      'kobold thief protects wererat shaman, so it goes first'
    );
  });

  it('weighs the room as before where nothing protects anything', () => {
    fightIn([kobold, shaman([])]);
    expect(sent).toEqual(['a wererat shaman']);
  });

  it('puts the guard ahead of the priority list too, since the server does', () => {
    fightIn(
      [kobold, shaman([10])],
      combat({ mobRules: [{ mob: 'wererat shaman', treat: 'first' }] })
    );
    expect(sent).toEqual(['a kobold thief']);
  });

  /* Attacking the shaman turns the kobold on the character anyway. */
  it('brings in a guard that would not start a fight when what it protects is attacked', () => {
    fightIn([passive(kobold), shaman([10])]);
    expect(sent).toEqual(['a kobold thief']);
    expect(decisions.find((decision) => decision.acted)?.because).toBe(
      'kobold thief protects wererat shaman, so attacking wererat shaman brings it in; it goes first'
    );
  });

  it('leaves a guard that would not start a fight when nothing it protects is attacked', () => {
    fightIn([passive(kobold), passive(shaman([10]))]);
    expect(sent).toEqual([]);
  });

  /* Only some of the kobold's rows protect: the server decides, rather than
     this client opening on a monster that may have left it alone. */
  it('does not bring in a guard the realm is only sure of for some of its rows', () => {
    fightIn([passive(rows(kobold, [10, 11])), shaman([10])]);
    expect(sent).toEqual(['a wererat shaman']);
  });

  // Listed first, so its reason is the one reported.
  it('declines what a refused guard protects, with the guard’s reason', () => {
    fightIn(
      [shaman([10]), kobold],
      combat({ mobRules: [{ mob: 'kobold thief', treat: 'never' }] })
    );
    expect(sent).toEqual([]);
    expect(refusals()).toContain(
      'wererat shaman — kobold thief protects wererat shaman and is refused itself: kobold thief is set to never attack'
    );
  });

  it('hits back at the guard first when both are swinging', () => {
    const auto = make(combat({ engage: 'none' }));
    auto.onCharacter(
      state({
        inCombat: true,
        room: { ...EMPTY_CHARACTER.room, occupants: [kobold, shaman([10])] },
        combat: {
          ...EMPTY_CHARACTER.combat,
          engaged: true,
          attackers: ['wererat shaman', 'kobold thief']
        }
      })
    );
    drain();
    expect(sent).toEqual(['a kobold thief']);
  });

  /* A hostile ward swings first; its guard has not landed a blow yet. */
  it('hits back at a guard standing here that has not swung yet', () => {
    // Hitting back is traced by the reason the command carries.
    const said: string[] = [];
    queue.dispose();
    queue = new CommandQueue(automation, {
      send: (command, intent) => {
        sent.push(command);
        said.push(intent.reason ?? '');
      }
    });
    const auto = make(combat({ engage: 'none' }));
    auto.onCharacter(
      state({
        inCombat: true,
        room: { ...EMPTY_CHARACTER.room, occupants: [shaman([10]), passive(kobold)] },
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, attackers: ['wererat shaman'] }
      })
    );
    drain();
    expect(sent).toEqual(['a kobold thief']);
    expect(said).toEqual([
      'auto-combat: hitting back: kobold thief protects wererat shaman, so it goes first'
    ]);
  });

  it('does not hit back through a guard set to never attack', () => {
    const auto = make(
      combat({ engage: 'none', mobRules: [{ mob: 'kobold thief', treat: 'never' }] })
    );
    auto.onCharacter(
      state({
        inCombat: true,
        room: { ...EMPTY_CHARACTER.room, occupants: [shaman([10]), kobold] },
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, attackers: ['wererat shaman'] }
      })
    );
    drain();
    expect(sent).toEqual([]);
  });

  /* `orc warlord` ← `orc captain` ← `orc lieutenant`, the lieutenant left
     alone: the captain cannot be fought, so neither can what it protects. */
  it('declines the whole chain behind a refused guard', () => {
    fightIn(
      [
        rows(fighter('orc warlord', 300, [bite(10, 20)]), [724], [725]),
        rows(fighter('orc captain', 200, [bite(8, 16)]), [725], [727]),
        rows(fighter('orc lieutenant', 150, [bite(6, 12)]), [727])
      ],
      combat({ mobRules: [{ mob: 'orc lieutenant', treat: 'never' }] })
    );
    expect(sent).toEqual([]);
  });
});

/*
 * Todo 818: MegaMUD's relationships as rows of `combat.mobRules` beside the
 * bands — friend, escape, hang up — and its *Not Hostile* on a banded row.
 * Each refusal has its control: the same room with no row.
 */
describe('a row that says what a monster is', () => {
  const room = (...occupants: RoomOccupant[]) => ({ ...EMPTY_CHARACTER.room, occupants });
  const rows = (...mobRules: CombatConfig['mobRules']) => combat({ mobRules });
  const swungAtBy = (name: string, ...occupants: RoomOccupant[]) =>
    state({
      room: room(...occupants),
      inCombat: true,
      combat: { ...EMPTY_CHARACTER.combat, engaged: true, attackers: [name] }
    });

  it('opens on a monster no row names (the control)', () => {
    const auto = make(combat());
    auto.onCharacter(state({ room: room(mob('giant rat', 'hostile')) }));
    drain();
    expect(sent).toEqual(['a giant rat']);
  });

  it('never opens on a friend, and says why', () => {
    const auto = make(rows({ mob: 'giant rat', treat: 'friend' }));
    auto.onCharacter(state({ room: room(mob('giant rat', 'hostile')) }));
    drain();
    expect(sent).toEqual([]);
    expect(refusals()).toEqual(['giant rat — giant rat is a friend, by its row']);
  });

  it('does not hit a friend back, and does hit back one it would escape', () => {
    const friendly = make(rows({ mob: 'giant rat', treat: 'friend' }));
    friendly.onCharacter(swungAtBy('giant rat', mob('giant rat', 'hostile')));
    drain();
    expect(sent).toEqual([]);

    const dreaded = make(rows({ mob: 'black ooze', treat: 'escape' }));
    dreaded.onCharacter(swungAtBy('black ooze', mob('black ooze', 'hostile')));
    drain();
    expect(sent).toEqual(['a black ooze']);
  });

  /* MegaMUD's Flee: *any other monsters are ignored* while it stands here. */
  it('opens nothing beside a monster whose row says to escape or hang up', () => {
    const fled = make(rows({ mob: 'black ooze', treat: 'escape' }));
    fled.onCharacter(
      state({ room: room(mob('giant rat', 'hostile'), mob('black ooze', 'hostile')) })
    );
    const hung = make(rows({ mob: 'stalker', treat: 'hangup' }));
    hung.onCharacter(state({ room: room(mob('giant rat', 'hostile'), mob('stalker', 'hostile')) }));
    drain();
    expect(sent).toEqual([]);
    expect(refusals()).toEqual([
      'giant rat — black ooze is here and its row says to escape, so no fight is opened beside it',
      'giant rat — stalker is here and its row says to hang up, so no fight is opened beside it'
    ]);
  });

  /* MegaMUD's Not Hostile: opened on only by *Attack Non-Hostiles*, `engage: all`. */
  it('does not open on a monster its row says does not attack first, and says both words', () => {
    const auto = make(rows({ mob: 'thug', treat: 'default', notHostile: true }));
    auto.onCharacter(state({ room: room(mob('thug', 'hostile')) }));
    drain();
    expect(sent).toEqual([]);
    expect(refusals()).toEqual([
      'thug — the row for thug says it does not attack first, though the realm says it does, and engage is not all'
    ]);
  });

  it('opens on it at engage all', () => {
    const auto = make(
      combat({ engage: 'all', mobRules: [{ mob: 'thug', treat: 'default', notHostile: true }] })
    );
    auto.onCharacter(state({ room: room(mob('thug', 'hostile')) }));
    drain();
    expect(sent).toEqual(['a thug']);
  });

  /* A joiner is one certain to attack on sight: the row says this one will not. */
  it('does not bring in a monster its row says does not attack first when hitting back', () => {
    const ogre = fighter('orc warrior', 60, [bite(20, 60, 90)]);
    const rat = fighter('giant rat', 20, [bite(1, 3, 20)]);
    const bitten = () =>
      state({
        inCombat: true,
        room: room(ogre, rat),
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, attackers: ['giant rat'] }
      });
    make(combat({ engage: 'hostile' })).onCharacter(bitten());
    make(rows({ mob: 'orc warrior', treat: 'default', notHostile: true })).onCharacter(bitten());
    drain();
    expect(sent).toEqual(['a orc warrior', 'a giant rat']);
  });

  /* Hitting back is not opening, and bringing in what has not swung is (818, on review). */
  it('brings nothing in beside a monster it would escape', () => {
    const ogre = fighter('orc warrior', 60, [bite(20, 60, 90)]);
    const ooze = fighter('black ooze', 20, [bite(1, 3, 20)]);
    const bitten = () =>
      state({
        inCombat: true,
        room: room(ogre, ooze),
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, attackers: ['black ooze'] }
      });
    make(combat({ engage: 'hostile' })).onCharacter(bitten());
    make(rows({ mob: 'black ooze', treat: 'escape' })).onCharacter(bitten());
    drain();
    expect(sent).toEqual(['a orc warrior', 'a black ooze']);
  });
});

/*
 * 816's review, taken in 818: the backstab trace names the row only when the
 * row was the hold, not a spent or a refused opener.
 */
describe('why a backstab did not open', () => {
  const noBackstab = [{ mob: 'giant rat', treat: 'default' as const, noBackstab: true }];
  const rat = () =>
    state({ room: { ...EMPTY_CHARACTER.room, occupants: [mob('giant rat', 'hostile')] } });
  let said: string[];
  const reasons = () => said;
  beforeEach(() => {
    said = [];
    queue.dispose();
    queue = new CommandQueue(automation, {
      send: (command, intent) => {
        sent.push(command);
        said.push(intent.reason ?? '');
      }
    });
  });

  it('says the row withheld it, where it did', () => {
    const auto = make(combat({ opener: 'bs', mobRules: noBackstab }));
    auto.onCharacter(rat());
    expect(reasons().some((reason) => reason.includes('no backstab, as the row'))).toBe(true);
  });

  it('does not blame the row for a backstab the realm refused', () => {
    const auto = make(combat({ opener: 'bs', mobRules: noBackstab }));
    auto.onBlock(block('attack-refused', { skill: 'backstab' }));
    auto.onCharacter(rat());
    expect(reasons()).toHaveLength(1);
    expect(reasons().some((reason) => reason.includes('no backstab, as the row'))).toBe(false);
  });
});

/*
 * 816's review, taken in 818: a combat spell's Off and its Engaged can have a
 * guard's `moves to protect`, a prompt or any broadcast between them
 * (`Player.cs:6083-6188`); only the cast's own result, or the server moving on
 * to another command, says the fight broke.
 */
describe('what follows a cast’s Off', () => {
  const book = [
    { name: 'hold person', short: 'hold', level: 1, cost: 1 },
    { name: 'harm', short: 'harm', level: 1, cost: 1 }
  ];
  const kobold = { ...EMPTY_CHARACTER.room, occupants: [mob('tall kobold thief', 'hostile')] };
  const standing = () => state({ room: kobold, spellbook: book });
  const opened = (auto: AutoCombat) => {
    auto.onCharacter(standing());
    drain();
    auto.onCharacter(
      state({
        room: kobold,
        spellbook: book,
        inCombat: true,
        combat: { ...EMPTY_CHARACTER.combat, engaged: true, target: 'tall kobold thief' }
      })
    );
  };
  const broadcast = () =>
    ({ ...block('player-arrives'), domain: 'room', text: 'Rend walks into the room.' }) as Block;

  it('keeps the fight through a broadcast before the engagement', () => {
    const auto = make(combat({ refreshRounds: 0 }));
    opened(auto);
    auto.onBlock(block('combat-status', { status: 'Off' }), 'harm tall kobold thief');
    auto.onBlock(broadcast(), null);
    auto.onBlock(block('combat-status', { status: 'Engaged' }), null);
    auto.onCharacter(standing());
    drain();
    expect(sent).toEqual(['a tall kobold thief']);
  });

  it('reads the fight as broken when the server answers the next command with none', () => {
    const auto = make(combat({ refreshRounds: 0 }));
    opened(auto);
    auto.onBlock(block('combat-status', { status: 'Off' }), 'hold tall kobold thief');
    auto.onBlock(broadcast(), null);
    auto.onBlock(block('unknown'), 'l');
    auto.onCharacter(standing());
    drain();
    expect(sent).toEqual(['a tall kobold thief', 'a tall kobold thief']);
  });
});
