import { describe, expect, it } from 'vitest';

import {
  judgeRemote,
  formatEncumbrance,
  formatExp,
  formatHave,
  formatLevel,
  formatLives,
  formatSettings,
  formatStatus,
  formatVersion,
  formatWealth,
  formatWhat,
  formatWhere,
  formatWho,
  withCommas,
  REMOTES,
  REMOTE_NAMES,
  formatVitals,
  parseRemoteCall,
  parseRemoteReply
} from '../remotes';

describe('the `@` command vocabulary', () => {
  /*
   * A closed union with its runtime table beside it, in the shape this codebase
   * keeps them. A name in one and not the other is a command the parser accepts
   * and the responder has nothing to say about.
   */
  it('has a row for every name, and no row for a name it does not have', () => {
    expect(Object.keys(REMOTES).sort()).toEqual([...REMOTE_NAMES].sort());
    for (const name of REMOTE_NAMES) expect(REMOTES[name].name).toBe(name);
  });

  /*
   * Every command that is not round-tripped has to say why, in its own row —
   * an unread one in writing, a refused one by naming which standing refusal
   * answers it (the sentence itself is UI copy in locales/ui.en.yaml, under
   * automation.peers.refusal.<id>, kept alive by i18n-coverage.test.ts).
   */
  it('gives a reason for everything it will not answer', () => {
    for (const spec of Object.values(REMOTES)) {
      if (spec.support === 'unread') expect(spec.because.length, spec.name).toBeGreaterThan(10);
      if (spec.support === 'refused') {
        expect(['kill', 'hangup', 'relog', 'panic'], spec.name).toContain(spec.refusal);
      }
    }
  });
});

describe('reading a command out of a chat message', () => {
  it('reads the ones the captures show', () => {
    expect(parseRemoteCall('@health')).toEqual({ name: 'health', argument: null, raw: 'health' });
    expect(parseRemoteCall('@do a ooze')).toEqual({
      name: 'do',
      argument: 'a ooze',
      raw: 'do'
    });
    expect(parseRemoteCall('@party go rift')?.argument).toBe('go rift');
    expect(parseRemoteCall('@get-all')?.name).toBe('get-all');
    expect(parseRemoteCall('@kill Gambit')?.argument).toBe('Gambit');
    expect(parseRemoteCall('@panic!')?.name).toBe('panic!');
  });

  /*
   * captures/074: MegaMUD annotates its own `@wait`. The annotation is not part
   * of the vocabulary — a realm's version may word it differently — so it is
   * kept as the argument rather than matched.
   */
  it('keeps MegaMUD’s own annotation as the argument rather than matching it', () => {
    expect(parseRemoteCall("@wait (can't move)")).toEqual({
      name: 'wait',
      argument: "(can't move)",
      raw: 'wait'
    });
  });

  /*
   * Anchored at the start, which is what keeps a client from being driven by a
   * sentence somebody wrote *about* it. `Stiffy gossips: wow ... @health` is a
   * real line from the corpus.
   */
  it('is not driven by somebody talking about a command', () => {
    expect(parseRemoteCall('wow a mud player, ill bet you get @health')).toBeNull();
    expect(parseRemoteCall('@nonsense')).toBeNull();
    expect(parseRemoteCall('health')).toBeNull();
  });
});

describe('reading another client’s reply', () => {
  /* captures/055 and captures/123, exactly as they appear. */
  it('reads both captured shapes', () => {
    expect(parseRemoteReply('{HP=600/600}')).toEqual({
      kind: 'vitals',
      hp: 600,
      hpMax: 600,
      mana: null,
      manaMax: null
    });
    expect(parseRemoteReply('{HP=4434/4434,MA=516/516}')).toEqual({
      kind: 'vitals',
      hp: 4434,
      hpMax: 4434,
      mana: 516,
      manaMax: 516
    });
    expect(parseRemoteReply('{ok}')).toEqual({ kind: 'ok' });
  });

  /* The mana field is optional for the same reason it is in the status line. */
  it('reads a kai class’s spelling of the mana field', () => {
    expect(parseRemoteReply('{HP=62/62,KAI=4/10}')).toEqual({
      kind: 'vitals',
      hp: 62,
      hpMax: 62,
      mana: 4,
      manaMax: 10
    });
  });

  it('reads nothing out of ordinary chat', () => {
    expect(parseRemoteReply('hello')).toBeNull();
    expect(parseRemoteReply('{HP=600}')).toBeNull();
  });
});

describe('answering with this character’s own numbers', () => {
  it('states the pair the captures show', () => {
    expect(formatVitals(600, 600, null, null)).toBe('{HP=600/600}');
    expect(formatVitals(4434, 4434, 516, 516)).toBe('{HP=4434/4434,MA=516/516}');
  });

  /*
   * Null rather than a lie. `{HP=62/0}` reads as full health on somebody else's
   * screen, and `{HP=62}` is a shape no capture shows and no other client
   * parses.
   */
  it('says nothing at all when no maximum has arrived', () => {
    expect(formatVitals(62, null, null, null)).toBeNull();
    expect(formatVitals(null, 100, null, null)).toBeNull();
  });

  /* And leaves the mana half out rather than sending a zero for a warrior. */
  it('leaves out a mana half the character does not have', () => {
    expect(formatVitals(62, 62, null, null)).toBe('{HP=62/62}');
  });

  it('round-trips its own answer', () => {
    expect(parseRemoteReply(formatVitals(62, 62, 4, 10)!)).toEqual({
      kind: 'vitals',
      hp: 62,
      hpMax: 62,
      mana: 4,
      manaMax: 10
    });
  });
});

