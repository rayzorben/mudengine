import { describe, expect, it } from 'vitest';

import {
  asAutomationSwitch,
  automationSwitches,
  AUTOMATION_SWITCH_NAMES,
  AUTOMATION_SWITCHES,
  CP437_FALLBACK_FONT,
  DEFAULT_CONFIG,
  readAutomationSwitch,
  normalizeConfig,
  resolveTerminalFonts,
  resolveUiFonts,
  targetFromConfig,
  toCssFontStack,
  type AppConfig
} from '../config';

describe('toCssFontStack', () => {
  it('quotes families containing spaces and leaves generics bare', () => {
    expect(toCssFontStack(['LucidaProgrammer Nerd Font Mono', 'Consolas', 'monospace'])).toBe(
      "'LucidaProgrammer Nerd Font Mono', Consolas, monospace"
    );
  });

  it('escapes an apostrophe rather than closing the quote early', () => {
    expect(toCssFontStack(["O'Hara Mono"])).toBe("'O\\'Hara Mono'");
  });
});

describe('resolveTerminalFonts', () => {
  it('always terminates in the generic monospace keyword', () => {
    expect(resolveTerminalFonts(['Comic Sans MS']).at(-1)).toBe('monospace');
  });

  it('appends the bundled CP437 face for glyphs a modern font lacks', () => {
    expect(resolveTerminalFonts(['Consolas'])).toContain(CP437_FALLBACK_FONT);
  });

  it('keeps the user preference first', () => {
    expect(resolveTerminalFonts(['LucidaProgrammer Nerd Font Mono'])[0]).toBe(
      'LucidaProgrammer Nerd Font Mono'
    );
  });

  it('does not repeat a fallback the user already named', () => {
    const stack = resolveTerminalFonts(['Consolas', 'Menlo']);
    expect(stack.filter((family) => family === 'Consolas')).toHaveLength(1);
    expect(stack.filter((family) => family === 'Menlo')).toHaveLength(1);
  });

  it('matches case-insensitively when deduplicating', () => {
    expect(resolveTerminalFonts(['consolas']).filter((f) => /^consolas$/i.test(f))).toHaveLength(1);
  });

  it('does not demote a user who names the CP437 face first', () => {
    expect(resolveTerminalFonts([CP437_FALLBACK_FONT])[0]).toBe(CP437_FALLBACK_FONT);
  });
});

describe('resolveUiFonts', () => {
  it('also terminates in the generic monospace keyword', () => {
    expect(resolveUiFonts(['Inter']).at(-1)).toBe('monospace');
  });

  it('omits the CP437 bitmap face, which chrome never needs', () => {
    // An 8x16 bitmap standing in for a missing glyph at 13px reads as a bug.
    expect(resolveUiFonts(['Consolas'])).not.toContain(CP437_FALLBACK_FONT);
  });

  it('differs from the terminal stack, so the two are distinguishable', () => {
    expect(resolveUiFonts(['Consolas'])).not.toEqual(resolveTerminalFonts(['Consolas']));
  });
});

