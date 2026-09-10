import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

import { migrateHome } from '../Migration';
import { LoopStore } from '../LoopStore';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { ServerStore } from '../ServerStore';
import { homeAt, type Home } from '../../app/home';
import { ACTIONABLE_REMOTES } from '../../../shared/remotes';
import { DEFAULT_CONFIG } from '../../../shared/config';
import type { Loop } from '../../../shared/loops';

let dir = '';
let old = '';
let home: Home;
let said: string[] = [];

const OPTIONS = `# The user's own notes, which they wrote.
connection:
  host: orohost
  port: 2427

servers:
  # Added by the server itself on 2026-08-27.
  - name: GreaterMUD (local)
    host: orohost
    port: 2427
    encoding: cp437
  - name: Bearfather
    host: bbs.bearfather.net
    port: 23

automation:
  # The sewers: the lairs a level 6 can reach.
  loops:
    - name: Sewer loop
      stops:
        - 'Sewer Tunnel 1/606'
        - 'Sewer Tunnel 1/604'
`;

function migrate(withTemplate = false): void {
  said = [];
  migrateHome({
    home,
    legacyOptions: [path.join(old, 'user.yaml')],
    // Off by default so the sparse-overlay cases below are read as themselves;
    // the two that are about the template ask for it by name.
    template: withTemplate ? path.resolve('resources/config/default.yaml') : undefined,
    internalTemplate: withTemplate ? path.resolve('resources/config/internal.yaml') : undefined,
    note: (m) => said.push(m)
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-home-'));
  home = homeAt(path.join(dir, 'home'));
  old = path.join(dir, 'old');
  fs.mkdirSync(old, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('bringing an older layout across', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(old, 'user.yaml'), OPTIONS, 'utf8');
    fs.mkdirSync(path.join(old, 'profiles'), { recursive: true });
    fs.writeFileSync(
      path.join(old, 'profiles', 'vaelor.yaml'),
      "# my main\nserver: GreaterMUD (local)\nautomation:\n  loops:\n    - name: Arena\n      stops:\n        - 'Newhaven, Arena 1/2150'\n        - 'Newhaven, Narrow Road 1/2146'\n",
      'utf8'
    );
    fs.mkdirSync(path.join(old, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(old, 'memory', 'vaelor.json'), '{}', 'utf8');
  });

  it('moves the options file, the characters and the records with it', () => {
    migrate();
    expect(fs.existsSync(home.options)).toBe(true);
    expect(fs.existsSync(home.profile('vaelor').file)).toBe(true);
    expect(fs.existsSync(home.state('memory', 'vaelor.json'))).toBe(true);
    // And leaves nothing behind to be found again by a later launch.
    expect(fs.existsSync(path.join(old, 'user.yaml'))).toBe(false);
  });

  it('keeps the comments, which are the documentation', () => {
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toContain("# The user's own notes");
    expect(fs.readFileSync(home.profile('vaelor').file, 'utf8')).toContain('# my main');
  });

  /*
   * A server acquired a login script and loops of its own, and neither fits in
   * a list inside a global file -- see `ServerStore`.
   */
  it('gives every server its own directory', () => {
    migrate();
    expect(new ServerStore(home).all.map((entry) => entry.id).sort()).toEqual([
      'bearfather',
      'greatermud-local'
    ]);
    expect(parse(fs.readFileSync(home.options, 'utf8'))['servers']).toBeUndefined();
  });

  /*
   * Comments travel with the node, not with the file -- and `yaml` files a note
   * above `loops:` on the *key* and one above the first `- name:` on the
   * *sequence*, which look identical in the file. Both have to come.
   */
  it('carries a comment written inside the block it moved', () => {
    migrate();
    const text = fs.readFileSync(home.server('greatermud-local').file, 'utf8');
    expect(text).toContain('# Added by the server itself');
  });

  it('carries the note somebody wrote above the block itself', () => {
    migrate();
    const loops = fs.readdirSync(home.globalLoops);
    const text = fs.readFileSync(path.join(home.globalLoops, loops[0]!), 'utf8');
    expect(text).toContain('# The sewers: the lairs a level 6 can reach.');
  });

  it('files each loop where its scope says it belongs', () => {
    migrate();
    const loops = new LoopStore(home);
    expect(loops.globalLoops.map((loop) => loop.name)).toEqual(['Sewer loop']);
    expect(loops.forProfile('vaelor').map((loop) => loop.name)).toEqual(['Arena']);
    expect(
      parse(fs.readFileSync(home.profile('vaelor').file, 'utf8'))['automation']
    ).toBeUndefined();
  });

  it('says what it did, and never what is inside', () => {
    migrate();
    expect(said.join('\n')).toContain(home.options);
    expect(said.join('\n')).toMatch(/2 realms moved/);
    expect(said.join('\n')).not.toContain('orohost');
  });

  /* Interrupted halfway, it finishes; run twice, it does nothing the second
     time. Both are the same property: every step checks its destination. */
  it('is safe to run again', () => {
    migrate();
    const before = fs.readFileSync(home.options, 'utf8');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toBe(before);
    expect(said).toEqual([]);
    expect(new ServerStore(home).all).toHaveLength(2);
  });

  it('leaves an options file already in the new place alone', () => {
    fs.mkdirSync(home.globalDir, { recursive: true });
    fs.writeFileSync(home.options, 'connection:\n  host: elsewhere\n', 'utf8');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toContain('elsewhere');
    // The older file is a leftover, not the truth, and is left where it is.
    expect(fs.existsSync(path.join(old, 'user.yaml'))).toBe(true);
  });
});

/*
 * The old layout kept the live files in the same directory as the shipped
 * templates -- `internal.yaml` was both -- so "move everything beside the
 * options file" once carried a repository file off with somebody's characters.
 */
describe('the shipped templates', () => {
  it('are left where they are', () => {
    const template = path.join(old, 'internal.yaml');
    fs.writeFileSync(path.join(old, 'user.yaml'), 'connection:\n  host: orohost\n', 'utf8');
    fs.writeFileSync(template, 'palette:\n  pinned: []\n', 'utf8');
    said = [];
    migrateHome({
      home,
      legacyOptions: [path.join(old, 'user.yaml')],
      keep: [template],
      note: (m) => said.push(m)
    });
    expect(fs.existsSync(template)).toBe(true);
    expect(fs.existsSync(home.internal)).toBe(false);
  });
});

describe('a file that will not parse', () => {
  it('is left exactly as it is', () => {
    fs.writeFileSync(path.join(old, 'user.yaml'), 'servers: [unclosed\n', 'utf8');
    migrate();
    // Moved -- it is still the options file -- but never rewritten: it is
    // somebody's only copy, and rebuilding it from the parts that did parse
    // would discard the rest without asking.
    expect(fs.readFileSync(home.options, 'utf8')).toBe('servers: [unclosed\n');
  });
});

describe('nothing to bring across', () => {
  it('does nothing at all, quietly', () => {
    migrate();
    expect(said).toEqual([]);
    expect(fs.existsSync(home.options)).toBe(false);
  });
});

/*
 * The thresholds that stood a character up, and the command with them.
 *
 * `l` does not break a rest, so the threshold that sent one on reaching it
 * proposed the same look at every status line that answered the last —
 * 431 of them in fourteen seconds, live, on 2026-08-27.
 */
describe('the "stand up at" health thresholds', () => {
  const OPTIONS_WITH = `automation:
  # Rest below 60%, stand at 95%.
  health:
    restBelow: 0.6
    restUntil: 0.95
    meditateBelow: 0.3
    meditateUntil: 0.9
`;

  beforeEach(() => {
    fs.mkdirSync(home.globalDir, { recursive: true });
    fs.writeFileSync(home.options, OPTIONS_WITH, 'utf8');
  });

  it('go from the options file, leaving the two that still mean something', () => {
    migrate();
    expect(parse(fs.readFileSync(home.options, 'utf8')).automation.health).toEqual({
      restBelow: 0.6,
      // Written by `statedTheRestCeiling` in the same run, at the default that
      // changes nothing — and deliberately *not* what the stand-up thresholds
      // this test removes used to mean. See `HealthConfig`.
      restTo: 0,
      // And by `statedTheTrapRest`, at the shipped figure.
      restBeforeTraps: 0.45,
      meditateBelow: 0.3
    });
  });

  it('go from every character too', () => {
    const scope = home.profile('main');
    fs.mkdirSync(scope.dir, { recursive: true });
    fs.writeFileSync(scope.file, 'automation:\n  health:\n    restUntil: 0.9\n', 'utf8');
    migrate();
    // The block held nothing else, so it goes rather than sitting there empty
    // and reading as a setting somebody meant to fill in.
    expect(parse(fs.readFileSync(scope.file, 'utf8')).automation).toEqual({});
  });

  it('keep the comments, which are the documentation', () => {
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toContain('# Rest below 60%, stand at 95%.');
  });

  it('say so, naming files and no values', () => {
    migrate();
    const said_ = said.join('\n');
    expect(said_).toMatch(/stand up at/i);
    expect(said_).toContain(home.options);
    expect(said_).not.toContain('0.95');
  });

  it('is safe to run again', () => {
    migrate();
    const after = fs.readFileSync(home.options, 'utf8');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toBe(after);
    expect(said.join('\n')).not.toMatch(/stand up at/i);
  });

  it('leaves a file that never had them alone', () => {
    fs.writeFileSync(home.options, 'automation:\n  health:\n    restBelow: 0.6\n', 'utf8');
    migrate();
    expect(said.join('\n')).not.toMatch(/stand up at/i);
  });
});

/*
 * The round combat macro, and the belief that produced it.
 *
 * `automation.combat.rounds` sent one verb a round for "the classes that have
 * to ask for their attack each round". No class does: captures/032 is a mystic
 * opening on a night hag with one `bs ha` and then jumpkicking it for 94 lines
 * with nothing else typed, and MegaMUD's own help puts `pu`, `kic` and `ju` in
 * its single Attack Command. Every verb the setting sent was a command spent
 * to be answered by nothing.
 */
describe('the round combat macro', () => {
  const OPTIONS_WITH = `automation:
  # Fighting for you, rather than keeping you alive.
  combat:
    attack: a
    rounds: [kic, pu]
    engage: hostile
`;

  beforeEach(() => {
    fs.mkdirSync(home.globalDir, { recursive: true });
    fs.writeFileSync(home.options, OPTIONS_WITH, 'utf8');
  });

  it('goes from the options file, leaving the rest of the block', () => {
    migrate();
    expect(parse(fs.readFileSync(home.options, 'utf8')).automation.combat).toEqual({
      attack: 'a',
      engage: 'hostile',
      // Written by `statedTheEntityPredicates` in the same run, after this
      // step, at the defaults that change nothing.
      avoidUndead: false,
      avoidDeathSpell: false,
      maxTargetHealth: 0,
      minMobs: 0,
      maxMonsterExperience: 0
    });
  });

  it('goes from every character too', () => {
    const scope = home.profile('main');
    fs.mkdirSync(scope.dir, { recursive: true });
    fs.writeFileSync(scope.file, 'automation:\n  combat:\n    rounds: [bash]\n', 'utf8');
    migrate();
    // The block held nothing else, so it goes rather than sitting there empty
    // and reading as a setting somebody meant to fill in.
    expect(parse(fs.readFileSync(scope.file, 'utf8')).automation).toEqual({});
  });

  it('keeps the comments, which are the documentation', () => {
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toContain(
      '# Fighting for you, rather than keeping you alive.'
    );
  });

  it('says so, naming files and no values', () => {
    migrate();
    const said_ = said.join('\n');
    expect(said_).toMatch(/round combat macro/i);
    expect(said_).toContain(home.options);
    expect(said_).not.toContain('kic');
  });

  it('is safe to run again', () => {
    migrate();
    const after = fs.readFileSync(home.options, 'utf8');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toBe(after);
    expect(said.join('\n')).not.toMatch(/round combat macro/i);
  });

  it('leaves a file that never had it alone', () => {
    fs.writeFileSync(home.options, 'automation:\n  combat:\n    attack: a\n', 'utf8');
    migrate();
    expect(said.join('\n')).not.toMatch(/round combat macro/i);
  });
});

/**
 * `ui.showDiagnostics` had to go with the setting itself.
 *
 * The cards are a tool reached for when the wire looks wrong, not part of how
 * a player has arranged their instrument — so they start hidden every launch
 * and the palette toggle lasts only as long as the window. A key left in the
 * file would be a value no screen can edit and no code can read, which is a
 * setting somebody changes and then waits to see work.
 */
/*
 * The client's own mark, stated in an options file that predates it.
 *
 * `reconcileWithTemplate` brings a whole absent top-level block across and
 * deliberately never reaches inside one, so a key added to `ui:` afterwards
 * reaches nobody who has already run the client. `normalizeConfig` still
 * defaults it — the mark is drawn either way — but a setting absent from the
 * file is one nobody reading the file can find.
 */
describe('the mark in the status rail', () => {
  beforeEach(() => {
    fs.mkdirSync(home.globalDir, { recursive: true });
  });

  it('is stated beside the other piece of chrome it is a question about', () => {
    fs.writeFileSync(home.options, 'ui:\n  showHud: true\n  density: auto\n', 'utf8');
    migrate();
    const text = fs.readFileSync(home.options, 'utf8');
    expect((parse(text).ui as Record<string, unknown>)['showLogo']).toBe(true);
    // Beside `showHud`, not appended after the density: the two are the same
    // question asked about two pieces of chrome.
    expect(text.indexOf('showLogo')).toBeGreaterThan(text.indexOf('showHud'));
    expect(text.indexOf('showLogo')).toBeLessThan(text.indexOf('density'));
  });

  it('brings the paragraph that explains it, because the file is the documentation', () => {
    fs.writeFileSync(home.options, 'ui:\n  showHud: true\n', 'utf8');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toMatch(/status rail/i);
  });

  it('leaves a file that already states it alone, however it was answered', () => {
    fs.writeFileSync(home.options, 'ui:\n  showHud: true\n  showLogo: false\n', 'utf8');
    migrate();
    migrate();
    expect(
      (parse(fs.readFileSync(home.options, 'utf8')).ui as Record<string, unknown>)['showLogo']
    ).toBe(false);
  });

  /*
   * The options file only. It is a fact about the client rather than about a
   * character, and writing it into every profile would put a per-character
   * override in front of somebody who never asked for one.
   */
  it('does not write itself into a character', () => {
    fs.writeFileSync(home.options, 'ui:\n  showHud: true\n', 'utf8');
    const scope = home.profile('main');
    fs.mkdirSync(scope.dir, { recursive: true });
    fs.writeFileSync(scope.file, 'ui:\n  theme: dark\n', 'utf8');
    migrate();
    expect(
      (parse(fs.readFileSync(scope.file, 'utf8')).ui as Record<string, unknown>)['showLogo']
    ).toBeUndefined();
  });

  /*
   * A file with no `ui:` block at all is `reconcileWithTemplate`'s job, not
   * this one's: it copies the whole block across with its comments, and a key
   * written here first would be a second, comment-less `ui:` for it to find.
   */
  it('leaves a file with no ui block for the template to fill in', () => {
    fs.writeFileSync(home.options, 'terminal:\n  scrollback: 100\n', 'utf8');
    migrate();
    expect(parse(fs.readFileSync(home.options, 'utf8')).ui).toBeUndefined();
  });
});

/*
 * `ui.console`, 2026-09-07 (todo 03).
 *
 * A whole block inside `ui:`, which `reconcileWithTemplate` will not reach —
 * it fills in an absent top-level block and never goes inside one. Without
 * this the console under a light theme goes light with the chrome and nothing
 * in the file names the setting that decided so.
 */
/*
 * Opening and bashing doors, turned on where the client had written them off
 * (2026-09-07, todo 06).
 *
 * The one migration here that moves an answer rather than adding a missing one,
 * and only because `statedDoorForcing` is where the answer came from: it wrote
 * both keys into every file at the shipped default, so a flipped default alone
 * would reach nobody.
 */
describe('doors opening by default', () => {
  const movement = (body: string): string => `automation:\n  movement:\n${body}`;

  beforeEach(() => {
    fs.mkdirSync(home.globalDir, { recursive: true });
  });

  it('moves the two the client wrote, and not the lock-pick', () => {
    fs.writeFileSync(
      home.options,
      movement('    openDoors: false\n    bashDoors: false\n    pickLocks: false\n'),
      'utf8'
    );
    migrate();
    const parsed = parse(fs.readFileSync(home.options, 'utf8')) as Record<string, unknown>;
    const after = (parsed['automation'] as Record<string, unknown>)['movement'] as Record<
      string,
      unknown
    >;
    expect(after['openDoors']).toBe(true);
    expect(after['bashDoors']).toBe(true);
    // The same decision made with a skill the client cannot check for.
    expect(after['pickLocks']).toBe(false);
  });

  it("reaches a character's own file, not only the options", () => {
    const file = path.join(home.profilesDir, 'vaelor', 'profile.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, movement('    bashDoors: false\n'), 'utf8');
    migrate();
    const parsed = parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(
      ((parsed['automation'] as Record<string, unknown>)['movement'] as Record<string, unknown>)[
        'bashDoors'
      ]
    ).toBe(true);
  });

  it('states nothing a file was silent about', () => {
    /*
     * Absence already inherits the new default; writing the key in would be
     * this migration *stating* a setting rather than moving one. Asserted on
     * `openDoors`, which no other migration writes — `statedDoorForcing` above
     * legitimately states `bashDoors` and `pickLocks` where they are missing,
     * and this one then finds the `false` it wrote and moves it, which is the
     * same sequence a real file went through.
     */
    fs.writeFileSync(
      home.options,
      movement('    openTries: 1\n    pickLocks: false\n    pickTries: 3\n'),
      'utf8'
    );
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).not.toContain('openDoors');
  });

  it('cannot undo a later switch-off, and has nothing to say twice', () => {
    /*
     * Every door key stated, so `statedDoorForcing` — which runs before this
     * and legitimately writes the two it is missing at the value it shipped —
     * has nothing to add and cannot hand this one a `false` to move.
     */
    const stated = (open: boolean): string =>
      movement(
        `    openDoors: ${open}\n    openTries: 1\n` +
          '    pickLocks: false\n    pickTries: 3\n    bashDoors: true\n    bashTries: 3\n'
      );
    fs.writeFileSync(home.options, stated(false), 'utf8');
    migrate();
    // What somebody does afterwards is theirs: only `false` moves, so a file
    // switched back off by hand is left exactly as it was found.
    fs.writeFileSync(home.options, stated(true), 'utf8');
    migrate();
    const parsed = parse(fs.readFileSync(home.options, 'utf8')) as Record<string, unknown>;
    expect(
      ((parsed['automation'] as Record<string, unknown>)['movement'] as Record<string, unknown>)[
        'openDoors'
      ]
    ).toBe(true);
    expect(said.join(' ')).not.toMatch(/were turned on in/);
  });

  it('says so, and names the file', () => {
    fs.writeFileSync(home.options, movement('    openDoors: false\n'), 'utf8');
    migrate();
    expect(said.join(' ')).toMatch(/on by default/i);
    expect(said.join(' ')).toContain(home.options);
  });
});

/*
 * `ui.alerts.finds`, 2026-09-07 (todo 04).
 *
 * Two levels inside `ui:`, so `reconcileWithTemplate` reaches neither it nor
 * the block above it. Written off, which is what the client does without it.
 */
describe('what a find is worth interrupting for', () => {
  beforeEach(() => {
    fs.mkdirSync(home.globalDir, { recursive: true });
  });

  const alertsIn = (text: string): Record<string, unknown> =>
    ((parse(text).ui as Record<string, unknown>)['alerts'] as Record<string, unknown>) ?? {};

  it('is stated off, beside the floor and the mute list', () => {
    fs.writeFileSync(home.options, 'ui:\n  alerts:\n    minimum: info\n    mute: []\n', 'utf8');
    migrate();
    expect(alertsIn(fs.readFileSync(home.options, 'utf8'))['finds']).toEqual({
      items: [],
      cashOverCopper: 0
    });
  });

  it("brings the template's own paragraph", () => {
    fs.writeFileSync(home.options, 'ui:\n  alerts:\n    minimum: info\n', 'utf8');
    migrate(true);
    expect(fs.readFileSync(home.options, 'utf8')).toMatch(/worth interrupting for/);
  });

  it('leaves an answered file alone, twice over', () => {
    fs.writeFileSync(
      home.options,
      'ui:\n  alerts:\n    minimum: info\n    finds:\n      items: [key]\n      cashOverCopper: 500\n',
      'utf8'
    );
    migrate();
    migrate();
    expect(alertsIn(fs.readFileSync(home.options, 'utf8'))['finds']).toEqual({
      items: ['key'],
      cashOverCopper: 500
    });
  });

  it('does nothing to a file with no alerts block to reach into', () => {
    fs.writeFileSync(home.options, 'ui:\n  showHud: true\n', 'utf8');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).not.toContain('finds');
  });
});

