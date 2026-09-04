import { describe, expect, it } from 'vitest';

import { asProfileDraft, asProfileId, asServerDraft } from '../drafts';
import { UNCATEGORISED } from '../loops';

/*
 * These are the payloads that become files on disk holding credentials, and a
 * malformed one is a character dialling somewhere nobody chose. Parsed, not
 * checked: a caller cannot carry on with something that merely looked right.
 */
describe('a name a character can be filed under', () => {
  it('takes an ordinary one', () => {
    expect(asProfileId('vaelor')).toBe('vaelor');
    expect(asProfileId('my-alt_2')).toBe('my-alt_2');
  });

  it('lower-cases it, because the id is a filename and a lookup key', () => {
    expect(asProfileId('Vaelor')).toBe('vaelor');
  });

  /*
   * Refused outright rather than sanitised. A sanitised path is one nobody can
   * predict, and the id is also the session id, the log name and the key every
   * remembered UI preference hangs off.
   */
  it('refuses anything that could climb out of the profiles directory', () => {
    expect(asProfileId('../../etc/passwd')).toBeNull();
    expect(asProfileId('a/b')).toBeNull();
    expect(asProfileId('..')).toBeNull();
    expect(asProfileId('a\\b')).toBeNull();
    expect(asProfileId('.hidden')).toBeNull();
  });

  it('refuses an empty one and an absurd one', () => {
    expect(asProfileId('')).toBeNull();
    expect(asProfileId('   ')).toBeNull();
    expect(asProfileId('x'.repeat(49))).toBeNull();
    expect(asProfileId(null)).toBeNull();
    expect(asProfileId(42)).toBeNull();
  });
});

describe('a saved server', () => {
  const good = { name: 'Home', host: 'gmud-tgs', port: 2427, encoding: 'cp437' };

  it('takes a well-formed one', () => {
    // A server with no menus at all is every MUD reached directly rather than
    // through a BBS front end, so an absent script is an empty one.
    // And no loops: those are files under `servers/<id>/loops`, so a payload
    // that mentions none means this server lends its characters none.
    // An absent database is the world the client ships.
    expect(asServerDraft(good)).toEqual({ ...good, login: [], loops: [], database: '' });
  });

  /*
   * The map every character on this realm walks — on the realm, because two of
   * them cannot be walking two different maps. It used to be stated per
   * character, which was the same answer written out once each.
   */
  it('takes the realm database, and bounds it', () => {
    expect(asServerDraft({ ...good, database: '/realms/paradigm.mdb' })?.database).toBe(
      '/realms/paradigm.mdb'
    );
    expect(asServerDraft({ ...good, database: 'x'.repeat(600) })?.database).toHaveLength(400);
    expect(asServerDraft({ ...good, database: 42 })?.database).toBe('');
  });

  it('takes the menu script a BBS needs, and keeps a bare Enter', () => {
    const draft = asServerDraft({
      ...good,
      login: [
        { when: 'S : Shift', send: 's' },
        { when: 'Press ENTER', send: '' },
        // A row the `+` button just made and nobody has filled in yet. Dropped
        // rather than refusing the save, which would make the button hostile.
        { when: '', send: 'x' }
      ]
    });
    expect(draft?.login).toEqual([
      { when: 'S : Shift', send: 's' },
      { when: 'Press ENTER', send: '' }
    ]);
  });

  it('takes a port typed into a text field', () => {
    expect(asServerDraft({ ...good, port: '2427' })?.port).toBe(2427);
  });

  /*
   * Refused rather than coerced: a port outside the range is a typo, and
   * dialling it burns the whole fifteen-second connect deadline before saying
   * anything useful.
   */
  it('refuses a port that is not one', () => {
    for (const port of [0, -1, 65536, 1.5, 'abc', null, undefined]) {
      expect(asServerDraft({ ...good, port })).toBeNull();
    }
  });

  it('refuses an encoding the client cannot decode', () => {
    expect(asServerDraft({ ...good, encoding: 'utf16' })).toBeNull();
  });

  it('refuses one with nowhere to connect', () => {
    expect(asServerDraft({ ...good, host: '' })).toBeNull();
    expect(asServerDraft({ ...good, name: '  ' })).toBeNull();
    expect(asServerDraft(null)).toBeNull();
    expect(asServerDraft([good])).toBeNull();
  });
});