describe('normalizeConfig', () => {
  it('returns the defaults for an empty document', () => {
    // A file that is only comments parses to null. That is "all defaults", not
    // an error, and must not throw.
    expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it('survives a document of entirely the wrong shape', () => {
    expect(normalizeConfig('a string')).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig([1, 2, 3])).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig({ terminal: 'nope', ui: 42, connection: [] })).toEqual(DEFAULT_CONFIG);
  });

  it('accepts a single family as a bare string', () => {
    const config = normalizeConfig({ terminal: { font: { family: 'Consolas' } } });
    expect(config.terminal.font.family).toEqual(['Consolas']);
  });

  it('accepts a family list and drops blank entries', () => {
    const config = normalizeConfig({
      terminal: { font: { family: ['Consolas', '  ', '', 'Menlo'] } }
    });
    expect(config.terminal.font.family).toEqual(['Consolas', 'Menlo']);
  });

  it('falls back when a family list contains nothing usable', () => {
    const config = normalizeConfig({ terminal: { font: { family: [null, 7] } } });
    expect(config.terminal.font.family).toEqual(DEFAULT_CONFIG.terminal.font.family);
  });

  it('clamps out-of-range numbers instead of rejecting the file', () => {
    const config = normalizeConfig({
      connection: { port: 999_999 },
      terminal: { font: { size: 0 }, scrollback: -5 }
    });
    expect(config.connection.port).toBe(65535);
    expect(config.terminal.font.size).toBe(6);
    expect(config.terminal.scrollback).toBe(0);
  });

  it('coerces a port written as a quoted string', () => {
    expect(normalizeConfig({ connection: { port: '2427' } }).connection.port).toBe(2427);
  });

  it('rejects an unknown encoding rather than passing it to iconv', () => {
    expect(normalizeConfig({ connection: { encoding: 'ebcdic' } }).connection.encoding).toBe(
      'cp437'
    );
  });

  it('keeps a valid non-default encoding', () => {
    expect(normalizeConfig({ connection: { encoding: 'utf8' } }).connection.encoding).toBe('utf8');
  });

  it('keeps a well-formed server list', () => {
    const config = normalizeConfig({
      servers: [{ name: 'Home', host: 'example.test', port: 4000, encoding: 'utf8' }]
    });
    // Empty menus, not the shipped Paradigm script: a server states its own,
    // and a MUD reached directly rather than through a BBS has none at all.
    expect(config.servers).toEqual([
      { name: 'Home', host: 'example.test', port: 4000, encoding: 'utf8', login: [], database: '' }
    ]);
  });

  /*
   * The four keys the schema used to name — `selection`, `realm`, `character`,
   * `enterRealm` — were *Paradigm's* menus, and naming them made one realm's
   * layout part of the client's vocabulary. They are gone: the client is
   * pre-v1 and carries no legacy shapes, so a file still using them states no
   * script at all rather than half of one nobody can see in the form.
   */
  it('ignores the four login keys the schema used to name', () => {
    const config = normalizeConfig({
      connection: {
        login: { username: 'v', password: 'p', selection: 'P', realm: '1', character: '2' }
      }
    });
    expect(config.connection.login.steps).toEqual(DEFAULT_CONFIG.connection.login.steps);
  });

  it('keeps a server’s own menu script', () => {
    const config = normalizeConfig({
      servers: [
        {
          name: 'Bearfather',
          host: 'bbs.example',
          port: 23,
          login: [
            { when: 'S : Shift', send: 's' },
            { when: 'Please select a realm', send: '1' },
            // Several menus want a bare Enter, which is a real answer.
            { when: 'Press ENTER to continue', send: '' }
          ]
        }
      ]
    });
    expect(config.servers[0]?.login).toEqual([
      { when: 'S : Shift', send: 's' },
      { when: 'Please select a realm', send: '1' },
      { when: 'Press ENTER to continue', send: '' }
    ]);
  });

  it('ignores a `profiles:` list, which now means characters', () => {
    // The word was reused: `profiles:` meant saved realms until a profile came
    // to mean a character, and characters are directories. Reading it as a
    // realm list would make a stale key in an old file conjure a realm nothing
    // on this screen can edit.
    const config = normalizeConfig({
      profiles: [{ name: 'Home', host: 'example.test', port: 4000 }]
    });
    expect(config.servers).toEqual([]);
  });

  it('drops a server with no host rather than defaulting it', () => {
    // A defaulted entry would be a palette row that silently connects
    // somewhere the user never named — and a profile could name it.
    const config = normalizeConfig({ servers: [{ name: 'Broken' }, { host: 'ok.test' }] });
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0]?.host).toBe('ok.test');
  });

  it('names an unnamed server after its address', () => {
    const config = normalizeConfig({ servers: [{ host: 'ok.test', port: 9999 }] });
    expect(config.servers[0]?.name).toBe('ok.test:9999');
  });

  it('drops a duplicate server name, keeping the first', () => {
    const config = normalizeConfig({
      servers: [
        { name: 'Realm', host: 'first.test' },
        { name: 'realm', host: 'second.test' }
      ]
    });
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0]?.host).toBe('first.test');
  });

  it('falls back to the built-in servers when the key is not a list', () => {
    expect(normalizeConfig({ servers: 'nope' }).servers).toEqual(DEFAULT_CONFIG.servers);
  });

  it('tolerates a server list of entirely junk', () => {
    expect(normalizeConfig({ servers: [null, 7, 'x', []] }).servers).toEqual([]);
  });

  it('clamps an absurd log cap instead of accepting it', () => {
    expect(normalizeConfig({ logging: { maxBytes: 1 } }).logging.maxBytes).toBe(64 * 1024);
  });

  it('shows the HUD by default and lets it be turned off', () => {
    expect(DEFAULT_CONFIG.ui.showHud).toBe(true);
    expect(normalizeConfig({ ui: { showHud: false } }).ui.showHud).toBe(false);
  });

  it('lets logging be turned off', () => {
    expect(normalizeConfig({ logging: { enabled: false } }).logging.enabled).toBe(false);
  });

  it('defaults the connection to Paradigm, which is what the client ships for', () => {
    expect(targetFromConfig(DEFAULT_CONFIG)).toEqual({
      host: 'paramud.mudinfo.net',
      port: 2323,
      encoding: 'cp437'
    });
  });
});

