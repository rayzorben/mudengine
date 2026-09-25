import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../config';
import { overlay, resolveProfile, PROFILE_ACCENTS } from '../profiles';

/**
 * The options file *as parsed*, not as coerced. A profile overlays the file and
 * the sum is normalised once — see `resolveProfile`.
 */
const base: Record<string, unknown> = {
  servers: [{ name: 'GreaterMUD (local)', host: 'gmud-tgs', port: 2427, encoding: 'cp437' }],
  automation: { idle: { enabled: true, afterSeconds: 300 } }
};

/** The happy path, so each test can state only what it is about. */
function resolve(raw: Record<string, unknown>, config: unknown = base) {
  const result = resolveProfile('thorn', raw, config);
  if (result.error !== undefined) throw new Error(result.error);
  return result.profile;
}

describe('overlay', () => {
  it('merges records key by key', () => {
    expect(overlay({ a: { x: 1, y: 2 } }, { a: { y: 3 } })).toEqual({ a: { x: 1, y: 3 } });
  });

  it('replaces a list rather than appending to it', () => {
    // Stating a list means "these", not "these as well". Appending would make a
    // global entry impossible to remove for one character.
    expect(overlay({ rules: ['a', 'b'] }, { rules: ['c'] })).toEqual({ rules: ['c'] });
  });

  it('leaves the base alone where the patch says nothing', () => {
    const original = { a: { x: 1 } };
    expect(overlay(original, {})).toEqual(original);
    expect(overlay(original, undefined)).toEqual(original);
  });
});

describe('the realm a character walks', () => {
  /*
   * The world file is the realm's, not the character's. It used to be
   * `world.database` in every character's own file, which was the same answer
   * written out once each with as many places to drift — and a character added
   * afterwards silently got the shipped world while the ones beside it walked
   * Paradigm.
   */
  it('takes the database off the realm it names', () => {
    const config = {
      servers: [
        {
          name: 'GreaterMUD (local)',
          host: 'gmud-tgs',
          port: 2427,
          database: '/realms/paradigm.mdb'
        }
      ]
    };
    expect(resolve({ server: 'GreaterMUD (local)' }, config).database).toBe('/realms/paradigm.mdb');
  });

  /* Empty is a real answer: the world that ships with the client. */
  it('is empty for a realm that names none', () => {
    expect(resolve({ server: 'GreaterMUD (local)' }).database).toBe('');
  });

  /*
   * An inline address is the realm declaration, spelled out where the character
   * sits rather than in a directory of its own — so it may say which map it is,
   * unlike the menu script, where there is a server entry's to inherit or not.
   */
  it('reads one off an address spelled out inline', () => {
    expect(
      resolve({ server: { host: 'gmud-tgs', port: 2427, database: '/realms/mine.mdb' } }).database
    ).toBe('/realms/mine.mdb');
  });

  /*
   * And a character cannot state one of its own. The key is gone from the
   * options schema, so `world:` left in a file is overlaid onto nothing and
   * coerced away — the realm is the only place that answers.
   */
  it('ignores a world block left in a character file', () => {
    const profile = resolve({
      server: 'GreaterMUD (local)',
      world: { database: '/realms/somewhere-else.mdb' }
    });
    expect(profile.database).toBe('');
    expect(profile.config).not.toHaveProperty('world');
  });
});

/* Whether a hang-up is charged: the character, then its realm, then the options file (todo 01). */
describe('who says a hang-up is charged', () => {
  const realm = (hangPenalties?: boolean) => ({
    servers: [
      {
        name: 'Bearfather',
        host: 'bbs.bearfather.net',
        port: 23,
        ...(hangPenalties === undefined ? {} : { hangPenalties })
      }
    ],
    automation: { safety: { hangUp: { penalties: false } } }
  });
  const penalties = (raw: Record<string, unknown>, config: unknown): boolean =>
    resolve({ server: 'Bearfather', ...raw }, config).config.automation.safety.hangUp.penalties;
  const own = (value: boolean) => ({ automation: { safety: { hangUp: { penalties: value } } } });

  it('takes the realm over the options file where the character says nothing', () => {
    expect(penalties({}, realm(true))).toBe(true);
    expect(penalties({ automation: { safety: { hangUp: { enabled: true } } } }, realm(true))).toBe(
      true
    );
  });

  it('takes the character over its realm', () => {
    expect(penalties(own(false), realm(true))).toBe(false);
    expect(penalties(own(true), realm(false))).toBe(true);
  });

  it('falls to the options file where the realm says nothing, and that is off', () => {
    expect(penalties({}, realm())).toBe(false);
    expect(
      resolve({ server: 'GreaterMUD (local)' }).config.automation.safety.hangUp.penalties
    ).toBe(false);
  });
});