describe('a character', () => {
  const good = {
    name: 'Vaelor',
    server: { kind: 'saved', name: 'Home' },
    username: 'someone',
    password: 'secret',
    changePassword: true,
    autoConnect: true,
    accent: 'violet',
    login: [{ when: 'Please select a character', send: '1' }]
  };

  it('keys blessings on spell and target, drops duplicates, and gives only party rows a clock', () => {
    const draft = asProfileDraft({
      ...good,
      spells: {
        blessings: [
          { spell: 'protection', fallbackSeconds: 600 },
          // Same spell, same target: dropped. Same spell, other target: kept —
          // self and party recast on different mechanisms.
          { spell: 'Protection' },
          { spell: 'Protection', target: 'party' },
          { spell: '', target: 'party' },
          { spell: 'bless', target: 'party' }
        ]
      }
    });
    expect(draft?.spells.blessings).toEqual([
      {
        spell: 'protection',
        target: 'self',
        minMana: 0,
        prioritizeOverHeal: false,
        inCombat: true
      },
      {
        spell: 'Protection',
        target: 'party',
        minMana: 0,
        prioritizeOverHeal: false,
        inCombat: false,
        fallbackSeconds: 300
      },
      {
        spell: 'bless',
        target: 'party',
        minMana: 0,
        prioritizeOverHeal: false,
        inCombat: false,
        fallbackSeconds: 300
      }
    ]);
  });

  it('takes a well-formed one', () => {
    const draft = asProfileDraft(good);
    expect(draft).not.toBeNull();
    expect(draft?.server).toEqual({ kind: 'saved', name: 'Home' });
    expect(draft?.accent).toBe('violet');
    expect(draft?.login).toEqual([{ when: 'Please select a character', send: '1' }]);
  });

  it('takes an address spelled out inline', () => {
    const draft = asProfileDraft({
      ...good,
      server: { kind: 'inline', host: 'gmud-tgs', port: 2427, encoding: 'cp437' }
    });
    expect(draft?.server).toEqual({
      kind: 'inline',
      host: 'gmud-tgs',
      port: 2427,
      encoding: 'cp437'
    });
  });

  /*
   * Rule 2 of `profiles.ts`: a profile that cannot name a server is not a
   * profile, because a defaulted one is a tab that silently dials somewhere the
   * player never chose.
   */
  it('refuses one with nowhere to play', () => {
    expect(asProfileDraft({ ...good, server: undefined })).toBeNull();
    expect(asProfileDraft({ ...good, server: { kind: 'saved', name: '' } })).toBeNull();
    expect(asProfileDraft({ ...good, server: { kind: 'inline', host: 'x' } })).toBeNull();
    expect(asProfileDraft({ ...good, server: 'Home' })).toBeNull();
  });

  /* Blank means "I did not touch this", and the flag is what says otherwise. */
  it('does not treat a blank password as a change unless it is told to', () => {
    expect(asProfileDraft({ ...good, changePassword: undefined })?.changePassword).toBe(false);
    expect(asProfileDraft({ ...good, changePassword: 'yes' })?.changePassword).toBe(false);
  });

  /* A password is the user's, and truncating one silently is how an account
     becomes unreachable from the client that did it. */
  it('passes a password through exactly as typed', () => {
    const password = '  spaces and $ymbols\t ';
    expect(asProfileDraft({ ...good, password })?.password).toBe(password);
  });

  it('falls back to a real accent rather than passing an invented one through', () => {
    expect(asProfileDraft({ ...good, accent: 'danger' })?.accent).toBe('cyan');
    expect(asProfileDraft({ ...good, accent: 42 })?.accent).toBe('cyan');
  });

  it('treats a missing login block as "use the server’s" rather than failing', () => {
    const draft = asProfileDraft({ ...good, login: undefined });
    expect(draft?.login).toEqual([]);
  });

  it('refuses anything that is not a mapping', () => {
    expect(asProfileDraft(null)).toBeNull();
    expect(asProfileDraft('vaelor')).toBeNull();
    expect(asProfileDraft([good])).toBeNull();
  });

  /*
   * The three blocks MegaMUD names in its own tabs, and the boundary they cross.
   *
   * Every threshold is a fraction and every one is clamped here as well as in
   * `normalizeConfig`: this is the payload a *window* sends, and a payload that
   * reached the network is parsed rather than checked.
   */
  describe('health, movement and spells', () => {
    it('takes them, as fractions', () => {
      const draft = asProfileDraft({
        ...good,
        health: { restBelow: 0.5, meditateBelow: 0.25 },
        movement: { openDoors: true, openTries: 2, sneak: true },
        spells: { attack: 'ice blade', minMana: 0.2 }
      });
      expect(draft?.health).toEqual({
        restBelow: 0.5,
        // The shipped ceiling, not 0: an omitted key falls back rather than
        // turning off the loop's health hold, which this pair now carries.
        restTo: 0.7,
        meditateBelow: 0.25,
        drinkHealingPotionBelow: 0,
        drinkManaPotionBelow: 0,
        potionVerb: 'drink',
        healingPotionName: '',
        manaPotionName: ''
      });
      expect(draft?.movement).toEqual({
        openDoors: true,
        openTries: 2,
        pickLocks: false,
        pickTries: 0,
        bashDoors: false,
        bashTries: 0,
        sneak: true,
        // A draft states what the form showed; absent is off, and the
        // template's `true` for the light is the file's, not the payload's.
        provideLight: false,
        lightDimRooms: false,
        extinguishInLight: false
      });
      // The whole spell name: the realm matches a spell on a prefix, so `ice`
      // would cast whatever begins with it.
      expect(draft?.spells).toEqual({
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
        minMana: 0.2,
        cures: { blindness: '', poison: '', disease: '' },
        blessings: [],
        notifyPartyOnWearOff: false
      });
    });

    it('clamps a fraction somebody typed as a percentage', () => {
      const draft = asProfileDraft({ ...good, health: { restBelow: 50 } });
      expect(draft?.health.restBelow).toBe(1);
    });

    it('falls back rather than refusing the save when a block is nonsense', () => {
      const draft = asProfileDraft({ ...good, health: 'half', movement: 7, spells: null });
      expect(draft?.health).toEqual({
        // The shipped pair, for the reason the fraction case above states: a
        // nonsense block must not silently set a lap marching at any health.
        restBelow: 0.35,
        restTo: 0.7,
        meditateBelow: 0,
        drinkHealingPotionBelow: 0,
        drinkManaPotionBelow: 0,
        potionVerb: 'drink',
        healingPotionName: '',
        manaPotionName: ''
      });
      expect(draft?.movement).toEqual({
        openDoors: false,
        openTries: 0,
        pickLocks: false,
        pickTries: 0,
        bashDoors: false,
        bashTries: 0,
        sneak: false,
        provideLight: false,
        lightDimRooms: false,
        extinguishInLight: false
      });
      expect(draft?.spells).toEqual({
        attack: '',
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
    });

    /* A door that did not open on the third try is locked. */
    it('caps the door tries', () => {
      expect(asProfileDraft({ ...good, movement: { openTries: 99 } })?.movement.openTries).toBe(3);
    });

    /*
     * Forcing is capped higher, and deliberately: `open` is an answer that
     * repeats, and a pick or a bash is a roll. `captures/002` shows three
     * picks before the lock gave.
     */
    it('caps the forcing tries higher than the opening ones', () => {
      const draft = asProfileDraft({ ...good, movement: { pickTries: 99, bashTries: 99 } });
      expect(draft?.movement.pickTries).toBe(10);
      expect(draft?.movement.bashTries).toBe(10);
    });
  });

  /*
   * Auto-combat, which is the one part of a draft that turns into the client
   * *doing* something unasked — so every field of it is coerced towards doing
   * less rather than refusing the whole save, which would lose the rest of the
   * form over a mistyped number.
   */
  /*
   * A loop chosen on the settings screen. Read by the same parser the
   * options file goes through, so a loop picked off the shelf and a loop typed
   * into YAML cannot mean different things — and bounded, because this one
   * crossed the wire.
   */
  describe('the loops it walks', () => {
    it('takes them, in the shape the options file uses', () => {
      const draft = asProfileDraft({
        ...good,
        loops: [{ name: 'Sewer loop', stops: ['Sewer Tunnel 1/606', 'Sewer Tunnel 1/604'] }]
      });
      expect(draft?.loops).toEqual([
        {
          name: 'Sewer loop',
          stops: [{ room: 'Sewer Tunnel 1/606' }, { room: 'Sewer Tunnel 1/604' }],
          /* Derived at parse time, so every loop has a group to sit under.
             `Sewer loop` states no area, which is the commonest shape for a
             loop somebody wrote by hand. */
          category: UNCATEGORISED
        }
      ]);
    });

    /* A character that walks none is a legitimate state, and an empty list is
       how the form says so — never a reason to refuse the whole save. */
    it('treats a missing block as walking none', () => {
      expect(asProfileDraft(good)?.loops).toEqual([]);
      expect(asProfileDraft({ ...good, loops: 'the sewers' })?.loops).toEqual([]);
    });

    it('drops a loop that is not one rather than refusing the save', () => {
      const draft = asProfileDraft({
        ...good,
        loops: [
          { name: '', stops: ['A', 'B'] },
          { name: 'one stop', stops: ['A'] },
          { name: 'real', stops: ['A', 'B'] }
        ]
      });
      expect(draft?.loops.map((loop) => loop.name)).toEqual(['real']);
    });

    /* The ceiling exists so a window bug cannot write an unbounded file, not to
       limit a loop: MegaMUD's longest of 420 is under forty stops. */
    it('bounds a list no person typed', () => {
      const many = Array.from({ length: 400 }, (_, at) => ({
        name: `loop ${at}`,
        stops: ['A', 'B']
      }));
      expect(asProfileDraft({ ...good, loops: many })?.loops.length).toBe(200);
    });
  });

  describe('what it fights with', () => {
    it('takes a well-formed combat block', () => {
      const draft = asProfileDraft({
        ...good,
        combat: {
          enabled: true,
          attack: 'a',
          opener: 'bs',
          engage: 'all',
          retaliate: false,
          maxMobs: 3,
          minHealth: 0.4,
          whileWalking: true,
          refreshRounds: 3,
          avoid: ['town guard'],
          prefer: ['wererat shaman']
        }
      });
      expect(draft?.combat).toEqual({
        enabled: true,
        attack: 'a',
        opener: 'bs',
        // Absent from the block above, so they take their defaults: all three
        // are refusals, and a refusal nobody asked for is off.
        avoidUndead: false,
        avoidDeathSpell: false,
        maxTargetHealth: 0,
        minMobs: 0,
        maxMonsterExperience: 0,
        engage: 'all',
        retaliate: false,
        maxMobs: 3,
        minHealth: 0.4,
        refreshRounds: 3,
        whileWalking: true,
        avoid: ['town guard'],
        prefer: ['wererat shaman']
      });
    });

    /* Off, with the one switch that cannot start a fight left on. */
    it('defaults a missing block to off, and to hitting back', () => {
      const draft = asProfileDraft({ ...good, combat: undefined });
      expect(draft?.combat.enabled).toBe(false);
      expect(draft?.combat.retaliate).toBe(true);
      expect(draft?.combat.engage).toBe('hostile');
      expect(draft?.combat.attack).toBe('a');
    });

    it('refuses an engage policy it has never heard of', () => {
      expect(asProfileDraft({ ...good, combat: { engage: 'players' } })?.combat.engage).toBe(
        'hostile'
      );
    });

    /*
     * A monster is called `giant rat`, so a name is one entry with a space in
     * it — splitting on whitespace would make it two that match nothing.
     */
    it('keeps a two-word monster name as one entry', () => {
      const draft = asProfileDraft({ ...good, combat: { avoid: ['giant rat', 'town guard'] } });
      expect(draft?.combat.avoid).toEqual(['giant rat', 'town guard']);
    });

    it('takes only the first word of a command verb', () => {
      const draft = asProfileDraft({ ...good, combat: { attack: 'a the rat' } });
      expect(draft?.combat.attack).toBe('a');
    });

    it('clamps rather than refusing the whole save', () => {
      const draft = asProfileDraft({
        ...good,
        combat: { maxMobs: 999, minHealth: 4, avoid: 'town guard' }
      });
      expect(draft?.combat.maxMobs).toBe(20);
      expect(draft?.combat.minHealth).toBe(1);
      // Not a list at all: nothing rather than a guess at what was meant.
      expect(draft?.combat.avoid).toEqual([]);
    });
  });
});

describe('a character theme', () => {
  it('reads a theme preference and treats anything else as following the file', () => {
    const base = { name: 'X', server: { kind: 'saved', name: 'S' }, username: 'x', password: '' };
    expect(asProfileDraft({ ...base, theme: 'nord' })?.theme).toBe('nord');
    expect(asProfileDraft({ ...base, theme: 'system' })?.theme).toBe('system');
    expect(asProfileDraft({ ...base, theme: 'neon' })?.theme).toBe('');
    expect(asProfileDraft(base)?.theme).toBe('');
  });
});