describe('ui.vitals thresholds', () => {
  const vitals = (raw: unknown): ReturnType<typeof normalizeConfig>['ui']['vitals'] =>
    normalizeConfig({ ui: { vitals: raw } }).ui.vitals;

  it('defaults to half and a quarter for both resources', () => {
    expect(normalizeConfig({}).ui.vitals).toEqual({
      hp: { caution: 0.5, critical: 0.25 },
      mana: { caution: 0.5, critical: 0.25 }
    });
  });

  it('reads a value above 1 as a percentage', () => {
    // `caution: 50` is what someone writes when the comment says "percentage",
    // and clamping it to 1 would paint the bar permanently red. A plausible
    // misreading must not be the dangerous one.
    expect(vitals({ hp: { caution: 50, critical: 25 } }).hp).toEqual({
      caution: 0.5,
      critical: 0.25
    });
  });

  it('never lets red sit above yellow', () => {
    expect(vitals({ hp: { caution: 0.2, critical: 0.8 } }).hp).toEqual({
      caution: 0.2,
      critical: 0.2
    });
  });

  it('keeps health and mana independent', () => {
    const v = vitals({ hp: { caution: 0.7, critical: 0.4 } });
    expect(v.hp).toEqual({ caution: 0.7, critical: 0.4 });
    expect(v.mana).toEqual({ caution: 0.5, critical: 0.25 });
  });

  it('keeps a finished walk on screen when asked to keep it', () => {
    // Zero is meaningful rather than absent: it means "leave it until something
    // else happens", for anyone who would rather dismiss it themselves.
    expect(
      normalizeConfig({ automation: { walk: { clearAfterSeconds: 0 } } }).automation.walk
        .clearAfterSeconds
    ).toBe(0);
  });

  it('clamps an absurd dwell rather than accepting it', () => {
    expect(
      normalizeConfig({ automation: { walk: { clearAfterSeconds: 99_999 } } }).automation.walk
        .clearAfterSeconds
    ).toBe(3600);
  });

  it('falls back rather than throwing on nonsense', () => {
    expect(vitals('very low').hp).toEqual({ caution: 0.5, critical: 0.25 });
    expect(vitals({ hp: { caution: 'half', critical: -3 } }).hp).toEqual({
      caution: 0.5,
      critical: 0.25
    });
    expect(vitals({ hp: [] }).hp).toEqual({ caution: 0.5, critical: 0.25 });
  });
});

describe('automation.walk', () => {
  it('defaults to a patience longer than the queue waits for an acknowledgement', () => {
    // A step abandoned while the arbiter is still waiting its turn to send it
    // looks exactly like a broken route.
    const { walk, pacing } = normalizeConfig({}).automation;
    expect(walk.stepTimeoutMs).toBeGreaterThan(pacing.ackTimeoutMs);
  });

  it('floors the timeout rather than accepting an instant give-up', () => {
    expect(
      normalizeConfig({ automation: { walk: { stepTimeoutMs: 5 } } }).automation.walk.stepTimeoutMs
    ).toBe(1000);
  });

  it('falls back rather than throwing on nonsense', () => {
    expect(normalizeConfig({ automation: { walk: 'soon' } }).automation.walk.stepTimeoutMs).toBe(
      DEFAULT_CONFIG.automation.walk.stepTimeoutMs
    );
  });
});