/*
 * The teleport below the retreat, literally: the character, then its realm, then
 * the options file (todo 813). Each realm spells it its own way.
 */
describe('who says what the last-ditch teleport sends', () => {
  const realm = (fleeGoto?: string, global = '') => ({
    servers: [
      {
        name: 'Bearfather',
        host: 'bbs.bearfather.net',
        port: 23,
        ...(fleeGoto === undefined ? {} : { fleeGoto })
      }
    ],
    automation: { safety: { fleeGoto: { enabled: true, command: global } } }
  });
  const command = (raw: Record<string, unknown>, config: unknown): string =>
    resolve({ server: 'Bearfather', ...raw }, config).config.automation.safety.fleeGoto.command;
  const own = (value: string) => ({ automation: { safety: { fleeGoto: { command: value } } } });

  it('takes the realm’s where the character states none, over the options file', () => {
    expect(command({}, realm('sys go 1 297', 'sys goto silvermere'))).toBe('sys go 1 297');
    expect(command(own(''), realm('sys go 1 297'))).toBe('sys go 1 297');
  });

  it('takes the character’s over its realm', () => {
    expect(command(own('sys goto silvermere'), realm('sys go 1 297'))).toBe('sys goto silvermere');
  });

  it('falls to the options file where neither states one, and that ships empty', () => {
    expect(command({}, realm(undefined, 'sys go 1 297'))).toBe('sys go 1 297');
    expect(
      resolve({ server: 'GreaterMUD (local)' }).config.automation.safety.fleeGoto.command
    ).toBe('');
  });

  it('reads one off an address spelled out inline', () => {
    const inline = { server: { host: 'bbs.test', port: 23, fleeGoto: 'sys goto silvermere' } };
    expect(resolve(inline).config.automation.safety.fleeGoto.command).toBe('sys goto silvermere');
  });
});

/* The realm's word for where am I: the character, then its realm, then `rm` (todo 811). */
describe('who says how the realm is asked where you stand', () => {
  const realm = (locate?: string) => ({
    servers: [
      {
        name: 'Bearfather',
        host: 'bbs.bearfather.net',
        port: 23,
        ...(locate === undefined ? {} : { locate })
      }
    ]
  });
  const locate = (raw: Record<string, unknown>, config: unknown) =>
    resolve({ server: 'Bearfather', ...raw }, config).locate;

  it('takes the realm’s word where the character states none', () => {
    expect(locate({}, realm('none'))).toBe('none');
    expect(locate({}, realm('rm'))).toBe('rm');
  });

  it('is `rm` where neither says, which is what every realm was asked before', () => {
    expect(locate({}, realm())).toBe('rm');
  });

  it('takes the character over its realm, as its own login script does', () => {
    expect(locate({ locate: 'rm' }, realm('none'))).toBe('rm');
    expect(locate({ locate: 'none' }, realm('rm'))).toBe('none');
  });

  it('reads a word it does not know as unstated, so the realm answers', () => {
    // `sys-status` is the fork's, held (todo 811): not a value this client has.
    expect(locate({ locate: 'sys-status' }, realm('none'))).toBe('none');
    expect(locate({}, realm('sys-status'))).toBe('rm');
  });

  it('reads one off an address spelled out inline', () => {
    const inline = { server: { host: 'bbs.test', port: 23, locate: 'none' } };
    expect(resolve(inline).locate).toBe('none');
  });

  it('keeps the key out of the options the character runs under', () => {
    expect(resolve({ server: 'Bearfather', locate: 'none' }, realm()).config).not.toHaveProperty(
      'locate'
    );
  });
});

