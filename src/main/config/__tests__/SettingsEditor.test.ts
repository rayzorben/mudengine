import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

import { SettingsEditor } from '../SettingsEditor';
import { homeAt, type Home } from '../../app/home';
import { resolveProfile } from '../../../shared/profiles';
import type { GlobalDraft, ProfileDraft, ServerDraft } from '../../../shared/drafts';
import { ServerStore } from '../ServerStore';
import { LoopStore } from '../LoopStore';
import { DEFAULT_CONFIG, normalizeConfig } from '../../../shared/config';
import { UNCATEGORISED, type Loop } from '../../../shared/loops';

let dir = '';
let home: Home;
let configPath = '';
let profilesDir = '';
let editor: SettingsEditor;

const OPTIONS = `# The user's own notes, which they wrote.
connection:
  host: gmud-tgs
  port: 2427

servers:
  # The local test realm.
  - name: GreaterMUD (local)
    host: gmud-tgs
    port: 2427
    encoding: cp437
`;

const draft = (over: Partial<ProfileDraft> = {}): ProfileDraft => ({
  name: 'Vaelor',
  server: { kind: 'saved', name: 'GreaterMUD (local)' },
  username: 'someone',
  password: 'secret-value',
  changePassword: true,
  autoConnect: false,
  autoReconnect: true,
  accent: 'cyan',
  theme: '',
  login: [],
  hangUp: { enabled: false, belowHealth: 0.15, onlyWhenClean: true, onPlayerInRoom: false },
  retreat: {
    enabled: false,
    belowHealth: 0.3,
    whenOutnumbered: 0,
    strategy: 'step-back',
    safeHavenRoom: ''
  },
  pvp: { notifyGang: false, action: 'none' },
  // The shipped defaults, so a draft that says nothing about combat writes no
  // `combat:` block at all -- which is the behaviour the tests below assert.
  combat: { ...DEFAULT_CONFIG.automation.combat },
  party: { ...DEFAULT_CONFIG.automation.party },
  health: { ...DEFAULT_CONFIG.automation.health },
  movement: { ...DEFAULT_CONFIG.automation.movement },
  // Empty is what OPTIONS below gives a character: the options file states no
  // loops, so a draft matching it writes no `loops:` key.
  loops: [],
  spells: { ...DEFAULT_CONFIG.automation.spells },
  alerts: { ...DEFAULT_CONFIG.ui.alerts },
  remotes: { ...DEFAULT_CONFIG.automation.remotes },
  talk: { ...DEFAULT_CONFIG.automation.talk },
  ...over
});

const read = (id: string): Record<string, unknown> =>
  parse(fs.readFileSync(home.profile(id).file, 'utf8'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-settings-'));
  home = homeAt(dir);
  configPath = home.options;
  profilesDir = home.profilesDir;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, OPTIONS, 'utf8');
  fs.mkdirSync(profilesDir, { recursive: true });
  editor = new SettingsEditor({ home });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('creating a character', () => {
  it('writes a file the client can actually load', () => {
    expect(editor.saveProfile('vaelor', draft())).toEqual({ ok: true });
    const result = resolveProfile('vaelor', read('vaelor'), parse(OPTIONS));
    expect(result.error).toBeUndefined();
    if (result.error !== undefined) return;
    expect(result.profile.target).toEqual({ host: 'gmud-tgs', port: 2427, encoding: 'cp437' });
  });

  it('refers to a saved server by name rather than copying its address', () => {
    editor.saveProfile('vaelor', draft());
    // So renaming the host in one place moves every character that plays there.
    expect(read('vaelor')['server']).toBe('GreaterMUD (local)');
  });

  it('takes an address spelled out, for the first character on a new realm', () => {
    const result = editor.saveProfile('thorn', {
      ...draft(),
      server: { kind: 'inline', host: 'gmud-tgs', port: 2500, encoding: 'utf8' }
    });
    expect(result).toEqual({ ok: true });
    expect(read('thorn')['server']).toEqual({ host: 'gmud-tgs', port: 2500, encoding: 'utf8' });
  });

  /*
   * Rule 2 of `profiles.ts`: a profile that cannot name a server is not a
   * profile. Refusing it here is what stops the screen creating one that will
   * be reported and skipped on the next read.
   */
  it('refuses a character whose server does not exist', () => {
    const result = editor.saveProfile('ghost', {
      ...draft(),
      server: { kind: 'saved', name: 'Somewhere Else' }
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(home.profile('ghost').file)).toBe(false);
  });

  it('leaves a character with no account at all rather than an empty one', () => {
    editor.saveProfile('nobody', { ...draft(), username: '', password: '' });
    expect(read('nobody')['account']).toBeUndefined();
  });

  /*
   * A character states its own script only to *differ* from the others on its
   * BBS — in practice, a different character slot. The ordinary case is an
   * absent `login:`, meaning "use the server's".
   */
  it('writes a character’s own menu script when it has one', () => {
    editor.saveProfile('vaelor', {
      ...draft(),
      login: [
        { when: 'Please select a character', send: '2' },
        // An empty answer is a real one: several menus want a bare Enter.
        { when: 'Press ENTER to continue', send: '' }
      ]
    });
    expect(read('vaelor')['login']).toEqual({
      steps: [
        { when: 'Please select a character', send: '2' },
        { when: 'Press ENTER to continue', send: '' }
      ]
    });
  });

  /*
   * An empty script means "use the server's", so the block goes rather than
   * being left behind saying the opposite — a character that answers no menus.
   */
  it('removes the script when the last row is deleted', () => {
    editor.saveProfile('vaelor', {
      ...draft(),
      login: [{ when: 'Please select a character', send: '2' }]
    });
    editor.saveProfile('vaelor', draft());
    expect(read('vaelor')['login']).toBeUndefined();
  });
});

describe('editing a character that already exists', () => {
  /*
   * The failure this is guarding against: a character whose automation rules
   * vanished because its colour was changed. A profile is a sparse overlay and
   * may carry blocks this screen knows nothing about.
   */
  it('keeps blocks the screen knows nothing about', () => {
    const file = home.profile('vaelor').file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `server: GreaterMUD (local)
automation:
  rules:
    - when: 'hp < 0.3'
      do: s
ui:
  theme: slate
`,
      'utf8'
    );
    expect(editor.saveProfile('vaelor', draft({ accent: 'violet' }))).toEqual({ ok: true });
    const after = read('vaelor');
    expect(after['accent']).toBe('violet');
    expect(after['automation']).toEqual({ rules: [{ when: 'hp < 0.3', do: 's' }] });
    expect((after['ui'] as Record<string, unknown>)['theme']).toBe('slate');
  });

  /* The file is theirs, and the template is the documentation. */
  it('keeps the comments somebody wrote in it', () => {
    const file = home.profile('vaelor').file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# my main\nserver: GreaterMUD (local)\n`, 'utf8');
    editor.saveProfile('vaelor', draft());
    expect(fs.readFileSync(file, 'utf8')).toContain('# my main');
  });

  it('does not leave the old server behind when switching to an inline one', () => {
    editor.saveProfile('vaelor', draft());
    editor.saveProfile('vaelor', {
      ...draft(),
      server: { kind: 'inline', host: 'gmud-tgs', port: 2500, encoding: 'cp437' }
    });
    expect(read('vaelor')['server']).toEqual({
      host: 'gmud-tgs',
      port: 2500,
      encoding: 'cp437'
    });
  });

  /*
   * There is no shared account store any more, so a stale name left over from
   * before that removal is not a reference this screen can honour — it writes
   * the character's own inline credentials over it, same as any other save.
   */
  it('overwrites a stale named account reference with inline credentials', () => {
    const file = home.profile('vaelor').file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `server: GreaterMUD (local)\naccount: shared\n`, 'utf8');
    editor.saveProfile('vaelor', draft());
    expect(read('vaelor')['account']).toEqual({ username: 'someone', password: 'secret-value' });
  });

  it('refuses to touch a file that does not parse', () => {
    const file = home.profile('broken').file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'server: [unclosed\n', 'utf8');
    const result = editor.saveProfile('broken', draft());
    expect(result.ok).toBe(false);
    // The only copy of whatever was in it is still there.
    expect(fs.readFileSync(file, 'utf8')).toBe('server: [unclosed\n');
  });
});