describe('the console keeping its own ground', () => {
  beforeEach(() => {
    fs.mkdirSync(home.globalDir, { recursive: true });
  });

  it('is stated with all three of its keys, and on', () => {
    fs.writeFileSync(home.options, 'ui:\n  showHud: true\n  showLogo: true\n', 'utf8');
    migrate();
    const ui = parse(fs.readFileSync(home.options, 'utf8')).ui as Record<string, unknown>;
    expect(ui['console']).toEqual({ palette: 'theme', keepDark: true, darkTheme: 'dark' });
  });

  it("brings the template's own paragraph rather than a copy of it", () => {
    fs.writeFileSync(home.options, 'ui:\n  showLogo: true\n', 'utf8');
    migrate(true);
    expect(fs.readFileSync(home.options, 'utf8')).toMatch(/ANSI art drawn against black/);
  });

  it('leaves a file that already answered it alone, twice over', () => {
    fs.writeFileSync(
      home.options,
      'ui:\n  showLogo: true\n  console:\n    keepDark: false\n    darkTheme: nord\n',
      'utf8'
    );
    migrate();
    migrate();
    const ui = parse(fs.readFileSync(home.options, 'utf8')).ui as Record<string, unknown>;
    // The palette is added — the block predates it — and the two keys the file
    // did answer are left exactly as they were.
    expect(ui['console']).toEqual({ palette: 'theme', keepDark: false, darkTheme: 'nord' });
  });

  // The console block written before 2026-09-08 has two keys, not three, and a
  // setting absent from the file is one nobody reading the file can find.
  it('adds the palette to a console block that predates it, at its head', () => {
    fs.writeFileSync(
      home.options,
      'ui:\n  showLogo: true\n  console:\n    keepDark: false\n    darkTheme: nord\n',
      'utf8'
    );
    migrate();
    const text = fs.readFileSync(home.options, 'utf8');
    expect(text).toMatch(/console:\n(?:\s*#[^\n]*\n)*\s*palette: theme\n/);
    const before = text;
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toBe(before);
  });

  it('leaves a palette the file already named alone', () => {
    fs.writeFileSync(
      home.options,
      'ui:\n  showLogo: true\n  console:\n    palette: neon-night\n    keepDark: true\n',
      'utf8'
    );
    migrate();
    const ui = parse(fs.readFileSync(home.options, 'utf8')).ui as Record<string, unknown>;
    expect((ui['console'] as Record<string, unknown>)['palette']).toBe('neon-night');
  });

  it('does nothing to a file with no ui block to reach into', () => {
    fs.writeFileSync(home.options, 'automation:\n  enabled: true\n', 'utf8');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).not.toContain('console');
  });
});

describe('owning the status line', () => {
  beforeEach(() => {
    fs.mkdirSync(home.globalDir, { recursive: true });
  });

  it('is stated after onPartyChange, off, and the designed line beside the ui block', () => {
    fs.writeFileSync(
      home.options,
      'ui:\n  showLogo: true\n' +
        'automation:\n  enabled: true\n  onPartyChange: party\n  idle:\n    enabled: true\n',
      'utf8'
    );
    migrate();
    const file = parse(fs.readFileSync(home.options, 'utf8')) as Record<string, unknown>;
    const automation = file['automation'] as Record<string, unknown>;
    const ui = file['ui'] as Record<string, unknown>;
    expect(automation['statline']).toEqual({ control: false });
    expect(ui['statline']).toEqual(DEFAULT_CONFIG.ui.statline);
    // Where the template puts it; the other blocks the migrations add come after.
    const keys = Object.keys(automation);
    expect(keys.indexOf('statline')).toBe(keys.indexOf('onPartyChange') + 1);
    expect(keys.indexOf('idle')).toBe(keys.indexOf('statline') + 1);
    expect(said.some((m) => m.includes('automation.statline'))).toBe(true);
  });

  it("brings the template's own paragraph rather than a copy of it", () => {
    fs.writeFileSync(home.options, 'automation:\n  enabled: true\n', 'utf8');
    migrate(true);
    expect(fs.readFileSync(home.options, 'utf8')).toMatch(/set statline full custom/);
  });

  it('leaves a file that already answered it alone, twice over', () => {
    fs.writeFileSync(home.options, 'automation:\n  statline:\n    control: true\n', 'utf8');
    migrate();
    migrate();
    const automation = parse(fs.readFileSync(home.options, 'utf8')).automation as Record<
      string,
      unknown
    >;
    expect(automation['statline']).toEqual({ control: true });
  });

  const quietList = (): string[] =>
    (
      parse(fs.readFileSync(home.internal, 'utf8')) as {
        terminal: { quiet: { commands: string[] } };
      }
    ).terminal.quiet.commands;

  it('quiets pro and set on the list the client shipped, and on no other', () => {
    fs.mkdirSync(path.dirname(home.internal), { recursive: true });
    fs.writeFileSync(
      home.internal,
      'terminal:\n  quiet:\n    enabled: true\n    commands:\n      - rm\n      - look\n',
      'utf8'
    );
    migrate();
    expect(quietList()).toEqual(['rm', 'look', 'pro', 'set']);
    expect(said.some((m) => m.includes('pro and set'))).toBe(true);
    // Once: the list is no longer the shipped one, so it is theirs now.
    migrate();
    expect(quietList()).toEqual(['rm', 'look', 'pro', 'set']);

    fs.writeFileSync(
      home.internal,
      'terminal:\n  quiet:\n    enabled: true\n    commands:\n      - rm\n',
      'utf8'
    );
    migrate();
    expect(quietList()).toEqual(['rm']);
  });
});

describe('the diagnostics preference', () => {
  const OPTIONS_WITH = `ui:
  # Show the HUD rail beside the console.
  showHud: true
  showDiagnostics: true
`;

  beforeEach(() => {
    fs.mkdirSync(home.globalDir, { recursive: true });
    fs.writeFileSync(home.options, OPTIONS_WITH, 'utf8');
  });

  it('goes from the options file, leaving the rest of the block', () => {
    migrate();
    /*
     * By key rather than by whole-block equality. The claim is that the one
     * key goes and its neighbours do not — and `ui:` is a block other
     * migrations legitimately add to (`statedTheMark` writes `showLogo` into
     * it), so an exact match here is a tripwire that fires on every future key
     * and says nothing about the diagnostics preference.
     */
    const ui = parse(fs.readFileSync(home.options, 'utf8')).ui as Record<string, unknown>;
    expect(ui['showDiagnostics']).toBeUndefined();
    expect(ui['showHud']).toBe(true);
  });

  it('goes from a character that had been given one by hand', () => {
    const scope = home.profile('main');
    fs.mkdirSync(scope.dir, { recursive: true });
    fs.writeFileSync(scope.file, 'ui:\n  showDiagnostics: true\n', 'utf8');
    migrate();
    // The block held nothing else, so it goes rather than sitting there empty
    // and reading as a setting somebody meant to fill in.
    expect(parse(fs.readFileSync(scope.file, 'utf8')).ui).toBeUndefined();
  });

  it('keeps the comments, which are the documentation', () => {
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toContain(
      '# Show the HUD rail beside the console.'
    );
  });

  it('says so, naming files', () => {
    migrate();
    const said_ = said.join('\n');
    expect(said_).toMatch(/showDiagnostics/);
    expect(said_).toContain(home.options);
  });

  it('is safe to run again', () => {
    migrate();
    const after = fs.readFileSync(home.options, 'utf8');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toBe(after);
    expect(said.join('\n')).not.toMatch(/showDiagnostics/);
  });

  it('leaves a file that never had it alone', () => {
    fs.writeFileSync(home.options, 'ui:\n  showHud: true\n', 'utf8');
    migrate();
    expect(said.join('\n')).not.toMatch(/showDiagnostics/);
  });

  /*
   * The shipped comment goes too, which is this file's one rewrite of prose.
   * It is the template's own sentence rather than the user's, and left behind
   * it teaches a key the client ignores -- so somebody reads their own file,
   * greps for `showDiagnostics`, finds nothing and concludes a setting has
   * gone missing. `reconcileWithTemplate` cannot reach inside `ui:` to fix it.
   */
  describe('and the shipped sentence that names it', () => {
    const SHIPPED = `ui:
  # Show the Vitals and Room cards once you are in the realm.
  #
  # Separate from showDiagnostics on purpose: the HUD is what you read while
  # playing, and it appears on its own without opening a panel named after
  # something else. Toggle it from the command palette without editing this.
  showHud: true
`;

    it('goes, leaving the half of the paragraph that is still true', () => {
      fs.writeFileSync(home.options, SHIPPED, 'utf8');
      migrate();
      const after = fs.readFileSync(home.options, 'utf8');
      expect(after).not.toContain('showDiagnostics');
      expect(after).toContain('# Toggle it from the command palette without editing this.');
      expect(after).toContain('# Show the Vitals and Room cards once you are in the realm.');
      // `yaml` writes `#` straight onto what follows, so the space matters.
      expect(after).not.toMatch(/#\S/);
    });

    it('goes even once the key itself has already been removed', () => {
      // The two halves ran in separate launches for the one file this shipped
      // against, so the comment sweep cannot depend on the key still being there.
      fs.writeFileSync(home.options, SHIPPED.replace('showHud: true', 'showHud: true'), 'utf8');
      migrate();
      migrate();
      expect(fs.readFileSync(home.options, 'utf8')).not.toContain('showDiagnostics');
    });

    it('leaves a sentence somebody wrote themselves alone', () => {
      const mine = 'ui:\n  # I turned showDiagnostics on to watch the wire.\n  showHud: true\n';
      fs.writeFileSync(home.options, mine, 'utf8');
      migrate();
      expect(fs.readFileSync(home.options, 'utf8')).toContain(
        '# I turned showDiagnostics on to watch the wire.'
      );
    });

    it('is safe to run again', () => {
      fs.writeFileSync(home.options, SHIPPED, 'utf8');
      migrate();
      const after = fs.readFileSync(home.options, 'utf8');
      migrate();
      expect(fs.readFileSync(home.options, 'utf8')).toBe(after);
    });
  });
});

/**
 * The peers switch grew a gate, and a file that had it on must keep meaning
 * what it meant.
 *
 * `enabled: true` used to mean *answer everybody*. With `trust` absent it now
 * means answer nobody, so an unmigrated file would leave a feature somebody
 * turned on silently doing nothing, with the switch still reading as on.
 */
/*
 * `InternalStore` copies its template on first run and never overwrites, which
 * is right — the file is full of the user's own choices. It also means a
 * button added to the shipped row afterwards reaches nobody who has already
 * run the client, which is the pre-v1 rule's own case: a change to a shipped
 * default is a change to what is on disk.
 */
describe('a loop copied off the shelf, after the shelf was renamed', () => {
  /*
   * The shelf as it is now: named the way whoever recorded the path named it,
   * rather than after the room the loop starts in. Two entries, because the
   * refusal below needs one whose places nothing on disk matches.
   */
  const SHELF: Loop[] = [
    {
      name: 'Goblin caves: Slime Beast Loop',
      category: 'Goblin caves',
      stops: [{ room: 'Huge Cave, Refuse Pit 1/1765' }, { room: 'Huge Cave 1/1764' }]
    },
    {
      name: 'Sewers: CaveWorm',
      category: 'Sewers',
      stops: [{ room: 'Dark Cave 1/866' }, { room: 'Dark Cave 1/865' }]
    }
  ];

  /* What the picker wrote when the shelf named a loop after its start room. */
  const COPIED = `# Written by the client when this loop was chosen.
name: 'Goblin caves: Slime Beast-1 1765'
stops:
  - 'Huge Cave, Refuse Pit 1/1765'
  - 'Huge Cave 1/1764'
`;

  let reads = 0;

  function migrateWithShelf(): void {
    said = [];
    reads = 0;
    migrateHome({
      home,
      legacyOptions: [],
      loopShelf: () => {
        reads += 1;
        return SHELF;
      },
      note: (message) => said.push(message)
    });
  }

  function write(file: string, body: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
  }

  const nameIn = (file: string): unknown =>
    (parse(fs.readFileSync(file, 'utf8')) as { name: string }).name;

  it('renames it, keeping the file and what is written above it', () => {
    const file = path.join(home.profile('vaelor').loops, 'slime-beast.yaml');
    write(file, COPIED);

    migrateWithShelf();

    expect(nameIn(file)).toBe('Goblin caves: Slime Beast Loop');
    // The comments are the documentation; a rename must not cost them.
    expect(fs.readFileSync(file, 'utf8')).toContain('# Written by the client');
    expect(said.join(' ')).toContain('Goblin caves: Slime Beast Loop');
  });

  /*
   * Matched on the places *and* the area, so a loop somebody wrote themselves
   * keeps the name they gave it even when it happens to walk the same rooms.
   * The name is exactly what changed, so it cannot be the thing matched on --
   * but a name a person chose does not carry the shelf's area in front of it.
   */
  it('leaves a loop the player named alone', () => {
    const file = path.join(home.globalLoops, 'mine.yaml');
    write(
      file,
      "name: My gnoll grind\nstops:\n  - 'Huge Cave, Refuse Pit 1/1765'\n  - 'Huge Cave 1/1764'\n"
    );

    migrateWithShelf();

    expect(nameIn(file)).toBe('My gnoll grind');
    expect(said).toEqual([]);
  });

  it('leaves a loop that walks somewhere else alone', () => {
    const file = path.join(home.server('greatermud').loops, 'elsewhere.yaml');
    write(
      file,
      "name: 'Sewers: Dark Cave-1 866'\nstops:\n  - 'Dark Cave 1/866'\n  - 'Sewer Tunnel 1/604'\n"
    );

    migrateWithShelf();

    expect(nameIn(file)).toBe('Sewers: Dark Cave-1 866');
  });

  it('does not read four hundred loops for a client that has copied none', () => {
    migrateWithShelf();
    expect(reads).toBe(0);
    expect(said).toEqual([]);
  });

  it('is idempotent: a second run finds nothing left to rename', () => {
    const file = path.join(home.profile('vaelor').loops, 'slime-beast.yaml');
    write(file, COPIED);

    migrateWithShelf();
    migrateWithShelf();

    expect(said).toEqual([]);
    expect(nameIn(file)).toBe('Goblin caves: Slime Beast Loop');
  });
});

describe('the loop shelf on an existing toolbar', () => {
  const INTERNAL = `# The user's own note about their row.
toolbar:
  pinned:
    - connect
    - automation
    - combat
    - retaliate
    - loot
    - 'loop:toggle'
    - 'loop:stop'
    - 'walk:stop'
`;

  const pinned = (): unknown =>
    (parse(fs.readFileSync(home.internal, 'utf8')) as { toolbar: { pinned: string[] } }).toolbar
      .pinned;

  beforeEach(() => {
    fs.mkdirSync(path.dirname(home.internal), { recursive: true });
    fs.writeFileSync(home.internal, INTERNAL, 'utf8');
  });

  /* After `loot`, where the shipped row puts it, so a migrated client draws
     the row a fresh one draws. Appending would have put the shelf on the far
     side of the transport controls, which is a different toolbar. */
  it('adds it where the shipped row has it, leaving the rest alone', () => {
    migrate();
    // `gear:restore` is the other button a migrated row gains, from
    // `pinTheGearButton` below; both are asserted here so the row a migrated
    // client draws is the row a fresh one draws, in order.
    expect(pinned()).toEqual([
      'connect',
      'gear:restore',
      'automation',
      'combat',
      'retaliate',
      'loot',
      'loop:open',
      'loop:toggle',
      'loop:stop',
      'walk:stop'
    ]);
  });

  it('says so, because a toolbar that changed silently is one nobody trusts', () => {
    migrate();
    expect(said.join(' ')).toContain('Loops');
  });

  /* The user's own comments are why this goes through `parseDocument` rather
     than a parse-and-rewrite. */
  it('keeps the notes the user wrote in it', () => {
    migrate();
    expect(fs.readFileSync(home.internal, 'utf8')).toContain("The user's own note");
  });

  /* Idempotent: the migration runs on every launch, and a second pass must not
     file a second copy of the button. */
  it('does nothing on a second run', () => {
    migrate();
    migrate();
    expect((pinned() as string[]).filter((id) => id === 'loop:open')).toHaveLength(1);
  });

  /*
   * A row curated by hand is still the user's answer. The button goes on at
   * the front rather than nowhere — present is what matters — and nothing else
   * is disturbed.
   */
  it('still adds it to a row that has been curated', () => {
    fs.writeFileSync(home.internal, 'toolbar:\n  pinned:\n    - connect\n', 'utf8');
    migrate();
    // The shelf goes to the front — its own anchor, `loot`, is not on this row
    // — and the gear button lands after `connect`, which is.
    expect(pinned()).toEqual(['loop:open', 'connect', 'gear:restore']);
  });

  /* A deviation from the shipped row lives in `localStorage`, which this
     cannot and must not reach; a file with no toolbar block is left alone. */
  it('leaves a file that states no toolbar alone', () => {
    fs.writeFileSync(home.internal, 'terminal:\n  scrollback: 5000\n', 'utf8');
    migrate();
    expect(fs.readFileSync(home.internal, 'utf8')).toBe('terminal:\n  scrollback: 5000\n');
  });
});

/*
 * `GMUD (5X)` shipped as the default realm for two days and was seeded onto
 * disks; it left the distribution on 2026-09-05, and this takes it back off
 * the disks it was put on -- but only where there is provably nothing of the
 * player's in the directory.
 */
describe('the realm that left the distribution', () => {
  const gmud = (): string => path.join(home.serversDir, 'gmud-5x', 'server.yaml');

  const seeded = (body = 'name: GMUD (5X)\nhost: 70.176.151.219\nport: 2427\n'): void => {
    fs.mkdirSync(path.join(home.serversDir, 'gmud-5x'), { recursive: true });
    fs.writeFileSync(gmud(), body, 'utf8');
  };

  const character = (id: string, realm: string): void => {
    fs.mkdirSync(home.profile(id).dir, { recursive: true });
    fs.writeFileSync(home.profile(id).file, `server: ${realm}\n`, 'utf8');
  };

  it('removes the copy the client seeded, and says so', () => {
    seeded();
    migrate();

    expect(fs.existsSync(path.dirname(gmud()))).toBe(false);
    // Said out loud, like everything else that touches somebody's files.
    expect(said.join(' ')).toContain('GMUD (5X)');
  });

  it('runs twice, and the second time has nothing to say', () => {
    seeded();
    migrate();
    migrate();
    expect(said).toEqual([]);
  });

  it('leaves a realm somebody has made their own under that id alone', () => {
    // The id is this client's; the realm in the file is theirs. A directory
    // name is the weaker half of the pair.
    seeded('name: My GreaterMUD\nhost: orohost\nport: 2427\n');
    migrate();
    expect(fs.existsSync(gmud())).toBe(true);
  });

  it('leaves it alone once it has been edited or has loops beside it', () => {
    seeded();
    fs.mkdirSync(path.join(home.serversDir, 'gmud-5x', 'loops'), { recursive: true });
    fs.writeFileSync(
      path.join(home.serversDir, 'gmud-5x', 'loops', 'sewers.yaml'),
      'name: Sewers\nstops: []\n',
      'utf8'
    );
    migrate();

    // A loop is a fact about the realm and may be the only copy of an
    // evening's work: a removed realm keeps its loops.
    expect(fs.existsSync(gmud())).toBe(true);
    expect(fs.existsSync(path.join(home.serversDir, 'gmud-5x', 'loops', 'sewers.yaml'))).toBe(true);
  });

  it('leaves it alone while a character still plays there', () => {
    seeded();
    character('thorn', 'GMUD (5X)');
    migrate();

    expect(fs.existsSync(gmud())).toBe(true);
    /*
     * And says nothing about it, on this launch or any other. A migration that
     * cannot finish and announces so every launch is a complaint that repeats
     * for as long as the file does -- the `findMissingSettings` failure. The
     * realm still works; its `database:` no longer ships, and the connection's
     * own fallback notice is what reports that, every time.
     *
     * By name rather than by silence: writing a character file is enough to
     * set other migrations off, and this is a claim about this one.
     */
    expect(said.join(' ')).not.toContain('GMUD (5X)');
  });

  it('leaves it alone rather than reading past a character file it cannot parse', () => {
    seeded();
    fs.mkdirSync(home.profile('broken').dir, { recursive: true });
    fs.writeFileSync(home.profile('broken').file, 'server: [unclosed\n', 'utf8');
    migrate();
    // An unreadable character file may be the character that plays here.
    expect(fs.existsSync(gmud())).toBe(true);
  });

  it('leaves a home that never had it alone', () => {
    character('thorn', 'Paradigm Game 1 PVE');
    migrate();
    expect(said.join(' ')).not.toContain('GMUD (5X)');
  });
});

describe('the bank on the way into the realm', () => {
  const ENTRY = `automation:
  # The user's own note about the probe.
  onEnterRealm:
    - rm
    - st
    - i
    - exp
    - sc
    - gb
    - l
`;

  const probe = (file: string): string[] =>
    (parse(fs.readFileSync(file, 'utf8')) as { automation: { onEnterRealm: string[] } }).automation
      .onEnterRealm;

  beforeEach(() => {
    fs.mkdirSync(path.dirname(home.options), { recursive: true });
    fs.writeFileSync(home.options, ENTRY, 'utf8');
  });

  /* Before the closing look, where the shipped list put it, so the last thing
     the probe left on screen was the room rather than a balance. The look
     itself is gone by the end of the pass — `stoppedAnnouncingTheLook` runs
     after this one — so what is asserted here is the order the two steps
     leave: `bank` last, and no `l` behind it. */
  it('adds it before the look that ends the probe', () => {
    migrate();
    expect(probe(home.options)).toEqual(['rm', 'st', 'i', 'exp', 'sc', 'gb', 'bank']);
  });

  it('appends when the list does not end with a look', () => {
    fs.writeFileSync(home.options, 'automation:\n  onEnterRealm:\n    - rm\n    - st\n', 'utf8');
    migrate();
    expect(probe(home.options)).toEqual(['rm', 'st', 'bank']);
  });

  /* Every character's own file too: a profile overlay states its own list, and
     one left behind is a character whose vault is never read on the way in. */
  it('reaches a character that states its own probe', () => {
    const profile = home.profile('vaelor');
    fs.mkdirSync(profile.dir, { recursive: true });
    fs.writeFileSync(profile.file, 'automation:\n  onEnterRealm:\n    - rm\n    - l\n', 'utf8');
    migrate();
    expect(probe(profile.file)).toEqual(['rm', 'bank']);
  });

  it('says so, naming the files and no values', () => {
    migrate();
    expect(said.join(' ')).toContain('bank');
  });

  /* The user's own comments are why this goes through `parseDocument`. */
  it('keeps the notes the user wrote in it', () => {
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toContain("The user's own note");
  });

  /* Idempotent: the migration runs on every launch, and a second pass must not
     file a second copy of the command. */
  it('does nothing on a second run', () => {
    migrate();
    migrate();
    expect(probe(home.options).filter((c) => c === 'bank')).toHaveLength(1);
  });

  it('leaves a file that states no entry probe alone', () => {
    fs.writeFileSync(home.options, 'automation:\n  enabled: true\n', 'utf8');
    migrate();
    // Other steps may state their own new blocks in this file; what this one
    // must not do is invent an entry probe to add `bank` to.
    const read = parse(fs.readFileSync(home.options, 'utf8')) as {
      automation: Record<string, unknown>;
    };
    expect(read.automation['onEnterRealm']).toBeUndefined();
    expect(read.automation['enabled']).toBe(true);
  });
});

describe('the gear button on an existing toolbar', () => {
  const ROW = `toolbar:
  pinned:
    - connect
    - automation
    - 'loop:open'
`;

  const pinned = (): unknown =>
    (parse(fs.readFileSync(home.internal, 'utf8')) as { toolbar: { pinned: string[] } }).toolbar
      .pinned;

  beforeEach(() => {
    fs.mkdirSync(path.dirname(home.internal), { recursive: true });
    fs.writeFileSync(home.internal, ROW, 'utf8');
  });

  /* After `connect`, where the shipped row puts it: it is what somebody does on
     arriving, not while walking. */
  it('adds it beside the dial, leaving the rest alone', () => {
    migrate();
    expect(pinned()).toEqual(['connect', 'gear:restore', 'automation', 'loop:open']);
  });

  it('says so, because a toolbar that changed silently is one nobody trusts', () => {
    migrate();
    expect(said.join(' ')).toContain('gear button');
  });

  /* Idempotent: the migration runs on every launch, and a second pass must not
     file a second copy of the button. */
  it('does nothing on a second run', () => {
    migrate();
    migrate();
    expect((pinned() as string[]).filter((id) => id === 'gear:restore')).toHaveLength(1);
  });

  /* A row curated by hand is still the user's answer: present is what matters.
     The loop shelf lands on the same row for the same reason, at the front
     before this one, because neither of their anchors is on it. */
  it('goes to the front of a row with no dial on it', () => {
    fs.writeFileSync(home.internal, 'toolbar:\n  pinned:\n    - combat\n', 'utf8');
    migrate();
    expect(pinned()).toEqual(['gear:restore', 'loop:open', 'combat']);
  });

  it('leaves a file that states no toolbar alone', () => {
    fs.writeFileSync(home.internal, 'terminal:\n  scrollback: 5000\n', 'utf8');
    migrate();
    expect(fs.readFileSync(home.internal, 'utf8')).toBe('terminal:\n  scrollback: 5000\n');
  });
});

describe("the walk's nudge interval in an existing tuning file", () => {
  const WALK = `tuning:
  walk:
    # A note the user wrote.
    holdMs: 1500
    maxHolds: 3
    recentSteps: 5
`;

  const walk = (): Record<string, number> =>
    (parse(fs.readFileSync(home.internal, 'utf8')) as { tuning: { walk: Record<string, number> } })
      .tuning.walk;

  beforeEach(() => {
    fs.mkdirSync(path.dirname(home.internal), { recursive: true });
    fs.writeFileSync(home.internal, WALK, 'utf8');
  });

  /* Beside `maxHolds`, where the shipped file puts it, so a migrated tuning
     file reads as a fresh one. */
  it('writes it in beside the hold budget, and keeps the rest', () => {
    migrate();
    expect(Object.keys(walk())).toEqual([
      'holdMs',
      'maxHolds',
      'nudgeAfterMs',
      'nudgeSamples',
      'recentSteps',
      // What replaced `searchTries`, added by the same pass.
      'searchRetryMs',
      'searchSayEveryMs',
      // How often a searching walk asks the server to reprint the room, which
      // is what stops it searching one whose exit it has already found.
      'searchRecheckEvery',
      'leverTries'
    ]);
    expect(walk()['nudgeAfterMs']).toBe(1000);
    expect(fs.readFileSync(home.internal, 'utf8')).toContain('A note the user wrote');
  });

  /*
   * The window the interval above is now a margin over. A file that states the
   * interval and not the window is one migrated before the deadline became a
   * measurement, and the comment beside it still explains the old meaning — so
   * both go in, and the stale explanation is replaced rather than left.
   */
  it('states the measurement window beside the interval', () => {
    migrate();
    expect(walk()['nudgeSamples']).toBe(5);
    expect(fs.readFileSync(home.internal, 'utf8')).toContain('The statistic is the slowest');
  });

  /*
   * A file migrated before the deadline became a measurement states the
   * interval already, with a comment explaining it as the whole deadline. The
   * key stays and its meaning has moved, so the stale explanation is replaced
   * rather than left standing beside a figure that no longer works that way.
   */
  it('restates an interval whose comment still explains the old meaning', () => {
    fs.writeFileSync(
      home.internal,
      `tuning:
  walk:
    holdMs: 1500
    # How long a step that is already on the wire may go unanswered before the walk
    # sends one bare Enter to force a status line out of the server.
    #
    # A move that landed is answered in well under a second, so this is already the
    # abnormal case by the time it fires.
    nudgeAfterMs: 1000
`,
      'utf8'
    );
    migrate();
    const text = fs.readFileSync(home.internal, 'utf8');
    expect(walk()).toEqual({
      holdMs: 1500,
      nudgeAfterMs: 1000,
      nudgeSamples: 5,
      searchRetryMs: DEFAULT_INTERNAL.tuning.walk.searchRetryMs,
      searchSayEveryMs: DEFAULT_INTERNAL.tuning.walk.searchSayEveryMs,
      searchRecheckEvery: DEFAULT_INTERNAL.tuning.walk.searchRecheckEvery,
      leverTries: DEFAULT_INTERNAL.tuning.walk.leverTries
    });
    expect(text).toContain("longer than this realm's own slowest answer");
    expect(text).not.toContain('so this is already the');
  });

  it('leaves a stated window alone', () => {
    fs.writeFileSync(home.internal, 'tuning:\n  walk:\n    nudgeSamples: 12\n', 'utf8');
    migrate();
    expect(walk()['nudgeSamples']).toBe(12);
  });

  it('says so, because a figure that governs behaviour has to be findable', () => {
    migrate();
    expect(said.join(' ')).toContain('tuning file');
  });

  /* Idempotent: the migration runs on every launch. */
  it('does nothing on a second run', () => {
    migrate();
    const after = fs.readFileSync(home.internal, 'utf8');
    migrate();
    expect(fs.readFileSync(home.internal, 'utf8')).toBe(after);
  });

  /* A figure the user has already set is their answer, not this one's. */
  it('leaves a stated interval alone', () => {
    fs.writeFileSync(home.internal, 'tuning:\n  walk:\n    nudgeAfterMs: 2500\n', 'utf8');
    migrate();
    expect(walk()['nudgeAfterMs']).toBe(2500);
  });

  it('leaves a file that states no walk block alone', () => {
    fs.writeFileSync(home.internal, 'terminal:\n  scrollback: 5000\n', 'utf8');
    migrate();
    expect(fs.readFileSync(home.internal, 'utf8')).toBe('terminal:\n  scrollback: 5000\n');
  });
});

/*
 * The `who` listing's cap, which was 60 beside the pattern. A realm with more
 * adventurers than that truncated its own roster and then fed the rows past the
 * cut back through the classifier one at a time — reported as a `who` on screen
 * with the client calling somebody on it offline.
 */
describe('the roster cap in an existing tuning file', () => {
  const PARSE = `tuning:
  parse:
    # A note the user wrote.
    baseConfidence: 0.8
    descriptionLines: 20
    mobRegenMs: 6000
`;

  const block = (): Record<string, number> =>
    (parse(fs.readFileSync(home.internal, 'utf8')) as { tuning: { parse: Record<string, number> } })
      .tuning.parse;

  beforeEach(() => {
    fs.mkdirSync(path.dirname(home.internal), { recursive: true });
    fs.writeFileSync(home.internal, PARSE, 'utf8');
  });

  it('writes it in beside the description cap, and keeps the rest', () => {
    migrate();
    /* `staleMoveMs` on the end is `theTuningBlockGainedKeys` filling in the
       other key `tuning.parse` gained, in the same migration pass. */
    expect(Object.keys(block())).toEqual([
      'baseConfidence',
      'descriptionLines',
      'rosterLines',
      'mobRegenMs',
      'staleMoveMs'
    ]);
    expect(block()['rosterLines']).toBe(400);
    expect(fs.readFileSync(home.internal, 'utf8')).toContain('A note the user wrote');
  });

  it('says so, because a figure that governs behaviour has to be findable', () => {
    migrate();
    expect(said.join(' ')).toContain('rosterLines');
  });

  it('does nothing on a second run', () => {
    migrate();
    const after = fs.readFileSync(home.internal, 'utf8');
    migrate();
    expect(fs.readFileSync(home.internal, 'utf8')).toBe(after);
  });

  it('leaves a stated cap alone', () => {
    fs.writeFileSync(home.internal, 'tuning:\n  parse:\n    rosterLines: 90\n', 'utf8');
    migrate();
    expect(block()['rosterLines']).toBe(90);
  });

  it('leaves a file that states no parse block alone', () => {
    fs.writeFileSync(home.internal, 'terminal:\n  scrollback: 5000\n', 'utf8');
    migrate();
    expect(fs.readFileSync(home.internal, 'utf8')).toBe('terminal:\n  scrollback: 5000\n');
  });
});

/*
 * One figure decided for the player how much of the realm a map showed. The
 * card has a density slider now and what it chooses between are two named
 * ends, so the single key is a setting nothing reads — `dropStandUpThresholds`'
 * rule, in another block.
 */
describe('the map density pair in an existing tuning file', () => {
  const VIEW = `tuning:
  view:
    mapRadiusMin: 3
    mapRadiusMax: 12
    mapRoomPixels: 34
    clockTickMs: 1000
`;

  const view = (): Record<string, number> =>
    (parse(fs.readFileSync(home.internal, 'utf8')) as { tuning: { view: Record<string, number> } })
      .tuning.view;

  beforeEach(() => {
    fs.mkdirSync(path.dirname(home.internal), { recursive: true });
    fs.writeFileSync(home.internal, VIEW, 'utf8');
  });

  it('takes the retired key out and states the pair where it stood', () => {
    migrate();
    /*
     * By key and by *position*, not by whole-block equality.
     *
     * The claim is that `mapRoomPixels` is gone and the pair stands where it
     * did — and `tuning.view` is a block other migrations legitimately add to,
     * so an exact key list is a tripwire that fires on every future key and
     * says nothing about the map density. It fired twice already.
     */
    const keys = Object.keys(view());
    expect(keys).not.toContain('mapRoomPixels');
    expect(keys.slice(0, 4)).toEqual([
      'mapRadiusMin',
      'mapRadiusMax',
      'mapRoomPixelsSparse',
      'mapRoomPixelsDense'
    ]);
    expect(view()['mapRoomPixelsSparse']).toBe(40);
    expect(view()['mapRoomPixelsDense']).toBe(10);
  });

  /*
   * Not carried into either end: 34 was the answer to a different question,
   * and writing it into the sparse end would leave two settings that no longer
   * relate to each other.
   */
  it('does not carry the old figure into either end, and says so', () => {
    fs.writeFileSync(home.internal, 'tuning:\n  view:\n    mapRoomPixels: 88\n', 'utf8');
    migrate();
    expect(view()['mapRoomPixelsSparse']).toBe(40);
    expect(said.join(' ')).toContain('mapRoomPixels');
  });

  it('lowers the floor that would refuse the sparse end', () => {
    migrate();
    expect(view()['mapRadiusMin']).toBe(2);
  });

  /* A floor somebody tuned themselves is their answer, not this one's. */
  it('leaves a floor that is not the old default alone', () => {
    fs.writeFileSync(
      home.internal,
      'tuning:\n  view:\n    mapRadiusMin: 5\n    mapRoomPixels: 34\n',
      'utf8'
    );
    migrate();
    expect(view()['mapRadiusMin']).toBe(5);
  });

  it('does nothing on a second run', () => {
    migrate();
    const after = fs.readFileSync(home.internal, 'utf8');
    migrate();
    expect(fs.readFileSync(home.internal, 'utf8')).toBe(after);
  });

  it('leaves a file that states no view block alone', () => {
    fs.writeFileSync(home.internal, 'terminal:\n  scrollback: 5000\n', 'utf8');
    migrate();
    expect(fs.readFileSync(home.internal, 'utf8')).toBe('terminal:\n  scrollback: 5000\n');
  });
});

describe('peers became remotes', () => {
  const ON = `automation:
  # Answer other players' @ commands.
  peers:
    enabled: true
    trust:
      - named
      - party
    allow:
      - Soul
    block:
      - Rend
`;

  beforeEach(() => {
    fs.mkdirSync(home.globalDir, { recursive: true });
    fs.writeFileSync(home.options, ON, 'utf8');
  });

  const remotes = (file = home.options) => parse(fs.readFileSync(file, 'utf8')).automation.remotes;

  it('renames the block and keeps the switch', () => {
    migrate();
    expect(parse(fs.readFileSync(home.options, 'utf8')).automation.peers).toBeUndefined();
    expect(remotes().enabled).toBe(true);
  });

  /*
   * A profile is a sparse overlay, and the first version of this step wrote
   * `enabled: false` into every file whose old block did not state it -- so a
   * character inheriting `enabled: true` from the options file came out of the
   * migration switched off. A migration turning a feature off is the one thing
   * it must never do.
   */
  it('does not state a key the old block did not state', () => {
    const scope = home.profile('sparse');
    fs.mkdirSync(scope.dir, { recursive: true });
    fs.writeFileSync(
      scope.file,
      'automation:\n  peers:\n    trust: [named]\n    allow: [Soul]\n',
      'utf8'
    );
    migrate();
    const block = remotes(scope.file);
    expect('enabled' in block).toBe(false);
    expect(block.players.soul.allow).toEqual([...ACTIONABLE_REMOTES]);
    // And nothing empty is written either: a sparse overlay stays sparse.
    expect('gang' in block).toBe(false);
  });

  /*
   * The block stays where the file had it, with whatever the person wrote above
   * it. Deleting and re-adding moved it to the end of `automation:` and dropped
   * the comment, which in this project is the documentation.
   */
  it('renames in place, keeping the position and the comment', () => {
    const scope = home.profile('noted');
    fs.mkdirSync(scope.dir, { recursive: true });
    fs.writeFileSync(
      scope.file,
      'automation:\n  # Mine, and I wrote it.\n  peers:\n    enabled: true\n  combat:\n    enabled: false\n',
      'utf8'
    );
    migrate();
    const after = fs.readFileSync(scope.file, 'utf8');
    expect(after).toContain('# Mine, and I wrote it.');
    expect(after.indexOf('remotes:')).toBeLessThan(after.indexOf('combat:'));
  });

  /*
   * The options file is the copied template, and `reconcileWithTemplate` never
   * reaches inside a top-level block -- so nothing else would ever put the new
   * keys, or a word of prose about them, into a file whose `automation:` block
   * already exists.
   */
  it('gives the options file the template’s own block, comments and all', () => {
    migrate(true);
    const after = fs.readFileSync(home.options, 'utf8');
    expect(after).toContain('gangpath:');
    expect(after).toContain('players:');
    // The template's prose about the new shape, not the old block's about the
    // one it replaced.
    expect(after).toMatch(/#[^\n]*gangpath/i);
    expect(remotes().enabled).toBe(true);
  });

  /*
   * Faithful where it can be: `named` + `allow: [Soul]` meant Soul could use
   * everything, so Soul keeps everything this client can actually answer —
   * written out by name, never a wildcard, so a later build that makes a new
   * remote answerable does not silently hand it to somebody.
   */
  it('keeps what an allowed name could already do, as an explicit list', () => {
    migrate();
    expect(remotes().players.soul.allow).toEqual([...ACTIONABLE_REMOTES]);
    expect(remotes().players.soul.deny).toEqual([]);
  });

  it('keeps a block as an explicit deny, so it cannot evaporate in a rename', () => {
    // Inert while nothing else grants Rend anything, and exactly right the day
    // somebody grants their gang something.
    migrate();
    expect(remotes().players.rend.deny).toEqual([...ACTIONABLE_REMOTES]);
    expect(remotes().players.rend.allow).toEqual([]);
  });

  it('drops the party ground and says so, because nobody can grant themselves one now', () => {
    migrate();
    expect(said.join('\n')).toContain('"party" ground');
  });

  it('carries a trusted gang across as the gang list', () => {
    fs.writeFileSync(
      home.options,
      'automation:\n  peers:\n    enabled: true\n    trust: [gang]\n',
      'utf8'
    );
    migrate();
    expect(remotes().gang).toEqual([...ACTIONABLE_REMOTES]);
  });

  it('grants the gang nothing when it was not a trusted ground', () => {
    migrate();
    expect(remotes().gang).toBeUndefined();
  });

  /*
   * No realm ever answered a gangpath `@` command before this, so turning it on
   * during a migration would start a behaviour nobody chose.
   */
  it('leaves the gangpath switch off', () => {
    migrate(true);
    expect(remotes().gangpath).toBe(false);
  });

  it('converts a file with the switch off too, because the rename is not optional', () => {
    fs.writeFileSync(home.options, 'automation:\n  peers:\n    enabled: false\n', 'utf8');
    migrate();
    // `statedPartyRemotes` runs behind this one and states the party list into
    // the block it just produced, which is the whole point of running it after.
    expect(remotes()).toEqual({
      enabled: false,
      party: [...DEFAULT_CONFIG.automation.remotes.party]
    });
  });

  it('does the same for a character', () => {
    const scope = home.profile('main');
    fs.mkdirSync(scope.dir, { recursive: true });
    fs.writeFileSync(
      scope.file,
      'automation:\n  peers:\n    enabled: true\n    trust: [named]\n    allow: [Vaelor]\n',
      'utf8'
    );
    migrate();
    expect(remotes(scope.file).players.vaelor.allow).toEqual([...ACTIONABLE_REMOTES]);
  });

  it('keeps the comments, which are the documentation', () => {
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toContain("# Answer other players' @ commands.");
  });

  it('says so, naming files', () => {
    migrate();
    const said_ = said.join('\n');
    expect(said_).toMatch(/automation.peers/);
    expect(said_).toContain(home.options);
  });

  it('is safe to run again', () => {
    migrate();
    const after = fs.readFileSync(home.options, 'utf8');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toBe(after);
    expect(said.join('\n')).not.toMatch(/automation.peers/);
  });

  /*
   * A file that has already been converted and then hand-edited back to having
   * both keys keeps the new one: the old is the dead key, and guessing which
   * the person meant is how a permission gets overwritten.
   */
  it('drops a leftover peers block beside an existing remotes one', () => {
    fs.writeFileSync(
      home.options,
      'automation:\n  peers:\n    enabled: true\n  remotes:\n    enabled: false\n',
      'utf8'
    );
    migrate();
    const automation = parse(fs.readFileSync(home.options, 'utf8')).automation;
    expect(automation.peers).toBeUndefined();
    expect(automation.remotes).toEqual({
      enabled: false,
      party: [...DEFAULT_CONFIG.automation.remotes.party]
    });
  });
});

/*
 * The party list ships non-empty, so a file that predates it takes the default
 * and says nothing about why. `reconcileWithTemplate` fills an absent top-level
 * block and never reaches inside one, so nothing else would ever put it there.
 */
describe('the party remotes list is stated in the options file', () => {
  let home: Home;
  let dir: string;
  const said: string[] = [];

  const migrate = (): void =>
    migrateHome({ home, legacyOptions: [], note: (message) => said.push(message) });

  const remotes = (): Record<string, unknown> =>
    (parse(fs.readFileSync(home.options, 'utf8')).automation as Record<string, unknown>)[
      'remotes'
    ] as Record<string, unknown>;

  beforeEach(() => {
    said.length = 0;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-party-remotes-'));
    home = homeAt(dir);
    fs.mkdirSync(path.dirname(home.options), { recursive: true });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes the shipped list into a block that has everything else', () => {
    fs.writeFileSync(
      home.options,
      'automation:\n  remotes:\n    enabled: true\n    gangpath: false\n    gang: []\n    players: {}\n',
      'utf8'
    );
    migrate();
    expect(remotes()['party']).toEqual([...DEFAULT_CONFIG.automation.remotes.party]);
    expect(said.join('\n')).toContain('automation.remotes.party');
  });

  it('puts it where the template does — after the gang, before the players', () => {
    fs.writeFileSync(
      home.options,
      'automation:\n  remotes:\n    enabled: true\n    gang: []\n    players: {}\n',
      'utf8'
    );
    migrate();
    const text = fs.readFileSync(home.options, 'utf8');
    expect(text.indexOf('gang:')).toBeLessThan(text.indexOf('party:'));
    expect(text.indexOf('party:')).toBeLessThan(text.indexOf('players:'));
  });

  it('carries the paragraph that says why a permission list ships non-empty', () => {
    fs.writeFileSync(home.options, 'automation:\n  remotes:\n    enabled: true\n', 'utf8');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toContain('invitation nobody accepted');
  });

  it('leaves a list somebody pruned on purpose alone, and is safe to run again', () => {
    /*
     * Absence is the only thing filled. An empty list is a decision — *my
     * party gets nothing* — and a migration that grew it back every launch
     * would be the "a list the user pruned would grow back" failure
     * `reconcileWithTemplate` refuses by design.
     */
    fs.writeFileSync(
      home.options,
      'automation:\n  remotes:\n    enabled: true\n    party: []\n',
      'utf8'
    );
    migrate();
    expect(remotes()['party']).toEqual([]);
    const after = fs.readFileSync(home.options, 'utf8');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toBe(after);
    expect(said.join('\n')).not.toContain('automation.remotes.party');
  });

  it('never states it in a character file, which is a sparse overlay', () => {
    /*
     * Writing today's default into an overlay pins it against every later
     * change to the list — `peersBecameRemotes`' own rule, a key the old block
     * did not state is not stated by the new one, applied to a value.
     */
    const scope = home.profile('vaelor');
    fs.mkdirSync(scope.dir, { recursive: true });
    fs.writeFileSync(scope.file, 'automation:\n  remotes:\n    enabled: true\n', 'utf8');
    fs.writeFileSync(home.options, 'ui: {}\n', 'utf8');
    migrate();
    expect(fs.readFileSync(scope.file, 'utf8')).not.toContain('party:');
  });

  it('does nothing to a file with no remotes block at all', () => {
    // That one is `reconcileWithTemplate`'s: it copies the whole block, party
    // key and comments and all.
    fs.writeFileSync(home.options, 'ui: {}\n', 'utf8');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).not.toContain('party:');
  });
});

/*
 * The anonymous session's own account and autoconnect go from the options file
 * with the session that spent them. Nothing in the notice is a value: the file
 * may have held a real password.
 */
describe('the anonymous connection', () => {
  const OPTIONS_WITH = `connection:
  # Where the client dials when nobody is loaded.
  host: orohost
  port: 2427
  autoConnect: true
  login:
    enabled: true
    username: someone
    password: secret-value
    steps:
      - when: 'Please enter your selection'
        send: P
`;

  beforeEach(() => {
    fs.mkdirSync(home.globalDir, { recursive: true });
    fs.writeFileSync(home.options, OPTIONS_WITH, 'utf8');
  });

  it('loses its account and its autoconnect, and keeps the steps', () => {
    migrate();
    const written = parse(fs.readFileSync(home.options, 'utf8'));
    expect(written.connection).toEqual({
      host: 'orohost',
      port: 2427,
      login: { steps: [{ when: 'Please enter your selection', send: 'P' }] }
    });
  });

  it('keeps the comments, which are the documentation', () => {
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toContain('# Where the client dials');
  });

  it('says so, naming the file and never the password', () => {
    migrate();
    const said_ = said.join('\n');
    expect(said_).toMatch(/account/i);
    expect(said_).toContain(home.options);
    expect(said_).not.toContain('secret-value');
    expect(said_).not.toContain('someone');
  });

  it('takes an emptied login block with it', () => {
    fs.writeFileSync(
      home.options,
      'connection:\n  host: orohost\n  login:\n    username: someone\n    password: x\n',
      'utf8'
    );
    migrate();
    expect(parse(fs.readFileSync(home.options, 'utf8')).connection).toEqual({ host: 'orohost' });
  });

  it('is safe to run again', () => {
    migrate();
    const after = fs.readFileSync(home.options, 'utf8');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toBe(after);
    expect(said.join('\n')).not.toMatch(/account/i);
  });

  it('leaves a file that never had them alone', () => {
    fs.writeFileSync(
      home.options,
      'connection:\n  host: orohost\n  login:\n    steps: []\n',
      'utf8'
    );
    migrate();
    expect(said.join('\n')).not.toMatch(/account/i);
  });
});

/*
 * `l` prints the room *and* tells everybody standing in it that this character
 * is looking around — a sentence the client already reads from the other side.
 * On the idle tick that is a beacon every forty-five seconds all evening. A
 * bare Enter prints the same block silently, so the two places the player's
 * own file still names a look have to move with the code, or the change
 * reaches nobody who has already run the client.
 */
describe('the look that told the room', () => {
  // `bank` is already here so `askedTheBankOnEntry`, which runs in the same
  // pass, is a no-op and these read as being about the look alone.
  const ENTRY = `automation:
  onEnterRealm:
    - rm
    - st
    - bank
    - l
  idle:
    # The user's own note about the keep-alive.
    enabled: true
    afterSeconds: 45
    command: l
`;

  const read = (file: string) =>
    parse(fs.readFileSync(file, 'utf8')) as {
      automation: { onEnterRealm: string[]; idle: { command: string } };
    };

  beforeEach(() => {
    fs.mkdirSync(path.dirname(home.options), { recursive: true });
    fs.writeFileSync(home.options, ENTRY, 'utf8');
  });

  it('makes the idle command a bare Enter and drops the closing look', () => {
    migrate();
    const after = read(home.options).automation;
    expect(after.idle.command).toBe('');
    expect(after.onEnterRealm).toEqual(['rm', 'st', 'bank']);
  });

  /* Every character's own file too: a profile overlay states its own, and one
     left behind is a character still announcing itself every idle tick. */
  it('reaches a character that states its own', () => {
    const profile = home.profile('vaelor');
    fs.mkdirSync(profile.dir, { recursive: true });
    fs.writeFileSync(profile.file, 'automation:\n  idle:\n    command: look\n', 'utf8');
    migrate();
    expect(read(profile.file).automation.idle.command).toBe('');
  });

  /* Anything else there is a command somebody chose, and this is not the place
     to have an opinion about it. */
  it('leaves an idle command that is not a look alone', () => {
    fs.writeFileSync(home.options, 'automation:\n  idle:\n    command: exp\n', 'utf8');
    migrate();
    expect(read(home.options).automation.idle.command).toBe('exp');
  });

  /* Only a *trailing* look: one in the middle of the list was put there to
     separate two answers, and removing it changes what the console shows. */
  it('leaves a look in the middle of the entry probe alone', () => {
    fs.writeFileSync(
      home.options,
      'automation:\n  onEnterRealm:\n    - l\n    - bank\n    - st\n',
      'utf8'
    );
    migrate();
    expect(read(home.options).automation.onEnterRealm).toEqual(['l', 'bank', 'st']);
  });

  it('says so, naming the file and no values', () => {
    migrate();
    expect(said.join(' ')).toContain(home.options);
    expect(said.join(' ')).toMatch(/bare Enter/);
  });

  /* The user's own comments are why this goes through `parseDocument`. */
  it('keeps the notes the user wrote in it, and is safe to run again', () => {
    migrate();
    const after = fs.readFileSync(home.options, 'utf8');
    expect(after).toContain("# The user's own note about the keep-alive.");
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toBe(after);
  });
});

/*
 * The world database moving off the character and onto the realm.
 *
 * It was per character because a profile is an overlay and two characters on
 * two realms was the case it existed for — but that reasoning was about the
 * *realm* all along. Two characters on one realm cannot be walking two
 * different maps, so stating it per character was the same answer written out
 * once each, and a third character added afterwards silently got the shipped
 * world while the two beside it walked Paradigm.
 */
describe('the realm owns the world database', () => {
  const realm = (id: string, name: string): string => {
    const scope = home.server(id);
    fs.mkdirSync(scope.dir, { recursive: true });
    fs.writeFileSync(scope.file, `name: ${name}\nhost: orohost\nport: 2427\n`, 'utf8');
    return scope.file;
  };

  const character = (id: string, body: string): string => {
    const scope = home.profile(id);
    fs.mkdirSync(scope.dir, { recursive: true });
    fs.writeFileSync(scope.file, body, 'utf8');
    return scope.file;
  };

  const read = (file: string): Record<string, unknown> =>
    parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

  beforeEach(() => {
    fs.mkdirSync(path.dirname(home.options), { recursive: true });
    fs.writeFileSync(home.options, 'connection:\n  host: orohost\n', 'utf8');
  });

  it('writes what a character stated onto the realm it names, and takes it off the character', () => {
    const server = realm('greatermud-local', 'GreaterMUD (local)');
    const profile = character(
      'vaelor',
      'server: GreaterMUD (local)\nworld:\n  database: /realms/paradigm.mdb\n'
    );

    migrate();

    expect(read(server)['database']).toBe('/realms/paradigm.mdb');
    expect(read(profile)['world']).toBeUndefined();
    // And the character is otherwise untouched.
    expect(read(profile)['server']).toBe('GreaterMUD (local)');
  });

  /* Every character on that realm now walks it, including the ones that never
     stated a database and were silently on the shipped world. */
  it('reaches a character on the same realm that stated nothing', () => {
    realm('greatermud-local', 'GreaterMUD (local)');
    character('vaelor', 'server: GreaterMUD (local)\nworld:\n  database: /realms/paradigm.mdb\n');
    const quiet = character('yang', 'server: GreaterMUD (local)\n');

    migrate();

    expect(read(quiet)['world']).toBeUndefined();
    expect(read(home.server('greatermud-local').file)['database']).toBe('/realms/paradigm.mdb');
  });

  /* A character that says nothing but `world: {}` — an empty block an earlier
     save left behind — has nothing to carry, but the key still goes: with
     `world:` out of the schema it is a key nothing reads. */
  it('clears an empty world block without inventing a database', () => {
    const server = realm('greatermud-local', 'GreaterMUD (local)');
    const profile = character('vaelor', 'server: GreaterMUD (local)\nworld: {}\n');

    migrate();

    expect(read(profile)['world']).toBeUndefined();
    expect(read(server)['database']).toBeUndefined();
  });

  /*
   * The options file's own `world:` was the default every character inherited,
   * so dropping it silently would move somebody's whole client onto a different
   * map. It goes under everything a character said.
   */
  it('falls back to the client-wide default for a realm nobody named one for', () => {
    fs.writeFileSync(
      home.options,
      'connection:\n  host: orohost\nworld:\n  database: /realms/global.mdb\n',
      'utf8'
    );
    const stated = realm('greatermud-local', 'GreaterMUD (local)');
    const quiet = realm('greatermud-test', 'GreaterMUD (test)');
    character('vaelor', 'server: GreaterMUD (local)\nworld:\n  database: /realms/paradigm.mdb\n');

    migrate();

    expect(read(stated)['database']).toBe('/realms/paradigm.mdb');
    expect(read(quiet)['database']).toBe('/realms/global.mdb');
    expect(read(home.options)['world']).toBeUndefined();
  });

  /* Nothing is overwritten: a realm that already names a map keeps it, and the
     character's copy is dropped rather than fought over. */
  it('leaves a realm that already states one alone', () => {
    const scope = home.server('greatermud-local');
    fs.mkdirSync(scope.dir, { recursive: true });
    fs.writeFileSync(
      scope.file,
      'name: GreaterMUD (local)\nhost: orohost\ndatabase: /realms/chosen.mdb\n',
      'utf8'
    );
    character('vaelor', 'server: GreaterMUD (local)\nworld:\n  database: /realms/other.mdb\n');

    migrate();

    expect(read(scope.file)['database']).toBe('/realms/chosen.mdb');
  });

  /* The paragraph that explains it goes beside the key, because in these files
     the comments are the documentation. */
  it('writes the reason beside the path', () => {
    const server = realm('greatermud-local', 'GreaterMUD (local)');
    character('vaelor', 'server: GreaterMUD (local)\nworld:\n  database: /realms/paradigm.mdb\n');

    migrate();

    expect(fs.readFileSync(server, 'utf8')).toContain('two different maps');
  });

  /* Counts and no paths at all: this one would otherwise be printing a database
     path out of somebody's own file. */
  it('says so, in counts', () => {
    realm('greatermud-local', 'GreaterMUD (local)');
    character('vaelor', 'server: GreaterMUD (local)\nworld:\n  database: /realms/paradigm.mdb\n');

    migrate();

    expect(said.join(' ')).toContain('world database belongs to the realm');
    expect(said.join(' ')).not.toContain('/realms/paradigm.mdb');
  });

  /* Idempotent: the migration runs on every launch, and the second pass has
     nothing left to match. */
  it('does nothing on a second run', () => {
    const server = realm('greatermud-local', 'GreaterMUD (local)');
    character('vaelor', 'server: GreaterMUD (local)\nworld:\n  database: /realms/paradigm.mdb\n');

    migrate();
    const after = fs.readFileSync(server, 'utf8');
    migrate();

    expect(fs.readFileSync(server, 'utf8')).toBe(after);
    expect(said).toEqual([]);
  });

  /* A character that names no realm at all is reported and skipped everywhere
     else; here it simply has nowhere to put its database, and the key still
     goes rather than being left for something that no longer reads it. */
  it('drops the key from a character whose realm cannot be found', () => {
    const profile = character('vaelor', 'world:\n  database: /realms/paradigm.mdb\n');

    migrate();

    expect(read(profile)?.['world']).toBeUndefined();
  });
});

/*
 * A shop's stock became the realm's rather than each character's, so the rows
 * already written into every character's own file have to move — otherwise the
 * running client looks for them in the realm file, does not find them, and the
 * first character to type `list` learns the same counter a second time. Which
 * is the complaint the whole change answers.
 */
describe('what shops stock moved into the realm’s own record', () => {
  const stock = (command: string) => ({
    reason: 'unknown-stock',
    from: '1/3302',
    fromName: "Jorah's Plate/Scale",
    command,
    to: null,
    name: command,
    exits: [],
    at: 1_700_000_000_000
  });

  const exit = {
    reason: 'unknown-exit',
    from: '1/10',
    fromName: 'Cliff Top',
    command: 'jump cliff',
    to: '1/12',
    name: 'Narrow Ledge',
    exits: ['u'],
    at: 1_700_000_000_000
  };

  /** One character's memory file, as the client would have written it. */
  function wrote(who: string, discoveries: unknown[], realm = 'gmud.mdb'): string {
    const file = home.state('memory', `${who}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, realm, discoveries }), 'utf8');
    return file;
  }

  const read = (file: string) =>
    (
      JSON.parse(fs.readFileSync(file, 'utf8')) as { discoveries: Array<{ command: string }> }
    ).discoveries.map((entry) => entry.command);

  it('moves the stock across and leaves the exits where they are', () => {
    const own = wrote('vaelor', [exit, stock('black plate leggings')]);
    migrate();

    expect(read(own)).toEqual(['jump cliff']);
    expect(read(home.state('memory', 'realm-gmud.mdb.json'))).toEqual(['black plate leggings']);
    expect(said.join(' ')).toMatch(/shops were found to stock|shop was found to stock/);
  });

  /*
   * Four characters that each learned the same counter must not write four
   * identical rows into one file — the store would drop three on the next load
   * anyway, and a record that grows by three every migration is one nobody can
   * read.
   */
  it('folds what several characters each learned into one row', () => {
    wrote('vaelor', [stock('black plate boots')]);
    wrote('soul', [stock('black plate boots'), stock('eagle helm')]);
    migrate();

    expect(read(home.state('memory', 'realm-gmud.mdb.json')).sort()).toEqual([
      'black plate boots',
      'eagle helm'
    ]);
  });

  /* Two realms are two records: the room numbers do not mean the same places. */
  it('keeps two realms apart', () => {
    wrote('vaelor', [stock('black plate boots')], 'gmud.mdb');
    wrote('other', [stock('bronze helm')], 'stock.mdb');
    migrate();

    expect(read(home.state('memory', 'realm-gmud.mdb.json'))).toEqual(['black plate boots']);
    expect(read(home.state('memory', 'realm-stock.mdb.json'))).toEqual(['bronze helm']);
  });

  /* Every mutation path is safely retryable — the standing rule. */
  it('does nothing the second time', () => {
    wrote('vaelor', [exit, stock('black plate leggings')]);
    migrate();
    const first = said.length;
    migrate();

    expect(said).toHaveLength(0);
    expect(first).toBeGreaterThan(0);
    expect(read(home.state('memory', 'realm-gmud.mdb.json'))).toEqual(['black plate leggings']);
  });

  it('says nothing when no character learned a shop', () => {
    wrote('vaelor', [exit]);
    migrate();
    expect(said.join(' ')).not.toMatch(/shop/);
    expect(fs.existsSync(home.state('memory', 'realm-gmud.mdb.json'))).toBe(false);
  });
});

/*
 * The blocks and keys 2026-09-01 added, written into the file the player owns:
 * `reconcileWithTemplate` never reaches inside `automation:`, so without this
 * a setting the screens can edit was invisible in the file that documents it.
 */
describe('the conversation log stated in logging:', () => {
  const readLogging = (): Record<string, unknown> =>
    (parse(fs.readFileSync(home.options, 'utf8')) as { logging: Record<string, unknown> }).logging;

  beforeEach(() => {
    fs.mkdirSync(path.dirname(home.options), { recursive: true });
    fs.writeFileSync(
      home.options,
      'logging:\n  # My note.\n  enabled: true\n  fights: true\n',
      'utf8'
    );
  });

  it('states the pair at its defaults, keeps the note, and is idempotent', () => {
    migrate();
    expect(readLogging()).toEqual({
      enabled: true,
      fights: true,
      conversations: true,
      conversationDays: 365
    });
    const once = fs.readFileSync(home.options, 'utf8');
    expect(once).toContain('# My note.');
    expect(once).toContain("Talk card's conversation history");
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toBe(once);
  });

  it('never overwrites a key the user already stated', () => {
    fs.writeFileSync(home.options, 'logging:\n  conversations: false\n', 'utf8');
    migrate();
    expect(readLogging()).toEqual({ conversations: false, conversationDays: 365 });
  });
});

/*
 * The escape stops naming a command the server does not have.
 *
 * `flee` was never in the realm's 94-command dispatch table, and the wire said
 * so eleven times in seventy seconds while a character died standing still
 * (`logs/2026-09-02_21-04-28_festus.mudcap.jsonl`). What makes this a migration
 * rather than a rename is that `normalizeConfig` ignores a key it does not
 * know: left alone, a file still saying `flee:` would silently revert to the
 * shipped defaults, so somebody who had switched running away **on** would have
 * it switched off by the fix.
 */
describe('the escape becomes a direction', () => {
  const stated = (body: string): void => {
    fs.mkdirSync(path.dirname(home.options), { recursive: true });
    fs.writeFileSync(home.options, body, 'utf8');
  };
  const safety = (): Record<string, Record<string, unknown>> =>
    (
      parse(fs.readFileSync(home.options, 'utf8')) as {
        automation: { safety: Record<string, Record<string, unknown>> };
      }
    ).automation.safety;

  it('renames the block in place and keeps every value on it', () => {
    stated(`automation:
  safety:
    flee:
      enabled: true
      belowHealth: 0.5
      whenOutnumbered: 3
      strategy: reverse-step
      safeHavenRoom: 'Newhaven, Town Gates 1/2150'
`);
    migrate();
    expect(safety()['flee']).toBeUndefined();
    expect(safety()['retreat']).toEqual({
      enabled: true,
      belowHealth: 0.5,
      whenOutnumbered: 3,
      // Both retired spellings named the word; both become the one that walks.
      strategy: 'step-back',
      safeHavenRoom: 'Newhaven, Town Gates 1/2150'
    });
  });

  it('carries the other retired strategy across too', () => {
    stated('automation:\n  safety:\n    flee:\n      strategy: flee\n');
    migrate();
    expect(safety()['retreat']?.['strategy']).toBe('step-back');
  });

  /* `safe-haven` always walked. It is the one thing in the old block that worked. */
  it('leaves the haven strategy exactly as it was', () => {
    stated('automation:\n  safety:\n    flee:\n      strategy: safe-haven\n');
    migrate();
    expect(safety()['retreat']?.['strategy']).toBe('safe-haven');
  });

  it('renames the pvp reaction with it', () => {
    stated('automation:\n  safety:\n    pvp:\n      action: flee\n');
    migrate();
    expect(safety()['pvp']?.['action']).toBe('retreat');
  });

  /* Whatever the person wrote above the block is theirs, and the block does not
     move: the pair is renamed in place rather than deleted and re-added. */
  it('keeps the comment the person wrote above it', () => {
    stated(`automation:
  safety:
    # Mine. Do not touch.
    flee:
      enabled: true
`);
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toContain('# Mine. Do not touch.');
  });

  /* Two blocks disagreeing about whether a character runs away is not something
     to resolve by guessing; the new one stands and the dead key goes. */
  it('drops the old key outright when both are stated', () => {
    stated(`automation:
  safety:
    flee:
      enabled: true
    retreat:
      enabled: false
`);
    migrate();
    expect(safety()['flee']).toBeUndefined();
    expect(safety()['retreat']).toEqual({ enabled: false });
  });

  it('says nothing about a file that never said it', () => {
    stated('automation:\n  safety:\n    retreat:\n      enabled: true\n');
    migrate();
    // Other steps in the chain still write to this file, so what is asserted is
    // that *this* one reported nothing — a migration that claims to have
    // changed something it did not is the failure the notices exist to prevent.
    expect(said.filter((m) => /renamed from flee/.test(m))).toEqual([]);
    expect(safety()['retreat']).toEqual({ enabled: true });
  });

  /*
   * And the prose, which is the other half of the file somebody reads. An
   * earlier template wrote paragraphs recommending the word by name; a comment
   * left saying *`flee` is the escape that works* is documentation for a
   * command that does nothing, in the file you edit to decide how you run away.
   */
  it('refreshes a comment that still recommends it, from the template', () => {
    stated(`automation:
  enabled: false
  # Running away outranks fighting. \`flee\` is proposed in the emergency band.
  combat:
    enabled: false
`);
    migrate(true);
    const written = fs.readFileSync(home.options, 'utf8');
    expect(written.split('\n').filter((l) => /flee/i.test(l))).toEqual([]);
    expect(written).toContain('Running away outranks fighting');
  });
});

describe('the new automation settings', () => {
  const OPTIONS = `automation:
  # The user's own note.
  enabled: true
  safety:
    retreat:
      enabled: false
  party:
    assistLeader: false
  spells:
    attack: ''
`;

  const read = (file: string): Record<string, Record<string, unknown>> =>
    (parse(fs.readFileSync(file, 'utf8')) as { automation: Record<string, never> }).automation;

  beforeEach(() => {
    fs.mkdirSync(path.dirname(home.options), { recursive: true });
    fs.writeFileSync(home.options, OPTIONS, 'utf8');
  });

  it('states the two new blocks and the in-block keys, at their defaults', () => {
    migrate();
    const automation = read(home.options);
    // `worthless` arrives with `statedTheEntityPredicates`, which runs after
    // this one and fills the same block — the two are asserted separately.
    expect(automation['drop']).toMatchObject({
      enabled: false,
      items: [],
      whenEncumbered: false
    });
    expect(automation['banking']).toEqual({
      autoDeposit: false,
      depositThresholdCopper: 50_000,
      keepCopper: 500
    });
    expect(automation['safety']?.['pvp']).toEqual({ notifyGang: false, action: 'none' });
    expect(automation['party']?.['defendParty']).toBe(false);
    expect(automation['spells']).toMatchObject({
      areaAttack: '',
      areaMinMobs: 3,
      areaMinMana: 0.35,
      notifyPartyOnWearOff: false
    });
  });

  it('never overwrites a key the user already stated', () => {
    fs.writeFileSync(
      home.options,
      'automation:\n  drop:\n    enabled: true\n    items: [rusty sword]\n',
      'utf8'
    );
    migrate();
    expect(read(home.options)['drop']).toMatchObject({ enabled: true, items: ['rusty sword'] });
  });

  /*
   * A profile gets the in-block keys only where it already states the block —
   * the options file is what is inherited, and writing whole default blocks
   * into every profile would freeze today's defaults into each.
   */
  it('reaches inside a profile block that is stated, and adds no new blocks to one', () => {
    const profile = home.profile('vaelor');
    fs.mkdirSync(profile.dir, { recursive: true });
    fs.writeFileSync(profile.file, "automation:\n  spells:\n    attack: 'ma'\n", 'utf8');
    migrate();
    const automation = read(profile.file);
    expect(automation['spells']).toMatchObject({ attack: 'ma', areaMinMobs: 3 });
    expect(automation['drop']).toBeUndefined();
    expect(automation['banking']).toBeUndefined();
    expect(automation['safety']).toBeUndefined();
  });

  it('keeps the notes the user wrote, says so once, and is idempotent', () => {
    migrate();
    const once = fs.readFileSync(home.options, 'utf8');
    expect(once).toContain("The user's own note");
    expect(said.join(' ')).toContain('New settings');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toBe(once);
  });
});

describe('the settings the entities made possible', () => {
  const read = (file: string): Record<string, Record<string, unknown>> =>
    (parse(fs.readFileSync(file, 'utf8')) as { automation: Record<string, never> }).automation;

  const write = (spells: string): void => {
    fs.mkdirSync(path.dirname(home.options), { recursive: true });
    fs.writeFileSync(home.options, `automation:\n${spells}`, 'utf8');
  };

  /* All off, so nothing about how the client behaves changes — what changes is
     that the file says the settings exist. */
  it('states the three at their defaults', () => {
    write('  loot:\n    coins: true\n  drop:\n    enabled: true\n');
    migrate();
    const automation = read(home.options);
    expect(automation['loot']).toMatchObject({ coins: true, minPrice: 0, maxEncumbrance: 0 });
    expect(automation['drop']).toMatchObject({ enabled: true, worthless: false });
    expect(said.join(' ')).toContain('Three settings were added');
  });

  /*
   * All five denominations, because that is what `coins: true` alone has always
   * meant — the migration must not quietly stop a character picking up copper.
   */
  it('states the cash settings so that nothing about looting changes', () => {
    write('  loot:\n    coins: true\n');
    migrate();
    expect(read(home.options)['loot']).toMatchObject({
      coins: true,
      coinKinds: ['runic', 'platinum', 'gold', 'silver', 'copper'],
      stopAtGrade: 'never',
      convertWith: '',
      convertAt: 'never'
    });
  });

  it('never overwrites what the file already states, and is idempotent', () => {
    write('  loot:\n    minPrice: 500\n  drop:\n    worthless: true\n');
    migrate();
    expect(read(home.options)['loot']).toMatchObject({ minPrice: 500 });
    expect(read(home.options)['drop']).toMatchObject({ worthless: true });
    const once = fs.readFileSync(home.options, 'utf8');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toBe(once);
  });

  /*
   * Reaching inside a block that is not there would be the migration inventing
   * configuration. Tested on a *profile*, because the options file legitimately
   * gains a whole `drop:` block from `statedTheNewAutomation` — a profile that
   * never mentioned one inherits it and is left alone.
   */
  it('adds nothing to a profile that states neither block', () => {
    write('  enabled: true\n');
    const profile = home.profile('vaelor');
    fs.mkdirSync(profile.dir, { recursive: true });
    fs.writeFileSync(profile.file, 'automation:\n  enabled: true\n', 'utf8');
    migrate();
    const automation = read(profile.file);
    expect(automation['loot']).toBeUndefined();
    expect(automation['drop']).toBeUndefined();
  });
});

describe('the heal became two spells and gained a ceiling', () => {
  const read = (file: string): Record<string, unknown> =>
    (
      parse(fs.readFileSync(file, 'utf8')) as {
        automation: { spells: Record<string, unknown> };
      }
    ).automation.spells;

  const write = (file: string, spells: string): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `automation:\n  spells:\n${spells}`, 'utf8');
  };

  /*
   * The seed is the whole reason this runs at migration time rather than being
   * left to the defaults: a file that was healing the party was doing it with
   * `heal`, so switching party healing off silently would be the migration
   * changing behaviour rather than preserving it.
   */
  it('carries the old single spell into the party field where the party was being healed', () => {
    write(home.options, "    heal: 'minor healing'\n    healParty: true\n");
    migrate();
    expect(read(home.options)).toMatchObject({
      heal: 'minor healing',
      healPartyWith: 'minor healing',
      healTo: 0
    });
  });

  /*
   * And not otherwise: a spell copied into a file with party healing off would
   * arm the party heal the moment somebody pressed the toolbar toggle, with a
   * spell they never chose for it.
   */
  it('leaves the party field blank where the party was not being healed', () => {
    write(home.options, "    heal: 'way of the swan'\n    healParty: false\n");
    migrate();
    expect(read(home.options)).toMatchObject({ heal: 'way of the swan', healPartyWith: '' });
  });

  /* 0 is the single cast at the threshold, which is what the client did
     before the pair existed — so nothing about it changes on migration. */
  it('adds the ceiling at the value that preserves today’s behaviour', () => {
    write(home.options, "    heal: ''\n");
    migrate();
    expect(read(home.options)['healTo']).toBe(0);
  });

  it('never overwrites what the file already states', () => {
    write(home.options, "    healPartyWith: 'mend'\n    healTo: 0.8\n");
    migrate();
    expect(read(home.options)).toMatchObject({ healPartyWith: 'mend', healTo: 0.8 });
  });

  it('reaches a profile that states the block, says so once, and is idempotent', () => {
    write(home.options, "    heal: ''\n");
    const profile = home.profile('vaelor');
    write(profile.file, "    heal: 'godheal'\n    healParty: true\n");
    migrate();
    expect(read(profile.file)).toMatchObject({ healPartyWith: 'godheal' });
    const once = fs.readFileSync(home.options, 'utf8');
    expect(said.join(' ')).toContain('Healing is two spells');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toBe(once);
  });

  /* A file with no spells block at all is left to the template, which fills a
     whole missing block; reaching inside one that is not there would be the
     migration inventing configuration. */
  it('leaves a file that states no spells block alone', () => {
    fs.mkdirSync(path.dirname(home.options), { recursive: true });
    fs.writeFileSync(home.options, 'automation:\n  enabled: true\n', 'utf8');
    migrate();
    const automation = (
      parse(fs.readFileSync(home.options, 'utf8')) as { automation: Record<string, unknown> }
    ).automation;
    expect(automation['spells']).toBeUndefined();
  });
});

/*
 * Resting gained a ceiling, because casting turns out to break a rest — see
 * `statedTheRestCeiling`. Written at 0, which is the single sit-down this
 * client has always done, so what changes is that the file says the setting
 * exists rather than how anything behaves.
 */
describe('the resting ceiling', () => {
  const read = (file: string): Record<string, unknown> =>
    (
      parse(fs.readFileSync(file, 'utf8')) as {
        automation: { health: Record<string, unknown> };
      }
    ).automation.health;

  const write = (file: string, health: string): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `automation:\n  health:\n${health}`, 'utf8');
  };

  it('adds it at the value that preserves today’s behaviour', () => {
    write(home.options, '    restBelow: 0.5\n');
    migrate();
    expect(read(home.options)).toMatchObject({ restBelow: 0.5, restTo: 0 });
  });

  /* Beside its partner, because the two are one pair: a ceiling filed under the
     potions reads as a third unrelated threshold. */
  it('puts it directly after the floor it belongs to', () => {
    write(home.options, '    restBelow: 0.5\n    meditateBelow: 0.2\n');
    migrate();
    const keys = Object.keys(read(home.options));
    expect(keys.indexOf('restTo')).toBe(keys.indexOf('restBelow') + 1);
  });

  it('never overwrites what the file already states', () => {
    write(home.options, '    restBelow: 0.5\n    restTo: 0.9\n');
    migrate();
    expect(read(home.options)['restTo']).toBe(0.9);
  });

  it('reaches a profile that states the block, says so once, and is idempotent', () => {
    write(home.options, '    restBelow: 0\n');
    const profile = home.profile('festus');
    write(profile.file, '    restBelow: 0.5\n');
    migrate();
    expect(read(profile.file)).toMatchObject({ restBelow: 0.5, restTo: 0 });
    const once = fs.readFileSync(home.options, 'utf8');
    expect(said.join(' ')).toContain('resting ceiling');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toBe(once);
  });

  /* A file with no health block is left to the template, which fills a whole
     missing block; reaching inside one that is not there would be the migration
     inventing configuration. */
  it('leaves a file that states no health block alone', () => {
    fs.mkdirSync(path.dirname(home.options), { recursive: true });
    fs.writeFileSync(home.options, 'automation:\n  enabled: true\n', 'utf8');
    migrate();
    const automation = (
      parse(fs.readFileSync(home.options, 'utf8')) as { automation: Record<string, unknown> }
    ).automation;
    expect(automation['health']).toBeUndefined();
  });
});

/*
 * Resting before a trap (`statedTheTrapRest`, todo 01, 2026-09-10): the same
 * gap the ceiling filled, one key along — a figure inside a block the file
 * already states reaches nobody through the template, and a setting nobody's
 * file names is one nobody finds.
 */
describe('resting before a trap', () => {
  const read = (file: string): Record<string, unknown> =>
    (
      parse(fs.readFileSync(file, 'utf8')) as {
        automation: { health: Record<string, unknown> };
      }
    ).automation.health;

  const write = (file: string, health: string): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `automation:\n  health:\n${health}`, 'utf8');
  };

  it('adds it at the shipped figure, directly after the ceiling', () => {
    write(home.options, '    restBelow: 0.5\n    restTo: 0.7\n    meditateBelow: 0.2\n');
    migrate();
    const health = read(home.options);
    expect(health['restBeforeTraps']).toBe(0.45);
    const keys = Object.keys(health);
    expect(keys.indexOf('restBeforeTraps')).toBe(keys.indexOf('restTo') + 1);
  });

  it('never overwrites what the file already states', () => {
    write(home.options, '    restBelow: 0.5\n    restBeforeTraps: 0.2\n');
    migrate();
    expect(read(home.options)['restBeforeTraps']).toBe(0.2);
  });

  it('reaches a profile, says so once, and is idempotent', () => {
    write(home.options, '    restBelow: 0\n');
    const profile = home.profile('festus');
    write(profile.file, '    restBelow: 0.5\n');
    migrate();
    expect(read(profile.file)).toMatchObject({ restBelow: 0.5, restBeforeTraps: 0.45 });
    const once = fs.readFileSync(profile.file, 'utf8');
    expect(said.join(' ')).toContain('Resting before a trap');
    migrate();
    expect(fs.readFileSync(profile.file, 'utf8')).toBe(once);
  });
});

/*
 * `restIsOnePair`. The loop's own health pair folds into the resting one, and
 * the user's numbers are carried across rather than discarded: a file that set
 * `loopPauseBelow` chose that figure deliberately, and dropping the key would
 * silently move the lap's floor.
 */
describe('the loop pause pair folded into the resting pair', () => {
  const read = (file: string): Record<string, unknown> =>
    (
      parse(fs.readFileSync(file, 'utf8')) as {
        automation: { health: Record<string, unknown> };
      }
    ).automation.health;

  const write = (file: string, health: string): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `automation:\n  health:\n${health}`, 'utf8');
  };

  it('carries the figures across into an absent rest pair', () => {
    write(home.options, '    loopPauseBelow: 0.6\n    loopResumeAt: 0.9\n');
    migrate();
    expect(read(home.options)).toEqual({ restBelow: 0.6, restTo: 0.9, restBeforeTraps: 0.45 });
  });

  /* The rest pair wins where both are stated: it is the one the settings screen
     has always drawn under "Rest If Below", so it is the half a person is more
     likely to have set on purpose. Overwriting it to preserve a figure they can
     no longer reach would change a setting they can see. */
  it('leaves a stated rest pair alone and drops the retired keys', () => {
    write(
      home.options,
      '    restBelow: 0.5\n    restTo: 0.75\n    loopPauseBelow: 0.6\n    loopResumeAt: 0.9\n'
    );
    migrate();
    expect(read(home.options)).toEqual({ restBelow: 0.5, restTo: 0.75, restBeforeTraps: 0.45 });
  });

  it('folds each half independently', () => {
    write(home.options, '    restBelow: 0.5\n    loopResumeAt: 0.9\n');
    migrate();
    expect(read(home.options)).toEqual({ restBelow: 0.5, restTo: 0.9, restBeforeTraps: 0.45 });
  });

  it('reaches a profile, says so once, and is idempotent', () => {
    write(home.options, '    restBelow: 0.5\n');
    const profile = home.profile('festus');
    write(profile.file, '    loopPauseBelow: 0.6\n    loopResumeAt: 0.9\n');
    migrate();
    expect(read(profile.file)).toEqual({ restBelow: 0.6, restTo: 0.9, restBeforeTraps: 0.45 });
    const once = fs.readFileSync(profile.file, 'utf8');
    expect(said.join(' ')).toContain('folded into the resting pair');
    migrate();
    expect(fs.readFileSync(profile.file, 'utf8')).toBe(once);
  });

  /* An emptied block reads as a setting somebody meant to fill in, which is the
     same reason `liftLoops` takes `automation:` with it when it empties. */
  /*
   * The fold runs *before* `statedTheRestCeiling`, which is what lets a stated
   * `loopResumeAt` become the ceiling. Run the other way round that migration
   * would write `restTo: 0` first and the fold would discard the figure as
   * already-stated -- so this asserts the ordering by its consequence, which is
   * the only place it is visible.
   */
  it('carries a lone resume figure across before the ceiling is stated', () => {
    write(home.options, '    loopResumeAt: 0.9\n');
    migrate();
    expect(read(home.options)).toMatchObject({ restTo: 0.9 });
  });

  it('leaves a file that states neither retired key alone', () => {
    write(home.options, '    restBelow: 0.5\n');
    migrate();
    expect(read(home.options)).toMatchObject({ restBelow: 0.5 });
  });
});

/*
 * `spells.buffs` and `party.blessings` became one list, `spells.blessings`,
 * with the rows carried across: name, spell and mana floor kept,
 * `intervalSeconds` renamed to `fallbackSeconds` (the same number, doing the
 * same job), and the target recording which list each row came from.
 */
describe('buffs and party blessings became spells.blessings', () => {
  const OPTIONS = `automation:
  # The user's own note.
  spells:
    attack: ''
    buffs:
      - name: armour
        spell: protection
        minMana: 0.3
        intervalSeconds: 600
  party:
    assistLeader: true
    blessings:
      - name: bless
        spell: bless
        intervalSeconds: 300
`;

  const read = (file: string): Record<string, Record<string, unknown>> =>
    (parse(fs.readFileSync(file, 'utf8')) as { automation: Record<string, never> }).automation;

  beforeEach(() => {
    fs.mkdirSync(path.dirname(home.options), { recursive: true });
    fs.writeFileSync(home.options, OPTIONS, 'utf8');
  });

  it('carries both lists into one, in order, and removes the old keys', () => {
    migrate();
    const automation = read(home.options);
    // `inCombat: false` written out on every carried row: the old module
    // refused combat outright, and the new default for self is `true` — a
    // carried row keeps its behaviour rather than gaining the new default.
    // `keyedBlessingsOnSpell` runs in the same pass: the carried rows come
    // out keyed on the spell alone, and only the party row keeps a clock.
    expect(automation['spells']?.['blessings']).toEqual([
      {
        spell: 'protection',
        target: 'self',
        inCombat: false,
        minMana: 0.3
      },
      { spell: 'bless', target: 'party', inCombat: false, fallbackSeconds: 300 }
    ]);
    expect(automation['spells']?.['buffs']).toBeUndefined();
    expect(automation['party']?.['blessings']).toBeUndefined();
    expect(automation['party']?.['assistLeader']).toBe(true);
    expect(said.join(' ')).toContain('spells.blessings');
  });

  it('renames an empty list too, so the stale key does not linger', () => {
    fs.writeFileSync(home.options, 'automation:\n  spells:\n    buffs: []\n', 'utf8');
    migrate();
    const automation = read(home.options);
    expect(automation['spells']?.['blessings']).toEqual([]);
    expect(automation['spells']?.['buffs']).toBeUndefined();
  });

  it('reaches a profile that states its own', () => {
    const profile = home.profile('vaelor');
    fs.mkdirSync(profile.dir, { recursive: true });
    fs.writeFileSync(
      profile.file,
      'automation:\n  party:\n    blessings:\n      - name: haste\n        spell: haste\n        intervalSeconds: 120\n',
      'utf8'
    );
    migrate();
    const automation = read(profile.file);
    expect(automation['spells']?.['blessings']).toEqual([
      { spell: 'haste', target: 'party', inCombat: false, fallbackSeconds: 120 }
    ]);
    expect(automation['party']?.['blessings']).toBeUndefined();
  });

  it('never overwrites a blessings key the user already stated', () => {
    fs.writeFileSync(
      home.options,
      'automation:\n  spells:\n    blessings: []\n    buffs:\n      - name: armour\n        spell: protection\n',
      'utf8'
    );
    migrate();
    const automation = read(home.options);
    expect(automation['spells']?.['blessings']).toEqual([]);
    // The old key stays: it is the record of what was not carried.
    expect(automation['spells']?.['buffs']).toEqual([{ name: 'armour', spell: 'protection' }]);
  });

  it('keeps the notes, says so once, and is idempotent', () => {
    migrate();
    const once = fs.readFileSync(home.options, 'utf8');
    expect(once).toContain("The user's own note");
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toBe(once);
  });

  /*
   * The second step on its own: a file already in the merged shape — rows
   * with a display name, and a clock on every row — is normalised to the
   * spell-keyed shape, and only the party row keeps its clock.
   */
  it('re-keys an already-merged list on the spell and strips the self clock', () => {
    fs.writeFileSync(
      home.options,
      [
        'automation:',
        '  spells:',
        '    blessings:',
        '      - name: armour',
        '        spell: protection',
        '        target: self',
        '        fallbackSeconds: 600',
        '      - name: bless',
        '        spell: bless',
        '        target: party',
        '        fallbackSeconds: 120',
        ''
      ].join('\n'),
      'utf8'
    );
    migrate();
    const automation = read(home.options);
    expect(automation['spells']?.['blessings']).toEqual([
      { spell: 'protection', target: 'self' },
      { spell: 'bless', target: 'party', fallbackSeconds: 120 }
    ]);
    const again = fs.readFileSync(home.options, 'utf8');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).toBe(again);
  });
});

/*
 * `autoReconnect`, written into a character's own file at the value it was
 * already running under. The behaviour does not change — absence reads as on —
 * so what this is for is the file *saying so*: a character's file is edited by
 * hand, and a setting reachable only from a form is the invisible-setting
 * failure with the settings screen papering over it.
 */
describe('stating auto-reconnect in a character file', () => {
  const write = (body: string): string => {
    const profile = home.profile('vaelor');
    fs.mkdirSync(profile.dir, { recursive: true });
    fs.writeFileSync(profile.file, body, 'utf8');
    return profile.file;
  };

  it('writes it on, beside the setting it is most confused with, with its paragraph', () => {
    const file = write('name: Vaelor\nserver: GreaterMUD (local)\nautoConnect: false\n');
    migrate();

    const text = fs.readFileSync(file, 'utf8');
    expect(parse(text)).toMatchObject({ autoConnect: false, autoReconnect: true });
    expect(text.indexOf('autoReconnect')).toBeGreaterThan(text.indexOf('autoConnect'));
    expect(text).toContain('a link that dropped');
    expect(said.join(' ')).toContain('Reconnect if the connection drops');
  });

  it('appends it to a file that never stated autoConnect either', () => {
    const file = write('name: Vaelor\nserver: GreaterMUD (local)\n');
    migrate();
    expect(parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ autoReconnect: true });
  });

  /* A key stays added whatever its value, so somebody who turned it off keeps
     it off — the property `pinTheGearButton`'s list cannot have. */
  it('leaves a character that turned it off alone, and is idempotent', () => {
    const file = write('name: Vaelor\nserver: GreaterMUD (local)\nautoReconnect: false\n');
    migrate();
    expect(parse(fs.readFileSync(file, 'utf8'))['autoReconnect']).toBe(false);

    const once = fs.readFileSync(file, 'utf8');
    migrate();
    expect(fs.readFileSync(file, 'utf8')).toBe(once);
  });

  /* A property of a character, so the options file has no such key to state. */
  it('never touches the options file', () => {
    fs.mkdirSync(home.globalDir, { recursive: true });
    fs.writeFileSync(home.options, 'ui: {}\n', 'utf8');
    migrate();
    expect(fs.readFileSync(home.options, 'utf8')).not.toContain('autoReconnect');
  });
});

/**
 * The `tuning:` keys added and retired on 2026-09-03, in a file that already
 * has a `tuning:` block — which is every file anybody is running.
 *
 * `reconcileWithTemplate` fills in an absent **top-level** block and never
 * reaches inside one, so these four reached nobody. The defaults still applied,
 * so nothing behaved wrongly; what was wrong is that `internal.yaml` exists so
 * that a number can be changed without waiting for a release, and four numbers
 * nobody can find in it are four numbers nobody can change.
 */
describe('the tuning keys 2026-09-03 added and retired', () => {
  const EXISTING = `tuning:
  net:
    connectTimeoutMs: 15000

  parse:
    # A note the user wrote about their own realm.
    maxPendingMoves: 12

  combat:
    movePendingMs: 8000
    roundMs: 100

  tally:
    markMs: 60000
    markLimit: 16

  view:
    clockTickMs: 1000
`;

  const tuning = (): Record<string, Record<string, number>> =>
    (parse(fs.readFileSync(home.internal, 'utf8')) as { tuning: Record<string, never> }).tuning;

  beforeEach(() => {
    fs.mkdirSync(path.dirname(home.internal), { recursive: true });
    fs.writeFileSync(home.internal, EXISTING, 'utf8');
  });

  it('writes the whole reconnect group in, at the shipped values', () => {
    migrate();
    expect(tuning()['reconnect']).toEqual(DEFAULT_INTERNAL.tuning.reconnect);
  });

  it('writes the two new keys into the blocks that already state them', () => {
    migrate();
    expect(tuning()['parse']?.['staleMoveMs']).toBe(DEFAULT_INTERNAL.tuning.parse.staleMoveMs);
    expect(tuning()['view']?.['rateFloorMs']).toBe(DEFAULT_INTERNAL.tuning.view.rateFloorMs);
  });

  /* A key this build no longer reads is a number somebody tunes and then waits
     to see work. Same reasoning as `dropDiagnosticsPreference`. */
  it('takes the retired keys out', () => {
    migrate();
    expect(tuning()['tally']).toBeUndefined();
    expect(tuning()['combat']?.['movePendingMs']).toBeUndefined();
    // And leaves the rest of that block alone.
    expect(tuning()['combat']?.['roundMs']).toBe(100);
  });

  it('keeps the notes the user wrote, says so, and is idempotent', () => {
    migrate();
    const once = fs.readFileSync(home.internal, 'utf8');
    expect(once).toContain('A note the user wrote');
    expect(said.join(' ')).toMatch(/internal\.yaml was brought up to date/);

    migrate();
    expect(fs.readFileSync(home.internal, 'utf8')).toBe(once);
  });

  /*
   * **The paragraphs come from the shipped template, not from here.** The
   * template is the documentation and a copy made by hand is a second copy to
   * keep in step — `theLoopSettlesAfterAnEscape`'s precedent, and the reason
   * this migration takes the template as an argument at all. Asked for by name,
   * like the other two cases in this file that are about the template.
   */
  it('brings each key’s paragraph across from the shipped template', () => {
    migrate(true);
    const text = fs.readFileSync(home.internal, 'utf8');
    expect(text).toMatch(/#[^\n]*Dialling back a connection that was LOST/);
    expect(text).toMatch(/#[^\n]*gives up on it/);
  });

  /* A file with no `tuning:` at all is `reconcileWithTemplate`'s job — it
     copies the whole top-level block with its comments — and not this one's. */
  it('does nothing to a file that states no tuning block', () => {
    fs.writeFileSync(home.internal, 'terminal:\n  enrich: true\n', 'utf8');
    migrate();
    expect(fs.readFileSync(home.internal, 'utf8')).toBe('terminal:\n  enrich: true\n');
  });
});

describe('light before the dark, and the supplies list', () => {
  const profile = (): string => home.profile('vaelor').file;

  beforeEach(() => {
    fs.writeFileSync(path.join(old, 'user.yaml'), OPTIONS, 'utf8');
    migrate();
    fs.mkdirSync(path.dirname(profile()), { recursive: true });
    fs.writeFileSync(
      profile(),
      'server: GreaterMUD (local)\nautomation:\n  movement:\n    # doors\n    openDoors: true\n',
      'utf8'
    );
  });

  it('writes the three keys into a movement block that lacks them, with the paragraph', () => {
    migrate();
    const movement = (
      parse(fs.readFileSync(profile(), 'utf8'))['automation'] as Record<string, unknown>
    )['movement'] as Record<string, unknown>;
    // `toMatchObject`: the door-forcing step fills its own four keys into the
    // same block on the same run.
    expect(movement).toMatchObject({
      openDoors: true,
      provideLight: true,
      lightDimRooms: false,
      extinguishInLight: true
    });
    const text = fs.readFileSync(profile(), 'utf8');
    expect(text).toContain('# doors');
    expect(text).toContain("MegaMUD's AutoLight");
    expect(said.some((m) => m.includes('dark room'))).toBe(true);
  });

  it('leaves a stated key alone and does not run twice', () => {
    fs.writeFileSync(
      profile(),
      'server: GreaterMUD (local)\nautomation:\n  movement:\n    provideLight: false\n',
      'utf8'
    );
    migrate();
    migrate();
    const movement = (
      parse(fs.readFileSync(profile(), 'utf8'))['automation'] as Record<string, unknown>
    )['movement'] as Record<string, unknown>;
    expect(movement['provideLight']).toBe(false);
    expect(said.filter((m) => m.includes('dark room'))).toHaveLength(0);
  });

  it('writes an empty supplies block into the options file once', () => {
    fs.writeFileSync(home.options, 'automation:\n  idle:\n    afterSeconds: 90\n', 'utf8');
    migrate();
    expect(
      (parse(fs.readFileSync(home.options, 'utf8'))['automation'] as Record<string, unknown>)[
        'supplies'
      ]
    ).toEqual({
      enabled: true,
      items: []
    });
    expect(said.some((m) => m.includes('supplies'))).toBe(true);
    migrate();
    expect(said.some((m) => m.includes('supplies'))).toBe(false);
    expect(fs.readFileSync(home.options, 'utf8')).toContain('Must Have Minimum');
  });

  it('leaves a file with no movement block alone', () => {
    fs.writeFileSync(profile(), 'server: GreaterMUD (local)\n', 'utf8');
    migrate();
    expect(parse(fs.readFileSync(profile(), 'utf8'))['automation']).toBeUndefined();
  });
});

/*
 * The pair added on 2026-09-05 with no migration behind it, which is how the
 * reporter's own options file came to end its `movement` block at
 * `extinguishInLight`: the switch that says whether a blind character walks on
 * existed everywhere except the file they were reading.
 */
describe('waiting a condition out', () => {
  const profile = (): string => home.profile('vaelor').file;

  beforeEach(() => {
    fs.writeFileSync(path.join(old, 'user.yaml'), OPTIONS, 'utf8');
    migrate();
    fs.mkdirSync(path.dirname(profile()), { recursive: true });
    fs.writeFileSync(
      profile(),
      'server: GreaterMUD (local)\nautomation:\n  movement:\n    # doors\n    openDoors: true\n',
      'utf8'
    );
  });

  it('writes the pair into a movement block that lacks it, with the paragraph', () => {
    migrate();
    const movement = (
      parse(fs.readFileSync(profile(), 'utf8'))['automation'] as Record<string, unknown>
    )['movement'] as Record<string, unknown>;
    // `toMatchObject`: door forcing and the light fill their own keys into the
    // same block on the same run.
    expect(movement).toMatchObject({
      openDoors: true,
      walkWhileBlind: false,
      walkWhilePoisoned: false
    });
    const text = fs.readFileSync(profile(), 'utf8');
    expect(text).toContain('# doors');
    expect(text).toContain('IgnoreBlind');
    // The half the defaults refuse to make configurable, which is the reason
    // the paragraph travels with the keys.
    expect(text).toContain('Paralysis always holds');
    expect(said.some((m) => m.includes('blind or poisoned'))).toBe(true);
  });

  it('leaves a stated key alone and does not run twice', () => {
    fs.writeFileSync(
      profile(),
      'server: GreaterMUD (local)\nautomation:\n  movement:\n    walkWhileBlind: true\n    walkWhilePoisoned: true\n',
      'utf8'
    );
    migrate();
    migrate();
    const movement = (
      parse(fs.readFileSync(profile(), 'utf8'))['automation'] as Record<string, unknown>
    )['movement'] as Record<string, unknown>;
    expect(movement['walkWhileBlind']).toBe(true);
    expect(said.filter((m) => m.includes('blind or poisoned'))).toHaveLength(0);
  });

  it('leaves a file with no movement block alone', () => {
    fs.writeFileSync(profile(), 'server: GreaterMUD (local)\n', 'utf8');
    migrate();
    expect(parse(fs.readFileSync(profile(), 'utf8'))['automation']).toBeUndefined();
  });
});

/*
 * The switch added on 2026-09-06 for the reported wall: a character standing on
 * sixty-six bone keys, told the door beside it needed a bone key. It ships on,
 * so a file that predates it behaves correctly and says nothing about it —
 * which is exactly the invisible-setting failure the two migrations above were
 * each written for.
 */
describe('bending down for the key to the way out', () => {
  const profile = (): string => home.profile('vaelor').file;

  beforeEach(() => {
    fs.writeFileSync(path.join(old, 'user.yaml'), OPTIONS, 'utf8');
    migrate();
    fs.mkdirSync(path.dirname(profile()), { recursive: true });
    fs.writeFileSync(
      profile(),
      'server: GreaterMUD (local)\nautomation:\n  movement:\n    # doors\n    openDoors: true\n',
      'utf8'
    );
  });

  it('writes the key into a movement block that lacks it, with the paragraph', () => {
    migrate();
    const movement = (
      parse(fs.readFileSync(profile(), 'utf8'))['automation'] as Record<string, unknown>
    )['movement'] as Record<string, unknown>;
    // `toMatchObject`: the light and the condition waits fill their own keys
    // into the same block on the same run.
    expect(movement).toMatchObject({ openDoors: true, collectKeys: true });
    const text = fs.readFileSync(profile(), 'utf8');
    expect(text).toContain('# doors');
    // The half somebody deciding whether to leave it on needs: what it will
    // *not* do, which is why the paragraph travels with the key.
    expect(text).toContain('Narrow on purpose');
    expect(said.some((m) => m.includes('key an exit of the room needs'))).toBe(true);
  });

  it('leaves a stated key alone and does not run twice', () => {
    fs.writeFileSync(
      profile(),
      'server: GreaterMUD (local)\nautomation:\n  movement:\n    collectKeys: false\n',
      'utf8'
    );
    migrate();
    migrate();
    const movement = (
      parse(fs.readFileSync(profile(), 'utf8'))['automation'] as Record<string, unknown>
    )['movement'] as Record<string, unknown>;
    expect(movement['collectKeys']).toBe(false);
    expect(said.filter((m) => m.includes('key an exit of the room needs'))).toHaveLength(0);
  });
});

/*
 * The archives this repository keeps became the two worlds the client bundles
 * on 2026-09-07, named after themselves — so a realm file naming one of them
 * relatively names the world by its word, and what was learned against an
 * archive's name is re-filed under the world's. Absolute paths are left to
 * `RealmLibrary.bundledFor`, which recognises the bytes.
 */
describe('the worlds are bundled', () => {
  const realm = (): string => home.server('paradigm').file;

  function stating(database: string): void {
    fs.mkdirSync(path.dirname(realm()), { recursive: true });
    fs.writeFileSync(
      realm(),
      `name: Paradigm\nhost: paramud.mudinfo.net\nport: 2323\n# my map\ndatabase: ${database}\n`,
      'utf8'
    );
  }

  const stated = (): unknown => parse(fs.readFileSync(realm(), 'utf8'))['database'];

  it('names a bundled world by its word where a relative path named its archive', () => {
    stating('mdb/2026-07-26-pmud.zip');
    migrate();
    expect(stated()).toBe('paradigm');
    expect(said.some((m) => m.includes('2026-07-26-pmud.zip') && m.includes('paradigm'))).toBe(
      true
    );
    expect(fs.readFileSync(realm(), 'utf8')).toContain('# my map');
    // Once: the word is not an archive name.
    migrate();
    expect(said.some((m) => m.includes('now names'))).toBe(false);
  });

  it('follows the earlier rename, so a loose name still lands on the word', () => {
    stating('mdb/default-pmud.mdb');
    migrate();
    expect(stated()).toBe('paradigm');
  });

  it('leaves an absolute path alone: the library recognises the bytes, a name cannot', () => {
    const mine = path.join(dir, 'realms');
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'pmud.zip'), 'x');
    stating(path.join(mine, 'pmud.zip'));
    migrate();
    expect(stated()).toBe(path.join(mine, 'pmud.zip'));
  });

  it('leaves a private realm alone, whatever it is called', () => {
    stating('mdb/my-own-pmud-edit.zip');
    migrate();
    expect(stated()).toBe('mdb/my-own-pmud-edit.zip');
  });

  it('re-files the lore, the destinations and the memory under the world', () => {
    const state = (name: string): string => home.state(name);
    fs.mkdirSync(home.state('memory'), { recursive: true });
    fs.writeFileSync(
      state('mob-lore.json'),
      JSON.stringify({
        v: 1,
        realms: {
          '2026-07-26-pmud.zip': { 'giant rat': { kills: 3, least: 12, most: 14 } },
          paradigm: { 'giant rat': { kills: 9, least: 11, most: 15 }, kobold: { kills: 1 } },
          'gmud20230902.mdb': { 'giant rat': { kills: 1 } }
        },
        slots: { 'data-v1.11p-mme2.0.zip': { '11': { words: ['torso'], at: 1 } } },
        spells: { 'pmud.zip': { bless: { start: { text: 'x', at: 1 } } } }
      })
    );
    fs.writeFileSync(
      state('destinations.json'),
      JSON.stringify({
        v: 1,
        realms: {
          '2026-07-26-pmud.zip': [
            { id: '1/1', name: 'Town Square', at: 5 },
            { id: '1/2', name: 'Bank', at: 4 }
          ],
          paradigm: [{ id: '1/1', name: 'Town Square', at: 5 }]
        }
      })
    );
    fs.writeFileSync(
      path.join(home.state('memory'), 'festus.json'),
      JSON.stringify({
        version: 1,
        realm: '2026-07-26-pmud.zip',
        discoveries: [
          {
            reason: 'unknown-exit',
            from: '1/1',
            fromName: 'Town Square',
            command: 'n',
            to: null,
            name: '',
            exits: [],
            at: 1
          }
        ]
      })
    );
    fs.writeFileSync(
      path.join(home.state('memory'), 'realm-2026-07-26-pmud.zip.json'),
      JSON.stringify({
        version: 1,
        realm: '2026-07-26-pmud.zip',
        discoveries: [
          {
            reason: 'unknown-stock',
            from: '1/2',
            fromName: 'Bank',
            command: 'list',
            to: null,
            name: '',
            exits: [],
            at: 1
          }
        ]
      })
    );
    migrate();

    const lore = JSON.parse(fs.readFileSync(state('mob-lore.json'), 'utf8'));
    // The world's own entry wins; the archive's adds what it lacked.
    expect(lore.realms.paradigm['giant rat']).toEqual({ kills: 9, least: 11, most: 15 });
    expect(lore.realms.paradigm.kobold).toEqual({ kills: 1 });
    expect(lore.realms['2026-07-26-pmud.zip']).toBeUndefined();
    // A database that is no bundled world is not touched.
    expect(lore.realms['gmud20230902.mdb']).toEqual({ 'giant rat': { kills: 1 } });
    expect(lore.slots.majormud['11']).toEqual({ words: ['torso'], at: 1 });
    expect(lore.spells.paradigm.bless).toBeDefined();

    const destinations = JSON.parse(fs.readFileSync(state('destinations.json'), 'utf8'));
    expect(destinations.realms.paradigm).toEqual([
      { id: '1/1', name: 'Town Square', at: 5 },
      { id: '1/2', name: 'Bank', at: 4 }
    ]);
    expect(destinations.realms['2026-07-26-pmud.zip']).toBeUndefined();

    const festus = JSON.parse(
      fs.readFileSync(path.join(home.state('memory'), 'festus.json'), 'utf8')
    );
    expect(festus.realm).toBe('paradigm');
    expect(festus.discoveries).toHaveLength(1);
    expect(fs.existsSync(path.join(home.state('memory'), 'realm-2026-07-26-pmud.zip.json'))).toBe(
      false
    );
    const shared = JSON.parse(
      fs.readFileSync(path.join(home.state('memory'), 'realm-paradigm.json'), 'utf8')
    );
    expect(shared.realm).toBe('paradigm');
    expect(shared.discoveries).toHaveLength(1);

    expect(said.some((m) => /re-filed under the bundled world/.test(m))).toBe(true);
    // Nothing left to re-file: silent the second time.
    migrate();
    expect(said.some((m) => /re-filed/.test(m))).toBe(false);
  });

  it('leaves a lore file that will not parse exactly as it is', () => {
    fs.mkdirSync(path.dirname(home.state('mob-lore.json')), { recursive: true });
    fs.writeFileSync(home.state('mob-lore.json'), '{broken');
    migrate();
    expect(fs.readFileSync(home.state('mob-lore.json'), 'utf8')).toBe('{broken');
  });
});