describe('resolveProfile', () => {
  it('resolves a server named in the options file', () => {
    const profile = resolve({ server: 'GreaterMUD (local)' });
    expect(profile.target).toEqual({ host: 'gmud-tgs', port: 2427, encoding: 'cp437' });
  });

  it('matches a server name case-insensitively', () => {
    expect(resolve({ server: 'greatermud (LOCAL)' }).target.host).toBe('gmud-tgs');
  });

  it('accepts a server spelled out inline', () => {
    const profile = resolve({ server: { host: 'other.test', port: 4000, encoding: 'utf8' } });
    expect(profile.target).toEqual({ host: 'other.test', port: 4000, encoding: 'utf8' });
  });

  it('refuses a profile that names no server, rather than defaulting it', () => {
    // A defaulted character is a tab that silently dials somewhere the player
    // never chose, which is worse than a character that does not load.
    const result = resolveProfile('thorn', { name: 'Thorn' }, base);
    expect(result.error).toMatch(/no server/);
  });

  it('refuses a server name that does not exist, and says which', () => {
    const result = resolveProfile('thorn', { server: 'Nowhere' }, base);
    expect(result.error).toContain('Nowhere');
  });

  it('takes credentials from an inline account', () => {
    const login = resolve({
      server: 'GreaterMUD (local)',
      account: { username: 'rayzor', password: 'hunter2' }
    }).config.connection.login;
    expect(login.username).toBe('rayzor');
    expect(login.password).toBe('hunter2');
    // A profile exists to say "this is my character, log me in".
    expect(login.enabled).toBe(true);
  });

  it('keeps login disabled when no account resolves', () => {
    const login = resolve({ server: 'GreaterMUD (local)' }).config.connection.login;
    expect(login.enabled).toBe(false);
    expect(login.username).toBe('');
  });

  it('lets two characters state the same account and differ by slot', () => {
    // There is no shared account store: two characters on one BBS account each
    // state their own username and password inline, and only the character
    // slot genuinely differs between them.
    const account = { username: 'rayzor', password: 'hunter2' };
    const thorn = resolveProfile(
      'thorn',
      { server: 'GreaterMUD (local)', account, login: { character: '1' } },
      base
    );
    const mara = resolveProfile(
      'mara',
      {
        server: 'GreaterMUD (local)',
        account,
        login: { steps: [{ when: 'Please select a character', send: '2' }] }
      },
      base
    );
    if (thorn.error !== undefined || mara.error !== undefined) throw new Error('did not resolve');
    expect(thorn.profile.config.connection.login.username).toBe('rayzor');
    expect(mara.profile.config.connection.login.username).toBe('rayzor');
    const slot = (steps: { when: string; send: string }[]): string | undefined =>
      steps.find((step) => step.when.includes('character'))?.send;
    expect(slot(thorn.profile.config.connection.login.steps)).toBe('1');
    expect(slot(mara.profile.config.connection.login.steps)).toBe('2');
  });

  it('inherits every setting it does not mention', () => {
    const profile = resolve({ server: 'GreaterMUD (local)' });
    // The whole reason a profile is an overlay: a setting added to the client
    // after this file was written still reaches the character.
    expect(profile.config.automation.idle.afterSeconds).toBe(300);
    expect(profile.config.terminal.font.size).toBe(DEFAULT_CONFIG.terminal.font.size);
  });

  it('overrides only what it states', () => {
    const profile = resolve({
      server: 'GreaterMUD (local)',
      automation: { idle: { afterSeconds: 90 } }
    });
    expect(profile.config.automation.idle.afterSeconds).toBe(90);
    // Sibling keys in the same block survive.
    expect(profile.config.automation.idle.enabled).toBe(true);
  });

  it('coerces an override through the same rules as the options file', () => {
    const profile = resolve({
      server: 'GreaterMUD (local)',
      automation: { idle: { afterSeconds: 'nonsense' } }
    });
    // One place decides what a valid value is, so a typo in a profile falls
    // back rather than poisoning a session.
    expect(typeof profile.config.automation.idle.afterSeconds).toBe('number');
  });

  it('names itself after its file when it says nothing else', () => {
    expect(resolve({ server: 'GreaterMUD (local)' }).name).toBe('thorn');
    expect(resolve({ server: 'GreaterMUD (local)', name: 'Thorn' }).name).toBe('Thorn');
  });

  it('gives a character a stable accent that does not depend on its siblings', () => {
    const first = resolveProfile('thorn', { server: 'GreaterMUD (local)' }, base);
    const again = resolveProfile('thorn', { server: 'GreaterMUD (local)' }, base);
    if (first.error !== undefined || again.error !== undefined) throw new Error('did not resolve');
    expect(first.profile.accent).toBe(again.profile.accent);
    expect(PROFILE_ACCENTS).toContain(first.profile.accent);
  });

  it('honours an accent it chooses, and ignores one it invents', () => {
    expect(resolve({ server: 'GreaterMUD (local)', accent: 'amber' }).accent).toBe('amber');
    expect(PROFILE_ACCENTS).toContain(
      resolve({ server: 'GreaterMUD (local)', accent: '#ff0000' }).accent
    );
  });

  it('keeps a rule the options file declares', () => {
    /*
     * The regression that cost a live-check run. `normalizeConfig` is not
     * idempotent: a rule's `when` and `if` are parsed into structures that the
     * parser cannot read back, so overlaying onto an already-coerced config
     * silently emptied every character's rule list. A profile overlays the file
     * and the sum is coerced exactly once.
     */
    const withRule = {
      ...base,
      automation: {
        rules: [
          {
            name: 'run when hurt',
            when: 'every 3s',
            if: ['inCombat == false'],
            then: [{ command: 'pro', priority: 'idle' }]
          }
        ]
      }
    };
    const profile = resolve({ server: 'GreaterMUD (local)' }, withRule);
    expect(profile.config.automation.rules.map((rule) => rule.name)).toEqual(['run when hurt']);
  });

  it('rejects a file that is not a mapping', () => {
    expect(resolveProfile('thorn', ['a', 'list'], base).error).toBeDefined();
    expect(resolveProfile('thorn', 'a string', base).error).toBeDefined();
  });
});