describe('removing a character', () => {
  it('removes the file and keeps a copy of it', () => {
    editor.saveProfile('vaelor', draft());
    expect(editor.deleteProfile('vaelor')).toEqual({ ok: true });
    expect(fs.existsSync(home.profile('vaelor').file)).toBe(false);
    // A click that may have destroyed the only record of a password has to be
    // reversible.
    expect(fs.existsSync(`${home.profile('vaelor').file}.bak`)).toBe(true);
  });

  it('says so rather than throwing when it is already gone', () => {
    expect(editor.deleteProfile('nobody').ok).toBe(false);
  });
});

describe('servers, one directory each', () => {
  const server = (draft: Partial<ServerDraft> = {}): ServerDraft => ({
    name: 'Bearfather',
    host: 'bbs.bearfather.net',
    port: 23,
    encoding: 'cp437',
    login: [],
    loops: [],
    database: '',
    ...draft
  });

  /** Every server on disk, read the way the client reads them. */
  const servers = (): { id: string; name: string; host: string }[] =>
    new ServerStore(home).all.map((entry) => ({
      id: entry.id,
      name: entry.server.name,
      host: entry.server.host
    }));

  it('writes one into its own directory, named after it', () => {
    expect(editor.saveServer(null, server())).toEqual({ ok: true });
    expect(servers()).toEqual([
      { id: 'bearfather', name: 'Bearfather', host: 'bbs.bearfather.net' }
    ]);
    expect(fs.existsSync(home.server('bearfather').file)).toBe(true);
  });

  it('updates one in place rather than adding a second', () => {
    editor.saveServer(null, server());
    editor.saveServer('Bearfather', server({ host: '127.0.0.1' }));
    expect(servers()).toHaveLength(1);
    expect(servers()[0]!.host).toBe('127.0.0.1');
  });

  /*
   * Matched the way a character's `server:` reference is looked up, so an edit
   * differing only in case does not create a second entry nothing can tell
   * apart.
   */
  it('matches an existing server case-insensitively', () => {
    editor.saveServer(null, server());
    editor.saveServer('BEARFATHER', server({ host: '127.0.0.1' }));
    expect(servers()).toHaveLength(1);
  });

  /*
   * The directory is the identity and the name is a field in the file, which is
   * what keeps the loops beside it attached: a rename that moved the directory
   * would strand every loop recorded for that realm under a name nothing looks
   * for.
   */
  it('renames one without moving its directory, so its loops stay with it', () => {
    editor.saveServer(
      null,
      server({ loops: [{ name: 'Docks run', stops: [{ room: 'A' }, { room: 'B' }] }] })
    );
    editor.saveServer('Bearfather', server({ name: 'Home' }));
    expect(servers()).toEqual([{ id: 'bearfather', name: 'Home', host: 'bbs.bearfather.net' }]);
    // Still there, because `saveServer` was given no loops to write and the
    // directory did not move. (The screen always sends the list it is showing.)
    expect(fs.existsSync(path.join(home.server('bearfather').loops, 'docks-run.yaml'))).toBe(false);
  });

  it('refuses a second server under a name something already refers to', () => {
    editor.saveServer(null, server());
    const result = editor.saveServer(null, server({ host: 'elsewhere' }));
    expect(result.ok).toBe(false);
    expect(servers()).toHaveLength(1);
  });

  it('writes the loops that belong to the place, beside the server', () => {
    editor.saveServer(
      null,
      server({ loops: [{ name: 'Docks run', stops: [{ room: 'A' }, { room: 'B' }] }] })
    );
    const file = path.join(home.server('bearfather').loops, 'docks-run.yaml');
    expect(parse(fs.readFileSync(file, 'utf8'))['name']).toBe('Docks run');
    expect(new LoopStore(home).forServer('bearfather').map((loop) => loop.name)).toEqual([
      'Docks run'
    ]);
  });

  it('removes one nobody is using', () => {
    editor.saveServer(null, server());
    expect(editor.deleteServer('Bearfather')).toEqual({ ok: true });
    expect(servers()).toEqual([]);
  });

  /*
   * They may be the only copy of an evening's work, they are a fact about the
   * realm rather than about the entry that named it, and deleting them is not
   * what the button says.
   */
  it('leaves a removed server\u2019s loops on disk', () => {
    editor.saveServer(
      null,
      server({ loops: [{ name: 'Docks run', stops: [{ room: 'A' }, { room: 'B' }] }] })
    );
    editor.deleteServer('Bearfather');
    expect(fs.existsSync(path.join(home.server('bearfather').loops, 'docks-run.yaml'))).toBe(true);
  });

  /*
   * A list somebody typed back into the options file is still read and still
   * offered, so it is on the screen -- and a screen offering an entry it could
   * not then edit or delete would be a dead control. Editing one makes it a
   * directory, which is the move the migration makes, made one at a time.
   */
  it('turns an entry still written in the options file into a directory', () => {
    editor.saveServer('GreaterMUD (local)', {
      name: 'GreaterMUD (local)',
      host: '127.0.0.1',
      port: 2427,
      encoding: 'cp437',
      login: [],
      loops: [],
      database: ''
    });
    expect(servers()).toEqual([
      { id: 'greatermud-local', name: 'GreaterMUD (local)', host: '127.0.0.1' }
    ]);
    expect(parse(fs.readFileSync(configPath, 'utf8'))['servers']).toEqual([]);
    // And the file is still the user's: the comments around the block survive.
    expect(fs.readFileSync(configPath, 'utf8')).toContain("# The user's own notes");
  });

  it('removes one that only the options file states', () => {
    expect(editor.deleteServer('GreaterMUD (local)')).toEqual({ ok: true });
    expect(parse(fs.readFileSync(configPath, 'utf8'))['servers']).toEqual([]);
  });

  /*
   * Removing it would leave that character unresolvable — reported and skipped
   * on the next read, which is right for a file somebody broke by hand and
   * wrong for a button somebody pressed.
   */
  it('refuses to remove one a character still plays on, and names them', () => {
    editor.saveProfile('vaelor', draft());
    const result = editor.deleteServer('GreaterMUD (local)');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('vaelor');
  });

  it('does not count a character that spells its address out inline', () => {
    editor.saveProfile('thorn', {
      ...draft(),
      server: { kind: 'inline', host: 'gmud-tgs', port: 2427, encoding: 'cp437' }
    });
    expect(editor.deleteServer('GreaterMUD (local)').ok).toBe(true);
  });
});