/*
 * Auto-combat, which is the one block here that makes the client *do* something
 * unasked. Every value is coerced towards doing less, because that is the
 * direction a misread setting has to fail in.
 */
describe('automation.combat', () => {
  const combat = (raw: unknown): AppConfig['automation']['combat'] =>
    normalizeConfig({ automation: { combat: raw } }).automation.combat;

  it('is off, and hits back, by default', () => {
    const d = DEFAULT_CONFIG.automation.combat;
    expect(d.enabled).toBe(false);
    // The one default that is on, because it is the one that cannot start a
    // fight: something is already swinging.
    expect(d.retaliate).toBe(true);
    expect(d.engage).toBe('hostile');
  });

  it('takes the three engage policies and refuses anything else', () => {
    expect(combat({ engage: 'none' }).engage).toBe('none');
    expect(combat({ engage: 'all' }).engage).toBe('all');
    expect(combat({ engage: 'players' }).engage).toBe('hostile');
  });

  /*
   * A blank attack verb would send a bare newline at whatever is in the room,
   * which on this server re-reads the room — so it would look like auto-combat
   * doing nothing while it spent a command per status line.
   */
  it('puts the attack verb back when the file empties it', () => {
    expect(combat({ attack: '' }).attack).toBe('a');
    expect(combat({ attack: '   ' }).attack).toBe('a');
  });

  /* Blank *is* meaningful for the opener: the character has none. */
  it('keeps an empty opener, which means there is no opener', () => {
    expect(combat({ opener: '' }).opener).toBe('');
    expect(combat({ opener: 'bs' }).opener).toBe('bs');
  });

  /*
   * A field somebody typed a sentence into is not a command. Sending it would
   * type the sentence into the game, which on this server is said out loud.
   */
  it('takes only the first word of a command', () => {
    expect(combat({ attack: 'attack the rat' }).attack).toBe('attack');
    expect(combat({ opener: 'backstab the rat' }).opener).toBe('backstab');
  });

  /*
   * Monster names are keyed the way the wire spells them, once, here — so
   * `Giant Rat`, `giant rat` and `the giant rat` are one entry rather than
   * three that miss.
   */
  it('keys monster names the way the stream spells them', () => {
    expect(combat({ avoid: ['The Giant Rat', 'giant rat', '  A Kobold  Thief '] }).avoid).toEqual([
      'giant rat',
      'kobold thief'
    ]);
  });

  /*
   * The same coercion every other health threshold here gets: a number above 1
   * is read as a percentage, because writing `minHealth: 30` is what somebody
   * means by "thirty percent" and refusing it would be pedantry with a
   * character on the end of it.
   */
  it('reads a threshold above one as a percentage, like every other one', () => {
    expect(combat({ minHealth: 30 }).minHealth).toBe(0.3);
    expect(combat({ minHealth: 0.3 }).minHealth).toBe(0.3);
  });

  it('clamps the rest rather than refusing the file', () => {
    expect(combat({ minHealth: -1 }).minHealth).toBe(DEFAULT_CONFIG.automation.combat.minHealth);
    expect(combat({ maxMobs: 900 }).maxMobs).toBe(20);
    expect(combat({ maxMobs: -4 }).maxMobs).toBe(0);
  });

  it('falls back to the defaults for a block that is not one', () => {
    expect(combat('yes')).toEqual(DEFAULT_CONFIG.automation.combat);
  });
});

/*
 * Resting is a pair, and the pair has an order. A ceiling under the floor asks
 * the client to sit down at 50% and stand up at 40%, so normalisation lifts it
 * rather than refusing the file.
 *
 * This pair also carries the loop's health hold since `loopPauseBelow` and
 * `loopResumeAt` were folded into it (2026-09-02), which is why the shipped
 * figures are the ones that pair had rather than the 0 every other automated
 * threshold here ships at.
 */