/*
 * The realm databases became zips on 2026-09-04 and the loose copies went, so a
 * realm file naming one by its old name names a file that is not there. Left
 * alone, that is the announced fallback to the shipped world on every single
 * connection — for a rename nobody made on purpose.
 */
describe('the realm databases were zipped', () => {
  const realm = (): string => home.server('greatermud-local').file;

  function stating(database: string): void {
    fs.mkdirSync(path.dirname(realm()), { recursive: true });
    fs.writeFileSync(
      realm(),
      `name: GreaterMUD (local)\nhost: orohost\nport: 2427\n# my map\ndatabase: ${database}\n`,
      'utf8'
    );
  }

  const stated = (): unknown => parse(fs.readFileSync(realm(), 'utf8'))['database'];

  it('rewrites the shipped relative path on the name alone', () => {
    // Relative can only have come from a file the client ships, and that file
    // is gone from the package by definition — there is nothing to check.
    stating('mdb/gmud20230902.mdb');
    migrate();
    expect(stated()).toBe(path.join('mdb', '2023-09-02-gmud.zip'));
    expect(said.some((m) => m.includes('2023-09-02-gmud.zip'))).toBe(true);
    // The comment above the key is the documentation in these files.
    expect(fs.readFileSync(realm(), 'utf8')).toContain('# my map');
  });

  it('rewrites an absolute path only when the archive is really beside it', () => {
    const mine = path.join(dir, 'realms');
    fs.mkdirSync(mine, { recursive: true });
    stating(path.join(mine, 'default-pmud.mdb'));
    migrate();
    // Nothing there to point at: the path stands, and the fallback says so at
    // connection time as it always has.
    expect(stated()).toBe(path.join(mine, 'default-pmud.mdb'));
    expect(said.some((m) => m.includes('zipped'))).toBe(false);

    fs.writeFileSync(path.join(mine, '2026-07-26-pmud.zip'), 'not really an archive');
    migrate();
    expect(stated()).toBe(path.join(mine, '2026-07-26-pmud.zip'));
  });

  it('leaves a path that still resolves alone, whatever it names', () => {
    const mine = path.join(dir, 'realms');
    fs.mkdirSync(mine, { recursive: true });
    // Both files present: their loose copy is still there, so it is still
    // their answer. A migration that edited a path that resolves would be
    // answering a question nobody asked.
    fs.writeFileSync(path.join(mine, 'default-pmud.mdb'), 'x');
    fs.writeFileSync(path.join(mine, '2026-07-26-pmud.zip'), 'x');
    stating(path.join(mine, 'default-pmud.mdb'));
    migrate();
    expect(stated()).toBe(path.join(mine, 'default-pmud.mdb'));
  });

  it('leaves a private realm alone: this is two renames, not a rule about .mdb', () => {
    const mine = path.join(dir, 'realms');
    fs.mkdirSync(mine, { recursive: true });
    stating(path.join(mine, 'my-own-realm.mdb'));
    migrate();
    expect(stated()).toBe(path.join(mine, 'my-own-realm.mdb'));
    expect(said.some((m) => m.includes('zipped'))).toBe(false);
  });

  it('says so once, not on every launch', () => {
    stating('mdb/gmud20230902.mdb');
    migrate();
    migrate();
    expect(said.filter((m) => m.includes('zipped'))).toHaveLength(0);
  });
});