/*
 * These functions run with a password in scope and their errors reach the
 * terminal and the notice channel. Not one of them may interpolate a value from
 * the draft.
 */
describe('credentials in the messages', () => {
  it('never puts a password in an error', () => {
    const results = [
      editor.saveProfile('ghost', {
        ...draft(),
        server: { kind: 'saved', name: 'Nowhere' }
      }),
      editor.deleteProfile('missing'),
      editor.deleteServer('GreaterMUD (local)')
    ];
    for (const result of results) {
      if (result.ok) continue;
      expect(result.error).not.toContain('secret-value');
    }
  });

  it('writes the password to the character file and nowhere else', () => {
    editor.saveProfile('vaelor', draft());
    expect(read('vaelor')['account']).toEqual({ username: 'someone', password: 'secret-value' });
    // Not into the options file, which is shared and which somebody may well
    // paste into a bug report.
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('secret-value');
    // And not into the backup of it either, which is written on every server
    // edit and lives in the same directory.
    editor.saveServer(null, {
      name: 'Spare',
      host: 'gmud-tgs',
      port: 2500,
      encoding: 'cp437',
      login: [],
      loops: [],
      database: ''
    });
    for (const file of fs.readdirSync(dir)) {
      if (!fs.statSync(path.join(dir, file)).isFile()) continue;
      expect(fs.readFileSync(path.join(dir, file), 'utf8')).not.toContain('secret-value');
    }
  });
});

/*
 * The safety block is an ordinary overlay key, so it goes where it lives in the
 * options schema rather than being lifted to the top of the file the way
 * `server` and `account` are. The realm database is not here at all any more:
 * it is a property of the realm, on the realm's own file.
 */