/*
 * The one `automation:` list that is merged across scopes instead of being
 * replaced by the overlay. The realm's half cannot ride on `overlay` at all —
 * a realm's settings are not part of `config` — so this is the seam where the
 * three lists actually meet, and the place a mistake in it would show.
 */
describe('the mob priority list, across global, realm and character', () => {
  const realm = {
    name: 'GreaterMUD (local)',
    host: 'gmud-tgs',
    port: 2427,
    encoding: 'cp437',
    mobRules: [{ mob: 'sewer rat', treat: 'last' }]
  };
  const withRealm: Record<string, unknown> = {
    servers: [realm],
    automation: { combat: { mobRules: [{ mob: 'red dragon', treat: 'last' }] } }
  };

  const rules = (profile: { config: { automation: { combat: { mobRules: unknown } } } }) =>
    profile.config.automation.combat.mobRules;

  it('keeps a monster only the realm names', () => {
    const profile = resolve({ name: 'Thorn', server: 'GreaterMUD (local)' }, withRealm);
    expect(rules(profile)).toContainEqual({ mob: 'sewer rat', treat: 'last' });
  });

  it('keeps the global rows beside the realm’s', () => {
    const profile = resolve({ name: 'Thorn', server: 'GreaterMUD (local)' }, withRealm);
    expect(rules(profile)).toContainEqual({ mob: 'red dragon', treat: 'last' });
  });

  /*
   * The case `overlay` alone gets wrong: a character stating its own list would
   * otherwise replace the global one wholesale and lose the realm's entirely.
   */
  it('keeps every scope’s rows when the character states its own', () => {
    const profile = resolve(
      {
        name: 'Thorn',
        server: 'GreaterMUD (local)',
        automation: { combat: { mobRules: [{ mob: 'gnoll shaman', treat: 'first' }] } }
      },
      withRealm
    );
    expect(rules(profile)).toEqual(
      expect.arrayContaining([
        { mob: 'gnoll shaman', treat: 'first' },
        { mob: 'sewer rat', treat: 'last' },
        { mob: 'red dragon', treat: 'last' }
      ])
    );
  });

  it('lets the character’s row win over the realm’s for one monster', () => {
    const profile = resolve(
      {
        name: 'Thorn',
        server: 'GreaterMUD (local)',
        automation: { combat: { mobRules: [{ mob: 'sewer rat', treat: 'first' }] } }
      },
      withRealm
    );
    expect(rules(profile)).toContainEqual({ mob: 'sewer rat', treat: 'first' });
    expect(rules(profile)).not.toContainEqual({ mob: 'sewer rat', treat: 'last' });
  });

  it('lets the realm’s row win over the global one', () => {
    const profile = resolve(
      { name: 'Thorn', server: 'GreaterMUD (local)' },
      {
        servers: [{ ...realm, mobRules: [{ mob: 'red dragon', treat: 'first' }] }],
        automation: { combat: { mobRules: [{ mob: 'red dragon', treat: 'last' }] } }
      }
    );
    expect(rules(profile)).toEqual([{ mob: 'red dragon', treat: 'first' }]);
  });

  /*
   * An inline address names no realm directory, so there is no realm list to
   * inherit and the global one must survive untouched.
   */
  it('keeps the global list for a character that spells its address out inline', () => {
    const profile = resolve({ name: 'Thorn', server: { host: 'gmud-tgs', port: 2427 } }, withRealm);
    expect(rules(profile)).toEqual([{ mob: 'red dragon', treat: 'last' }]);
  });
});