describe('the resting pair', () => {
  const health = (raw: Record<string, unknown>) =>
    normalizeConfig({ automation: { health: raw } }).automation.health;

  it('ships at the figures the retired loop pair had', () => {
    expect(health({}).restBelow).toBe(0.35);
    expect(health({}).restTo).toBe(0.7);
  });

  it('reads a figure above one as a percentage, like every other threshold', () => {
    expect(health({ restBelow: 60, restTo: 90 })).toMatchObject({
      restBelow: 0.6,
      restTo: 0.9
    });
  });

  it('lifts a ceiling that sits under the floor', () => {
    expect(health({ restBelow: 0.6, restTo: 0.4 })).toMatchObject({
      restBelow: 0.6,
      restTo: 0.6
    });
  });

  /*
   * 0 is the single sit-down, not a lower bound, so it is deliberately *not*
   * lifted to the floor the way any other under-figure is. This is the one
   * place the folded pair does not behave as `loopResumeAt` did, and it is the
   * reason `LoopRunner.resumeAt` reads the floor rather than the raw ceiling.
   */
  it('leaves a 0 ceiling alone, because 0 means the single sit-down', () => {
    expect(health({ restBelow: 0.6, restTo: 0 })).toMatchObject({
      restBelow: 0.6,
      restTo: 0
    });
  });

  it('lets 0 mean never', () => {
    expect(health({ restBelow: 0, restTo: 0 })).toMatchObject({
      restBelow: 0,
      restTo: 0
    });
  });
});

describe('the potion settings', () => {
  const health = (raw: Record<string, unknown>) =>
    normalizeConfig({ automation: { health: raw } }).automation.health;

  it('ships off, drinking, and asking for the plain names', () => {
    expect(health({})).toMatchObject({
      drinkHealingPotionBelow: 0,
      drinkManaPotionBelow: 0,
      potionVerb: 'drink',
      healingPotionName: 'healing potion',
      manaPotionName: 'mana potion'
    });
  });

  it('reads the thresholds as fractions and the verb from the two the realm has', () => {
    expect(health({ drinkHealingPotionBelow: 25, drinkManaPotionBelow: 0.15 })).toMatchObject({
      drinkHealingPotionBelow: 0.25,
      drinkManaPotionBelow: 0.15
    });
    expect(health({ potionVerb: 'use' }).potionVerb).toBe('use');
    // A verb the realm does not have is not sent: it would be said out loud.
    expect(health({ potionVerb: 'quaff' }).potionVerb).toBe('drink');
  });

  it('trims the names and keeps what was typed', () => {
    expect(health({ healingPotionName: '  minor healing potion ' }).healingPotionName).toBe(
      'minor healing potion'
    );
  });
});

describe('the way out of a fight', () => {
  const retreat = (raw: Record<string, unknown>) =>
    normalizeConfig({ automation: { safety: { retreat: raw } } }).automation.safety.retreat;

  it('ships as the single step back, with no haven', () => {
    expect(retreat({})).toMatchObject({ strategy: 'step-back', safeHavenRoom: '' });
  });

  it('reads the haven strategy, and falls back from one it does not have', () => {
    expect(retreat({ strategy: 'safe-haven' }).strategy).toBe('safe-haven');
    expect(retreat({ strategy: 'teleport' }).strategy).toBe('step-back');
  });

  /*
   * The two words that used to be here. `flee` named a command this server
   * family does not have and `reverse-step` fell back to it, so a file still
   * saying either must land on the strategy that walks — never on a spelling
   * the client would quietly keep and then not act on.
   */
  it('will not read back the two strategies that named a command', () => {
    expect(retreat({ strategy: 'flee' }).strategy).toBe('step-back');
    expect(retreat({ strategy: 'reverse-step' }).strategy).toBe('step-back');
  });

  it('keeps the haven as typed, trimmed', () => {
    expect(retreat({ safeHavenRoom: '  Newhaven, Town Gates 1/2150 ' }).safeHavenRoom).toBe(
      'Newhaven, Town Gates 1/2150'
    );
  });
});