describe('what a character plays against, and what keeps it alive', () => {
  /*
   * `automation.remotes` is the switch that makes a character answer another
   * player's `@` commands, and it is per character on purpose: a pair run
   * together answer each other, and the one being played by hand is left out.
   * So it has to reach that character's own file rather than only the options
   * file everybody inherits.
   */
  it('writes a character’s own answer to `@` commands', () => {
    editor.saveProfile(
      'vaelor',
      draft({ remotes: { enabled: true, gangpath: false, gang: [], party: [], players: {} } })
    );
    const automation = read('vaelor')['automation'] as Record<string, unknown>;
    expect(automation['remotes']).toEqual({
      enabled: true,
      gangpath: false,
      gang: [],
      party: [],
      players: {}
    });
  });

  /*
   * And a character being *created* states it either way, like every other
   * block here: the copy is written whole so that a later change to Global
   * changes what the next character starts with rather than reaching back into
   * this one. That is the whole of "Global is just defaults".
   */
  it('states it on creation even when it answers nobody', () => {
    editor.saveProfile('vaelor', draft());
    const automation = read('vaelor')['automation'] as Record<string, unknown>;
    expect(automation['remotes']).toEqual({
      enabled: false,
      gangpath: false,
      gang: [],
      // Copied from Global, which is where the shipped party list lives. The
      // switch is off, so it grants nobody anything until somebody turns
      // answering on -- which is the point of stating it either way.
      party: [...DEFAULT_CONFIG.automation.remotes.party],
      players: {}
    });
  });

  /*
   * Once stated, kept. Turning it back off has to write `false` rather than
   * deleting the key -- otherwise the inherited value comes straight back and
   * the switch cannot be switched off, which is the trap `saveProfile`'s own
   * comment describes.
   */
  it('keeps the key when it is turned back off', () => {
    editor.saveProfile(
      'vaelor',
      draft({ remotes: { enabled: true, gangpath: false, gang: [], party: [], players: {} } })
    );
    editor.saveProfile(
      'vaelor',
      draft({ remotes: { enabled: false, gangpath: false, gang: [], party: [], players: {} } })
    );
    const automation = read('vaelor')['automation'] as Record<string, unknown>;
    expect(automation['remotes']).toEqual({
      enabled: false,
      gangpath: false,
      gang: [],
      party: [],
      players: {}
    });
  });

  /*
   * The realm database is the realm's, and a character never states one — not
   * even an empty block. Two characters on one realm cannot be walking two
   * different maps, and the key used to be the same answer written out once
   * each with as many places to drift.
   */
  it('writes no realm database into a character at all', () => {
    editor.saveProfile('vaelor', draft());
    expect(read('vaelor')['world']).toBeUndefined();
  });

  /*
   * A character takes a copy of the defaults when it is made, and states it.
   *
   * The blocks used to be written only when they differed from the shipped
   * ones, which made a copy indistinguishable from inheritance — so a change
   * to the Global page reached back into every character already made. Stating
   * them is what "no longer needs those defaults" means.
   */
  it('states the safety block from the moment the character is created', () => {
    editor.saveProfile('vaelor', draft());
    const created = (read('vaelor')['automation'] as Record<string, Record<string, unknown>>)[
      'safety'
    ];
    expect(created?.['hangUp']).toMatchObject({ enabled: false });
    expect(created?.['retreat']).toMatchObject({ enabled: false });

    editor.saveProfile(
      'vaelor',
      draft({
        hangUp: { enabled: true, belowHealth: 0.2, onlyWhenClean: true, onPlayerInRoom: false }
      })
    );
    const safety = (read('vaelor')['automation'] as Record<string, Record<string, unknown>>)[
      'safety'
    ];
    expect(safety?.['hangUp']).toEqual({
      enabled: true,
      belowHealth: 0.2,
      onlyWhenClean: true,
      onPlayerInRoom: false
    });
  });

  /*
   * The half that made the switch unswitchable.
   *
   * A disabled block used to be deleted, which put the character straight back
   * onto whatever it inherited — so a character whose defaults turned running
   * away on could not turn it off, and the form showed it off while the file
   * said on.
   */
  it('keeps saying no once it has said no', () => {
    editor.saveProfile(
      'vaelor',
      draft({
        retreat: {
          enabled: true,
          belowHealth: 0.4,
          whenOutnumbered: 3,
          strategy: 'step-back',
          safeHavenRoom: ''
        }
      })
    );
    editor.saveProfile(
      'vaelor',
      draft({
        retreat: {
          enabled: false,
          belowHealth: 0.4,
          whenOutnumbered: 3,
          strategy: 'step-back',
          safeHavenRoom: ''
        }
      })
    );
    const safety = (read('vaelor')['automation'] as Record<string, Record<string, unknown>>)[
      'safety'
    ];
    expect(safety?.['retreat']).toMatchObject({ enabled: false });
  });

  /* The rules a character already has must survive its safety block changing. */
  it('leaves the character’s own automation rules alone', () => {
    const file = home.profile('vaelor').file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `server: GreaterMUD (local)\nautomation:\n  rules:\n    - when: 'hp < 0.3'\n      do: s\n`,
      'utf8'
    );
    editor.saveProfile(
      'vaelor',
      draft({
        hangUp: { enabled: true, belowHealth: 0.2, onlyWhenClean: true, onPlayerInRoom: false }
      })
    );
    const automation = read('vaelor')['automation'] as Record<string, unknown>;
    expect(automation['rules']).toEqual([{ when: 'hp < 0.3', do: 's' }]);
    expect(automation['safety']).toBeDefined();
  });

  /*
   * A form populated from the character's own file alone would show `false` for
   * a setting switched on globally — which is the opposite of what a profile
   * being an overlay means.
   */
  it('reports the settings a character inherits, not only the ones it states', () => {
    fs.writeFileSync(
      configPath,
      `${OPTIONS}\nautomation:\n  safety:\n    hangUp:\n      enabled: true\n`,
      'utf8'
    );
    // Written by hand rather than saved, because saving copies the defaults
    // into the character's own file — which is the point of a copy at
    // creation, and would make this assertion prove nothing.
    const file = home.profile('vaelor').file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'server: GreaterMUD (local)\n', 'utf8');
    const found = editor.snapshot().characters.find((entry) => entry.id === 'vaelor');
    expect(found?.hangUp.enabled).toBe(true);
  });
});

/*
 * The loops a character walks.
 *
 * Unlike every other block this screen writes, `automation.loops` is a **list**
 * — and `overlay` replaces lists rather than merging them. So the moment a
 * character states its loops it has stepped out of the options file's list for
 * good, and a loop added there afterwards will never reach it. That makes
 * the question "does this differ from what it would inherit" load-bearing
 * rather than tidiness: getting it wrong turns an overlay into a copy on the
 * first save anybody makes for any reason.
 */