/*
 * The search count retires — todo 04, 2026-09-06.
 *
 * A `Hidden/Searchable` exit is one the realm's own data says a search reveals,
 * and giving up after two rolls of a skill check struck a real corridor out of
 * every route for the session. The searching is unbounded now and the pace is
 * what is left, so `tuning.walk.searchTries` reads nothing and has to go —
 * `internal.test.ts` asserts the shipped template normalises to the constant
 * exactly, and a key nothing reads is a number somebody sets and waits on.
 */
describe('the walker’s search count', () => {
  const withTries = `tuning:
  walk:
    # My own note about this one.
    searchTries: 5
    maxHolds: 4
`;

  const walkBlock = (): Record<string, unknown> =>
    (parse(fs.readFileSync(home.internal, 'utf8')) as { tuning: { walk: Record<string, unknown> } })
      .tuning.walk;

  beforeEach(() => {
    fs.mkdirSync(path.dirname(home.internal), { recursive: true });
    fs.writeFileSync(home.internal, withTries, 'utf8');
  });

  it('takes the retired key out and leaves the rest of the block alone', () => {
    migrate();
    expect(walkBlock()['searchTries']).toBeUndefined();
    expect(walkBlock()['maxHolds']).toBe(4);
  });

  /*
   * The number is deliberately **not** carried into `searchRetryMs`: a count
   * of searches and a delay between them are not the same quantity, and
   * writing 5 into a milliseconds field would be the migration inventing a
   * figure.
   */
  /*
   * The number is deliberately not *carried* — a count of searches and a delay
   * between them are not the same quantity — but the two keys that replace it
   * are written in, with their paragraphs. A retired key removed and its
   * replacements absent is the invisible-setting failure in a new place, in
   * the one file this user hand-edits as a scratchpad.
   */
  it('writes in the keys that replace it, at their own defaults', () => {
    migrate();
    expect(walkBlock()['searchRetryMs']).toBe(DEFAULT_INTERNAL.tuning.walk.searchRetryMs);
    expect(walkBlock()['leverTries']).toBe(DEFAULT_INTERNAL.tuning.walk.leverTries);
  });

  it('says so, because a figure that vanished silently is one nobody trusts', () => {
    migrate();
    expect(said.join(' ')).toContain('searchTries');
  });

  it('does nothing on a second run', () => {
    migrate();
    const after = fs.readFileSync(home.internal, 'utf8');
    migrate();
    expect(fs.readFileSync(home.internal, 'utf8')).toBe(after);
  });

  /* A file that never had it is untouched by *this* migration — another one
     fills the nudge figures in, which is not this one's business. */
  it('leaves a file that never had it alone', () => {
    fs.writeFileSync(home.internal, 'tuning:\n  walk:\n    maxHolds: 4\n', 'utf8');
    migrate();
    expect(walkBlock()['searchTries']).toBeUndefined();
    expect(walkBlock()['maxHolds']).toBe(4);
    expect(said.join(' ')).not.toContain('searchTries');
  });

  /* And the fumble delay, the other key this build added. */
  it('writes in the queue’s fumble delay too', () => {
    fs.writeFileSync(home.internal, 'tuning:\n  queue:\n    midRoundMs: 100\n', 'utf8');
    migrate();
    const queue = (
      parse(fs.readFileSync(home.internal, 'utf8')) as {
        tuning: { queue: Record<string, unknown> };
      }
    ).tuning.queue;
    expect(queue['fumbleRetryMs']).toBe(DEFAULT_INTERNAL.tuning.queue.fumbleRetryMs);
  });
});