describe('cures and blessings', () => {
  const spells = (raw: Record<string, unknown>) =>
    normalizeConfig({ automation: { spells: raw } }).automation.spells;

  it('ships with no cure, no blessing, and the notification off', () => {
    expect(spells({}).cures).toEqual({ blindness: '', poison: '', disease: '' });
    expect(spells({}).blessings).toEqual([]);
    expect(spells({}).notifyPartyOnWearOff).toBe(false);
  });

  it('trims a cure name and ignores one it does not know', () => {
    expect(spells({ cures: { poison: ' cure poison ', paralysis: 'x' } }).cures).toEqual({
      blindness: '',
      poison: 'cure poison',
      disease: ''
    });
  });

  it('keys a blessing on spell and target, drops the spell-less and the duplicate, and floors the party clock', () => {
    expect(
      spells({
        blessings: [
          { spell: 'protection', minMana: 30, fallbackSeconds: 5 },
          // The same spell at the same target is the same row: the first
          // wins, since the order is the priority.
          { spell: 'Protection' },
          // The same spell at the *other* target is a second legitimate row —
          // self and party recast on different mechanisms.
          { spell: 'Protection', target: 'party' },
          { spell: '' },
          'nonsense',
          { spell: 'bless', target: 'party', fallbackSeconds: 5 }
        ]
      }).blessings
    ).toEqual([
      {
        spell: 'protection',
        target: 'self',
        minMana: 0.3,
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
        fallbackSeconds: 30
      }
    ]);
  });

  it('defaults inCombat by target: on for self, off for party — and only party rows carry a clock', () => {
    const rows = spells({
      blessings: [
        { spell: 'mage shield', fallbackSeconds: 600 },
        { spell: 'bless', target: 'party' },
        { spell: 'guard', target: 'party', inCombat: true }
      ]
    }).blessings;
    expect(rows.map((row) => [row.target, row.inCombat])).toEqual([
      ['self', true],
      ['party', false],
      ['party', true]
    ]);
    // A self row's clock is measured, never typed: the key is not carried.
    expect(rows.map((row) => row.fallbackSeconds)).toEqual([undefined, 300, 300]);
  });
});

describe('following somebody', () => {
  const party = (raw: Record<string, unknown>) =>
    normalizeConfig({ automation: { party: raw } }).automation.party;

  it('ships entirely off', () => {
    expect(party({})).toEqual({
      assistLeader: false,
      defendParty: false,
      restWithLeader: false
    });
  });

  it('reads the switches', () => {
    expect(
      party({
        assistLeader: true,
        defendParty: true,
        restWithLeader: true
      })
    ).toEqual({
      assistLeader: true,
      defendParty: true,
      restWithLeader: true
    });
  });
});

/**
 * The union and the paths behind it, checked against the shape they address.
 *
 * The same failure `guard-fields.test.ts` exists for: a name in the type with
 * a path that leads nowhere type-checks, and the only symptom is a toolbar
 * button that reads `off` for ever and writes a key nothing looks at. The
 * table is the only place either half is written down, so this walks it.
 */
describe('the automation switches the toolbar flips', () => {
  it('every path leads to a boolean in the shipped configuration', () => {
    const bad: string[] = [];
    for (const name of AUTOMATION_SWITCH_NAMES) {
      let node: unknown = DEFAULT_CONFIG.automation;
      for (const key of AUTOMATION_SWITCHES[name]) {
        node = typeof node === 'object' && node !== null ? (node as never)[key] : undefined;
      }
      if (typeof node !== 'boolean') bad.push(`${name} -> ${AUTOMATION_SWITCHES[name].join('.')}`);
    }
    expect(bad, `switches whose path is not a boolean: ${bad.join(', ')}`).toEqual([]);
  });

  it('reads each one out of a resolved configuration', () => {
    const on: AppConfig = {
      ...DEFAULT_CONFIG,
      automation: {
        ...DEFAULT_CONFIG.automation,
        enabled: true,
        combat: { ...DEFAULT_CONFIG.automation.combat, enabled: true }
      }
    };
    expect(readAutomationSwitch(on.automation, 'automation')).toBe(true);
    expect(readAutomationSwitch(on.automation, 'combat')).toBe(true);
    // Off by default, like everything automated.
    expect(readAutomationSwitch(on.automation, 'retreat')).toBe(false);
    expect(automationSwitches(on.automation).bashDoors).toBe(false);
  });

  it('refuses a name that is not one', () => {
    expect(asAutomationSwitch('combat')).toBe('combat');
    expect(asAutomationSwitch('combat.enabled')).toBeNull();
    expect(asAutomationSwitch(7)).toBeNull();
    expect(asAutomationSwitch('toString')).toBeNull();
  });
});