describe('the loops a character owns', () => {
  /*
   * `category` is on both because these are compared against loops read back
   * off disk, and `asLoops` derives one for every loop it parses — neither of
   * these names states an area, so both are `UNCATEGORISED`. It is never
   * written to the file; `writes no scope into the file itself` below holds
   * that end.
   */
  const sewers: Loop = {
    name: 'Sewer loop',
    stops: [{ room: 'Sewer Tunnel 1/606' }, { room: 'Sewer Tunnel 1/604' }],
    category: UNCATEGORISED
  };
  const arena: Loop = {
    name: 'Newhaven arena',
    stops: [{ room: 'Newhaven, Arena 1/2150' }, { room: 'Dungeon, Entrance 1/2152', linger: 20 }],
    bounce: true,
    category: UNCATEGORISED
  };

  /** What is in this character's own loops directory, as the client reads it. */
  const owned = (id: string): Loop[] => new LoopStore(home).forProfile(id);

  const file = (id: string, slug: string): string =>
    path.join(home.profile(id).loops, `${slug}.yaml`);

  it('writes one file per loop, beside the character', () => {
    editor.saveProfile('vaelor', draft({ loops: [sewers] }));
    expect(owned('vaelor')).toEqual([sewers]);
    // Named after the loop, so the directory is readable and a file is
    // findable by the name the palette shows.
    expect(fs.existsSync(file('vaelor', 'sewer-loop'))).toBe(true);
    // Spelled the way the template spells a stop, so a loop the screen wrote
    // and one somebody typed look the same in a file they will open.
    expect(fs.readFileSync(file('vaelor', 'sewer-loop'), 'utf8')).toContain(
      "- 'Sewer Tunnel 1/606'"
    );
  });

  /* A stop that waits needs the mapping form; one that does not is the bare
     room name, which is what the template shows and what people type. */
  it('writes a waiting stop and a there-and-back as the file spells them', () => {
    editor.saveProfile('vaelor', draft({ loops: [arena] }));
    expect(parse(fs.readFileSync(file('vaelor', 'newhaven-arena'), 'utf8'))).toEqual({
      name: 'Newhaven arena',
      bounce: true,
      stops: ['Newhaven, Arena 1/2150', { room: 'Dungeon, Entrance 1/2152', linger: 20 }]
    });
  });

  /*
   * Nothing about loops belongs in the character's own file any more: scope is
   * the directory, and a key inside the file could only disagree with it.
   */
  it('puts nothing in the character file', () => {
    editor.saveProfile('vaelor', draft({ loops: [sewers] }));
    const automation = read('vaelor')['automation'] as Record<string, unknown> | undefined;
    expect(automation?.['loops']).toBeUndefined();
  });

  it('removes the file of a loop taken off, keeping a copy', () => {
    editor.saveProfile('vaelor', draft({ loops: [sewers, arena] }));
    editor.saveProfile('vaelor', draft({ loops: [arena] }));
    expect(owned('vaelor').map((loop) => loop.name)).toEqual(['Newhaven arena']);
    expect(fs.existsSync(file('vaelor', 'sewer-loop'))).toBe(false);
    expect(fs.existsSync(`${file('vaelor', 'sewer-loop')}.bak`)).toBe(true);
  });

  /*
   * The global directory is a different scope, so a character walking one of
   * its loops owns nothing -- and saving the character must not copy it in.
   * That is the failure the old shape had: a list replaces rather than merges,
   * so stating one took the character out of everybody's for good.
   */
  it('leaves a loop everybody walks where it is', () => {
    fs.mkdirSync(home.globalLoops, { recursive: true });
    fs.writeFileSync(
      path.join(home.globalLoops, 'sewer-loop.yaml'),
      "name: Sewer loop\nstops:\n  - 'Sewer Tunnel 1/606'\n  - 'Sewer Tunnel 1/604'\n",
      'utf8'
    );
    editor.saveProfile('vaelor', draft({ loops: [] }));
    expect(owned('vaelor')).toEqual([]);
    expect(new LoopStore(home).globalLoops).toEqual([sewers]);
  });

  it('writes something the client can then load, and walk', () => {
    editor.saveProfile('vaelor', draft({ loops: [arena] }));
    const store = new LoopStore(home);
    const result = resolveProfile(
      'vaelor',
      read('vaelor'),
      parse(fs.readFileSync(configPath, 'utf8'))
    );
    if (result.error !== undefined) throw new Error(result.error);
    // The profile itself states none; the tree is what lends it one, which is
    // the join `ProfileStore.loopsFor` makes for the running client.
    expect(result.profile.config.automation.loops).toEqual([]);
    expect(store.forProfile('vaelor')).toEqual([arena]);
  });

  /*
   * The screen shows each scope where it is edited, so it has to be told which
   * is which: what this character owns, and what it merely walks.
   */
  it('reports what a character owns apart from what it inherits', () => {
    fs.mkdirSync(home.globalLoops, { recursive: true });
    fs.writeFileSync(
      path.join(home.globalLoops, 'sewer-loop.yaml'),
      "name: Sewer loop\nstops:\n  - 'Sewer Tunnel 1/606'\n  - 'Sewer Tunnel 1/604'\n",
      'utf8'
    );
    editor.saveProfile('vaelor', draft({ loops: [arena] }));

    const snapshot = editor.snapshot();
    const vaelor = snapshot.characters.find((entry) => entry.id === 'vaelor');
    expect(vaelor?.loops).toEqual([arena]);
    expect(vaelor?.inherited).toEqual([{ loop: sewers, scope: 'global' }]);
    expect(snapshot.loops.global).toEqual([sewers]);
  });

  /* A loop on the server is walked by every character that plays there. */
  it('reports a server\u2019s loops as inherited by the characters on it', () => {
    editor.saveServer(null, {
      name: 'GreaterMUD (local)',
      host: 'gmud-tgs',
      port: 2427,
      encoding: 'cp437',
      login: [],
      loops: [arena],
      database: ''
    });
    editor.saveProfile('vaelor', draft());

    const snapshot = editor.snapshot();
    expect(snapshot.loops.servers['GreaterMUD (local)']).toEqual([arena]);
    expect(snapshot.characters.find((entry) => entry.id === 'vaelor')?.inherited).toEqual([
      { loop: arena, scope: 'server', owner: 'GreaterMUD (local)' }
    ]);
  });
});

/*
 * The Loops modal's own writer. Additive where the settings screen's is a
 * reconcile — the difference is the whole reason it exists, and the test that
 * matters most is the one proving it does not take the neighbours with it.
 */