describe('the gang grant, once the roster can answer it', () => {
  const gang = { gang: ['health' as const], party: [], players: {} };
  it('allows on a shared gang', () => {
    expect(judgeRemote('spike', 'health', gang, { inGang: true, inParty: false })).toEqual({
      allowed: true,
      because: 'gang'
    });
  });
  it('refuses a different gang without calling it unresolved', () => {
    expect(judgeRemote('spike', 'health', gang, { inGang: false, inParty: false })).toEqual({
      allowed: false,
      because: 'not-granted',
      gangUnresolved: false,
      notInParty: false
    });
  });
});

/*
 * Every shape below is what MegaMUD 2.1 answered on the live realm
 * (`npm run probe:megamud -- --to Rand`, 2026-08-29, captures/215). Where a
 * shape is not captured the formatter returns null, and that is asserted too.
 */
describe('answering the questions the way MegaMUD does', () => {
  const HOUR = 3_600_000;

  it('prints a thousands separator the way Needed: 2,150 does', () => {
    expect(withCommas(2150)).toBe('2,150');
    expect(withCommas(0)).toBe('0');
    expect(withCommas(1_234_567)).toBe('1,234,567');
  });

  it('answers @exp in the captured frame, with ? where nothing can be computed', () => {
    expect(formatExp(0, 2150, 1_000, 1_000 + HOUR)).toBe(
      '{Made: 0  Needed: 2,150  Rate: ? k/hr  Will level in: ?}'
    );
  });

  /* The zero a fresh session starts with is "nothing counted", not "nothing made". */
  it('has no @exp answer before the session has begun', () => {
    expect(formatExp(0, 2150, null, HOUR)).toBeNull();
  });

  it('shares the rate floor with the Vitals card, and prints ? for a rate that rounds to nothing', () => {
    // Ninety seconds in: the card shows no rate yet, and neither does this.
    expect(formatExp(300, 2150, 0, 90_000)).toMatch(/Rate: \? k\/hr  Will level in: \?}$/);
    // Twenty points in an hour would print 0.0 k/hr beside a 107-hour wait.
    expect(formatExp(20, 2150, 0, HOUR)).toMatch(/Rate: \? k\/hr  Will level in: \?}$/);
  });

  it('computes the rate and the wait once experience has been made', () => {
    // 3,000 in two hours: 1.5 k/hr; 4,500 more needed is three hours.
    expect(formatExp(3000, 4500, 0, 2 * HOUR)).toBe(
      '{Made: 3,000  Needed: 4,500  Rate: 1.5 k/hr  Will level in: 3h 0m}'
    );
  });

  it('answers @level, and has no level to answer with before a sheet', () => {
    expect(formatLevel(1, 2150, 0, null, 0)).toBe('{Level: 1  Needed: 2,150  Will level in: ?}');
    expect(formatLevel(null, 2150, 0, null, 0)).toBeNull();
  });

  it('answers @lives, @wealth and @enc as captured, and null before the fact is known', () => {
    expect(formatLives(9)).toBe('{9 lives remaining}');
    expect(formatLives(null)).toBeNull();
    expect(formatWealth(0)).toBe('{0 copper}');
    expect(formatWealth(null)).toBeNull();
    expect(formatEncumbrance(0, 2400, 'None')).toBe('{0/2400 - None}');
    expect(formatEncumbrance(0, null, 'None')).toBeNull();
  });

  it('answers @where with the exits upper-cased and comma-joined', () => {
    expect(formatWhere('Newhaven, Village Entrance', ['n', 's', 'w', 'se'])).toBe(
      '{Newhaven, Village Entrance (Exits: N,S,W,SE)}'
    );
    expect(formatWhere(null, [])).toBeNull();
  });

  /* captures/215 and 218: a listed floor, and a bare one. */
  it('answers @who and @what as captured, the empty floor included', () => {
    expect(formatWho([])).toBe('{No one}');
    expect(formatWhat(['newbie manual', 'large sign'])).toBe('{newbie manual,large sign}');
    expect(formatWhat([])).toBe('{Nothing}');
  });

  /* captures/215 and 217: six {no}s, then {yes: 1} for one ring; a second copy
     has never been answered on the wire, so it is refused rather than counted. */
  it('answers @have no and yes for one, and refuses to invent a plural', () => {
    expect(formatHave(0)).toBe('{no}');
    expect(formatHave(1)).toBe('{yes: 1}');
    expect(formatHave(2)).toBeNull();
  });

  it('answers @version in the shape of {MegaMMUD 2.1}', () => {
    expect(formatVersion('mudengine', '0.5.0')).toBe('{mudengine 0.5.0}');
  });
});

describe("answering @settings and @status in MegaMUD's frame with this client's words", () => {
  it('splits the switches over two telepaths, ON then OFF', () => {
    expect(formatSettings(['Combat', 'Loot'], ['Retreat'])).toEqual([
      '{ON: Combat,Loot}',
      '{OFF: Retreat}'
    ]);
  });

  it('says none for an empty half rather than an empty frame', () => {
    expect(formatSettings([], ['Combat'])).toEqual(['{ON: none}', '{OFF: Combat}']);
  });

  it('names the mode, what it is doing, and the three states of stealth', () => {
    expect(formatStatus('idle', 'waiting for instructions', 'seen')).toBe(
      '{IDLE: waiting for instructions}'
    );
    expect(formatStatus('walk', 'Newhaven, Bank (3/7)', 'sneaking')).toBe(
      '{WALK: Newhaven, Bank (3/7) -Sneaking}'
    );
    /* Unknown is not "not sneaking". */
    expect(formatStatus('loop', 'Rats stop 2/4 lap 1', 'unknown')).toBe(
      '{LOOP: Rats stop 2/4 lap 1 -Stealth?}'
    );
  });
});