describe('filing one loop from the Loops modal', () => {
  const sewers: Loop = {
    name: 'Sewer loop',
    stops: [{ room: 'Sewer Tunnel 1/606' }, { room: 'Sewer Tunnel 1/604' }]
  };
  const arena: Loop = {
    name: 'Newhaven arena',
    stops: [{ room: 'Newhaven, Arena 1/2150' }, { room: 'Dungeon, Entrance 1/2152' }]
  };

  const owned = (id: string): Loop[] => new LoopStore(home).forProfile(id);

  /* A loop is filed beside a character that exists; the modal is only ever
     open for one that is on screen. */
  beforeEach(() => {
    editor.saveProfile('vaelor', draft());
  });

  it('puts it beside the character, in its own file', () => {
    expect(editor.addLoop('profile', 'vaelor', sewers)).toEqual({ ok: true });
    expect(owned('vaelor').map((loop) => loop.name)).toEqual(['Sewer loop']);
    expect(fs.existsSync(path.join(home.profile('vaelor').loops, 'sewer-loop.yaml'))).toBe(true);
  });

  /*
   * The failure this writer exists to avoid. `writeLoops` reconciles a whole
   * set and deletes every file whose loop is not in the list it was handed —
   * right for a form showing the complete list, and silently destructive for a
   * modal that has only ever seen one.
   */
  it('leaves every other loop in the scope exactly where it was', () => {
    editor.saveProfile('vaelor', draft({ loops: [arena] }));
    expect(editor.addLoop('profile', 'vaelor', sewers)).toEqual({ ok: true });
    expect(
      owned('vaelor')
        .map((loop) => loop.name)
        .sort()
    ).toEqual(['Newhaven arena', 'Sewer loop']);
  });

  /*
   * A name is how a loop is addressed everywhere in this client, and the modal
   * is deliberately easy to open — a loop already held is exactly the row
   * somebody clicks again to check.
   */
  it('is idempotent by name rather than filing a second copy', () => {
    editor.addLoop('profile', 'vaelor', sewers);
    editor.addLoop('profile', 'vaelor', sewers);
    expect(owned('vaelor')).toHaveLength(1);
    expect(fs.readdirSync(home.profile('vaelor').loops).filter((f) => f.endsWith('.yaml'))).toEqual(
      ['sewer-loop.yaml']
    );
  });

  it('puts a realm loop where every character on that realm reads it', () => {
    editor.saveServer(null, {
      name: 'GreaterMUD (local)',
      host: '127.0.0.1',
      port: 2427,
      encoding: 'cp437',
      login: [],
      loops: [],
      database: ''
    });
    expect(editor.addLoop('server', 'GreaterMUD (local)', sewers)).toEqual({ ok: true });
    const store = new LoopStore(home);
    expect(store.forServer('greatermud-local').map((loop) => loop.name)).toEqual(['Sewer loop']);
    // And not into the character's own, which is a different scope entirely.
    expect(owned('vaelor')).toEqual([]);
  });

  /*
   * Refused out loud rather than defaulted to global: a loop quietly filed
   * where it was not asked for is one every character then walks.
   */
  it('refuses an owner that is not there rather than guessing at one', () => {
    expect(editor.addLoop('profile', 'nobody', sewers).ok).toBe(false);
    expect(editor.addLoop('server', 'No Such Realm', sewers).ok).toBe(false);
    expect(editor.addLoop('profile', null, sewers).ok).toBe(false);
  });

  /* Nothing inside a loop file says which scope it is in — the directory is
     the only thing that decides, which is what makes moving one a move. */
  it('writes no scope into the file itself', () => {
    editor.addLoop('profile', 'vaelor', sewers);
    const written = parse(
      fs.readFileSync(path.join(home.profile('vaelor').loops, 'sewer-loop.yaml'), 'utf8')
    ) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(['name', 'stops']);
  });

  /*
   * `category` is derived from the name by `asLoops`, so writing it back would
   * be a value the client invented appearing in a file the user owns and then
   * has to keep in step with a name they are free to edit.
   */
  it("does not write the derived category into the user's file", () => {
    editor.addLoop('profile', 'vaelor', { ...sewers, category: 'Sewers' });
    const written = fs.readFileSync(
      path.join(home.profile('vaelor').loops, 'sewer-loop.yaml'),
      'utf8'
    );
    expect(written).not.toContain('category');
  });
});

describe('a character theme', () => {
  it('writes ui.theme, clears one the form showed, and leaves one it could not', () => {
    const file = home.profile('vaelor').file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `server: GreaterMUD (local)\n`, 'utf8');
    expect(editor.saveProfile('vaelor', draft({ theme: 'nord' }))).toEqual({ ok: true });
    expect((read('vaelor')['ui'] as Record<string, unknown>)['theme']).toBe('nord');
    expect(editor.saveProfile('vaelor', draft({ theme: '' }))).toEqual({ ok: true });
    expect(read('vaelor')['ui']).toBeUndefined();
    fs.writeFileSync(file, `server: GreaterMUD (local)\nui:\n  theme: slate\n`, 'utf8');
    expect(editor.saveProfile('vaelor', draft({ theme: '' }))).toEqual({ ok: true });
    expect((read('vaelor')['ui'] as Record<string, unknown>)['theme']).toBe('slate');
  });
});

/*
 * The options file everything is inherited from. Read whole rather than
 * sparsely -- this *is* what is inherited, so a field it does not state is one
 * the built-in default decides, and the form should show what the client would
 * actually do.
 */
describe('the client\u2019s own settings', () => {
  const WITH_NOTES = `# The user's own notes, which they wrote.
connection:
  host: gmud-tgs
  port: 2427
`;

  const global = (): GlobalDraft => editor.globalDraft();

  it('reads what the file says, with the shipped defaults behind it', () => {
    const draft = global();
    expect(draft.connection.host).toBe('gmud-tgs');
    expect(draft.connection.port).toBe(2427);
    // Not in OPTIONS at all, so the default answers -- which is the point.
    expect(draft.terminal.fontSize).toBe(DEFAULT_CONFIG.terminal.font.size);
  });

  it('writes a change and keeps the comments around it', () => {
    const draft = global();
    draft.terminal.fontSize = 18;
    draft.ui.density = 'compact';
    expect(editor.saveGlobal(draft)).toEqual({ ok: true });

    const written = parse(fs.readFileSync(configPath, 'utf8'));
    expect(written['terminal']['font']['size']).toBe(18);
    expect(written['ui']['density']).toBe('compact');
    expect(fs.readFileSync(configPath, 'utf8')).toContain("# The user's own notes");
  });

  /*
   * The options file holds no account and no autoconnect of its own: both
   * belong to a character, and the anonymous session that once spent them from
   * here was retired 2026-08-29. A save must not write the keys back.
   */
  it('writes no account and no autoconnect into the options file', () => {
    fs.writeFileSync(configPath, WITH_NOTES, 'utf8');
    const draft = global();
    draft.terminal.fontSize = 18;
    expect(editor.saveGlobal(draft)).toEqual({ ok: true });

    const written = parse(fs.readFileSync(configPath, 'utf8'));
    expect(written['connection']['autoConnect']).toBeUndefined();
    expect(written['connection']['login']?.['username']).toBeUndefined();
    expect(written['connection']['login']?.['password']).toBeUndefined();
    expect(written['connection']['login']?.['enabled']).toBeUndefined();
  });

  /* The loops everybody walks are files, like every other loop. */
  it('writes the global loops beside the options file', () => {
    const draft = global();
    draft.loops = [{ name: 'Newhaven arena', stops: [{ room: 'A' }, { room: 'B' }] }];
    expect(editor.saveGlobal(draft)).toEqual({ ok: true });
    expect(new LoopStore(home).globalLoops.map((loop) => loop.name)).toEqual(['Newhaven arena']);
    expect(parse(fs.readFileSync(configPath, 'utf8'))['automation']?.['loops']).toBeUndefined();
  });

  /* A file this screen could write and the client could not load would be
     worse than a refused save: the watcher picks it up and every character
     quietly starts running under settings nobody chose. */
  it('is read back through the resolver the client uses', () => {
    const draft = global();
    draft.connection.host = 'somewhere-else';
    editor.saveGlobal(draft);
    expect(normalizeConfig(parse(fs.readFileSync(configPath, 'utf8'))).connection.host).toBe(
      'somewhere-else'
    );
  });
});

/**
 * Allowing or blocking one player, from the Player flyout.
 *
 * The only path that edits a file the user owns from a *card* rather than a
 * form, so it carries the risks a form does not: it knows one name and nothing
 * about the rest of that character's settings, and it must not be able to
 * revert anything it never showed.
 */
describe('one player’s @ command permissions', () => {
  const remotesOf = (id: string): Record<string, unknown> => {
    const automation = read(id)['automation'] as Record<string, unknown>;
    return automation['remotes'] as Record<string, unknown>;
  };
  const grantsOf = (id: string): Record<string, { allow: string[]; deny: string[] }> =>
    (remotesOf(id)['players'] ?? {}) as Record<string, { allow: string[]; deny: string[] }>;

  beforeEach(() => {
    editor.saveProfile(
      'vaelor',
      draft({ remotes: { enabled: true, gangpath: false, gang: [], party: [], players: {} } })
    );
  });

  it('writes what one player may ask for, under a lower-cased key', () => {
    expect(editor.setRemoteGrant('vaelor', 'Soul', { allow: ['health'], deny: [] }).ok).toBe(true);
    expect(grantsOf('vaelor')).toEqual({ soul: { allow: ['health'], deny: [] } });
  });

  /*
   * The map this writes into is usually the empty `players: {}` a profile save
   * wrote, and `{}` is a *flow* collection — every node set inside it inherits
   * that, and the result was one line of
   * `players: { soul: { allow: [ health ] } }` in a file where every other list
   * is a block. It is the user's file and it is read by people.
   */
  it('writes it in block style, like every other list in the file', () => {
    editor.setRemoteGrant('vaelor', 'Soul', { allow: ['health'], deny: [] });
    const text = fs.readFileSync(home.profile('vaelor').file, 'utf8');
    expect(text).toMatch(/players:\n\s+soul:\n\s+allow:\n\s+- health/);
  });

  it('writes a deny beside it', () => {
    editor.setRemoteGrant('vaelor', 'Rend', { allow: ['health'], deny: ['do'] });
    expect(grantsOf('vaelor')['rend']).toEqual({ allow: ['health'], deny: ['do'] });
  });

  /*
   * A remote on both lists is a contradiction the reader would have to know the
   * precedence rule to resolve, and a permission screen needing a rule
   * explained is one people get wrong. Deny wins, so the allow is dropped.
   */
  it('puts a remote on exactly one list', () => {
    editor.setRemoteGrant('vaelor', 'Soul', { allow: ['health', 'do'], deny: ['do'] });
    expect(grantsOf('vaelor')['soul']).toEqual({ allow: ['health'], deny: ['do'] });
  });

  it('states one remote once however many times the payload says it', () => {
    editor.setRemoteGrant('vaelor', 'Soul', { allow: ['health', 'health'], deny: [] });
    expect(grantsOf('vaelor')['soul']!.allow).toEqual(['health']);
  });

  /*
   * A `players:` map that accumulated a key per person anybody ever clicked
   * would grow without bound and would read, in the user's own file, as a list
   * of people with permissions when it holds people with none.
   */
  it('removes an emptied grant, and the map with the last one', () => {
    editor.setRemoteGrant('vaelor', 'Soul', { allow: ['health'], deny: [] });
    editor.setRemoteGrant('vaelor', 'Soul', { allow: [], deny: [] });
    expect(remotesOf('vaelor')['players']).toBeUndefined();
  });

  it('keeps the other names when one is emptied', () => {
    editor.setRemoteGrant('vaelor', 'Soul', { allow: ['health'], deny: [] });
    editor.setRemoteGrant('vaelor', 'Yang', { allow: ['where'], deny: [] });
    editor.setRemoteGrant('vaelor', 'Soul', { allow: [], deny: [] });
    expect(grantsOf('vaelor')).toEqual({ yang: { allow: ['where'], deny: [] } });
  });

  it('matches a name however it is capitalised', () => {
    editor.setRemoteGrant('vaelor', 'Soul', { allow: ['health'], deny: [] });
    editor.setRemoteGrant('vaelor', 'SOUL', { allow: ['where'], deny: [] });
    expect(grantsOf('vaelor')).toEqual({ soul: { allow: ['where'], deny: [] } });
  });

  it('is idempotent — clicking the same thing twice writes it once', () => {
    editor.setRemoteGrant('vaelor', 'Soul', { allow: ['health'], deny: [] });
    const after = fs.readFileSync(home.profile('vaelor').file, 'utf8');
    editor.setRemoteGrant('vaelor', 'Soul', { allow: ['health'], deny: [] });
    expect(fs.readFileSync(home.profile('vaelor').file, 'utf8')).toBe(after);
  });

  /*
   * Most profiles are sparse overlays, so the block this writes into is one the
   * file frequently does not have.
   */
  it('creates the block in a profile that has no automation section', () => {
    const scope = home.profile('sparse');
    fs.mkdirSync(scope.dir, { recursive: true });
    fs.writeFileSync(scope.file, 'name: Sparse\n', 'utf8');
    expect(editor.setRemoteGrant('sparse', 'Soul', { allow: ['do'], deny: [] }).ok).toBe(true);
    expect(grantsOf('sparse')['soul']!.allow).toEqual(['do']);
  });

  it('keeps the comments, which are the user’s own', () => {
    const scope = home.profile('noted');
    fs.mkdirSync(scope.dir, { recursive: true });
    fs.writeFileSync(scope.file, '# Mine, and I wrote it.\nname: Noted\n', 'utf8');
    editor.setRemoteGrant('noted', 'Soul', { allow: ['health'], deny: [] });
    expect(fs.readFileSync(scope.file, 'utf8')).toContain('# Mine, and I wrote it.');
  });

  it('refuses a character that does not exist rather than creating one', () => {
    const result = editor.setRemoteGrant('nobody-at-all', 'Soul', { allow: ['health'], deny: [] });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(home.profile('nobody-at-all').file)).toBe(false);
  });

  it('refuses an empty name', () => {
    expect(editor.setRemoteGrant('vaelor', '   ', { allow: ['health'], deny: [] }).ok).toBe(false);
  });

  /*
   * The flyout knows one name. Everything else on that character must survive
   * it untouched, or a click on a card would revert what somebody set in
   * Settings.
   */
  it('leaves every other setting on the character alone', () => {
    const before = read('vaelor');
    editor.setRemoteGrant('vaelor', 'Soul', { allow: ['health'], deny: [] });
    const after = read('vaelor');
    expect(after['name']).toEqual(before['name']);
    expect(after['server']).toEqual(before['server']);
    expect(after['account']).toEqual(before['account']);
    expect((after['automation'] as Record<string, unknown>)['combat']).toEqual(
      (before['automation'] as Record<string, unknown>)['combat']
    );
  });
});

describe('the gang list and the gangpath switch', () => {
  const remotesOf = (id: string): Record<string, unknown> => {
    const automation = read(id)['automation'] as Record<string, unknown>;
    return automation['remotes'] as Record<string, unknown>;
  };

  beforeEach(() => {
    editor.saveProfile(
      'vaelor',
      draft({ remotes: { enabled: true, gangpath: false, gang: [], party: [], players: {} } })
    );
  });

  it('writes the whole gang list', () => {
    expect(editor.setGangRemotes('vaelor', ['health', 'where']).ok).toBe(true);
    expect(remotesOf('vaelor')['gang']).toEqual(['health', 'where']);
  });

  it('replaces it rather than adding to it, so clearing actually clears', () => {
    editor.setGangRemotes('vaelor', ['health', 'where']);
    editor.setGangRemotes('vaelor', []);
    expect(remotesOf('vaelor')['gang']).toEqual([]);
  });

  it('states one remote once', () => {
    editor.setGangRemotes('vaelor', ['health', 'health']);
    expect(remotesOf('vaelor')['gang']).toEqual(['health']);
  });

  it('turns the gangpath on and off', () => {
    expect(editor.setRemoteGangpath('vaelor', true).ok).toBe(true);
    expect(remotesOf('vaelor')['gangpath']).toBe(true);
    editor.setRemoteGangpath('vaelor', false);
    expect(remotesOf('vaelor')['gangpath']).toBe(false);
  });

  it('refuses a character that does not exist', () => {
    expect(editor.setGangRemotes('nobody-at-all', ['health']).ok).toBe(false);
    expect(editor.setRemoteGangpath('nobody-at-all', true).ok).toBe(false);
  });

  it('leaves the per-player grants alone', () => {
    editor.setRemoteGrant('vaelor', 'Soul', { allow: ['do'], deny: [] });
    editor.setGangRemotes('vaelor', ['health']);
    const players = remotesOf('vaelor')['players'] as Record<string, unknown>;
    expect(players['soul']).toEqual({ allow: ['do'], deny: [] });
  });
});

/*
 * The spell pickers' data, through the injected provider — the seam
 * `index.ts` fills with the belongings record and the realm. Constructed
 * without one, the snapshot answers the honest absences; constructed with
 * one, it is asked with the character's *resolved* target, because the book
 * is keyed by the address dialled.
 */
describe('what the spell pickers are offered', () => {
  it('answers the honest absences with no provider', () => {
    editor.saveProfile('vaelor', draft());
    const snapshot = editor.snapshot();
    const found = snapshot.characters.find((entry) => entry.id === 'vaelor');
    expect(found?.spellbook).toBeNull();
    expect(found?.cureGates).toBeNull();
    expect(snapshot.realmSpells).toEqual([]);
  });

  it("carries the provider's answers, asked with the resolved target", () => {
    editor.saveProfile('vaelor', draft());
    const asked: Array<{ id: string; host: string; port: number }> = [];
    const provided = new SettingsEditor({
      home,
      spells: {
        forProfile: (id, target) => {
          asked.push({ id, host: target.host, port: target.port });
          return {
            spellbook: [{ name: 'way of the swan', short: 'swan', targeting: 'self' as const }],
            cureGates: { poison: true, blindness: false, disease: false }
          };
        },
        realm: () => [{ name: 'minor healing', short: 'mihe', targeting: 'friendly' as const }]
      }
    });
    const snapshot = provided.snapshot();
    const found = snapshot.characters.find((entry) => entry.id === 'vaelor');
    expect(found?.spellbook).toEqual([
      { name: 'way of the swan', short: 'swan', targeting: 'self' }
    ]);
    expect(found?.cureGates).toEqual({ poison: true, blindness: false, disease: false });
    expect(snapshot.realmSpells).toEqual([
      { name: 'minor healing', short: 'mihe', targeting: 'friendly' }
    ]);
    // The saved server's own address, resolved — not a blank or the default.
    expect(asked).toContainEqual({ id: 'vaelor', host: 'gmud-tgs', port: 2427 });
  });
});

describe('the supplies list', () => {
  const suppliesOf = (id: string): unknown =>
    (read(id)['automation'] as Record<string, unknown> | undefined)?.['supplies'];

  it('writes the whole list, one flow row per item, with the room where one was chosen', () => {
    editor.saveProfile('vaelor', draft());
    expect(
      editor.setSupplies('vaelor', [
        { name: 'torch', min: 3, max: 7, shop: 'General Store', at: { map: 1, room: 2147 } },
        { name: 'lantern', min: 1, max: 1, shop: 'Slum Store', at: null }
      ]).ok
    ).toBe(true);
    expect(suppliesOf('vaelor')).toEqual({
      items: [
        { name: 'torch', min: 3, max: 7, shop: 'General Store', at: { map: 1, room: 2147 } },
        { name: 'lantern', min: 1, max: 1, shop: 'Slum Store' }
      ]
    });
    const text = fs.readFileSync(home.profile('vaelor').file, 'utf8');
    // Flow rows, so a hand-read file says one item per line where it fits.
    expect(text).toContain('- { name: lantern, min: 1, max: 1, shop: Slum Store }');
    expect(text).toContain('at: { map: 1, room: 2147 }');
    // The file still loads as the client would load it.
    expect(resolveProfile('vaelor', read('vaelor'), parse(OPTIONS)).error).toBeUndefined();
  });

  it('replaces rather than adds, so clearing clears', () => {
    editor.saveProfile('vaelor', draft());
    editor.setSupplies('vaelor', [{ name: 'torch', min: 3, max: 7, shop: '', at: null }]);
    editor.setSupplies('vaelor', []);
    expect(suppliesOf('vaelor')).toEqual({ items: [] });
  });

  it('refuses a character that does not exist', () => {
    expect(editor.setSupplies('nobody-at-all', []).ok).toBe(false);
  });
});
