import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { homeAt, homeRoot } from '../home';

describe('the tree', () => {
  const home = homeAt('/data');

  it('puts every scope where the layout says', () => {
    expect(home.options).toBe(path.join('/data', 'global', 'default.yaml'));
    expect(home.globalLoops).toBe(path.join('/data', 'global', 'loops'));
    expect(home.server('greatermud').file).toBe(
      path.join('/data', 'servers', 'greatermud', 'server.yaml')
    );
    expect(home.profile('vaelor').loops).toBe(path.join('/data', 'profiles', 'vaelor', 'loops'));
    expect(home.state('memory', 'vaelor.json')).toBe(path.join('/data', 'memory', 'vaelor.json'));
  });

  /*
   * The point of the module: a test or a harness names one directory and gets
   * the whole tree, rather than an environment variable per record it wants to
   * keep out of the developer's own.
   */
  it('is a function of the root and nothing else', () => {
    expect(homeAt('/elsewhere').internal).toBe(path.join('/elsewhere', 'internal.yaml'));
  });
});

describe('where the root is', () => {
  it('is the platform’s own answer when nobody says otherwise', () => {
    expect(homeRoot({}, '/home/someone/.config/mudengine')).toEqual({
      root: '/home/someone/.config/mudengine'
    });
  });

  /* An instruction, not a candidate: a search path only wins if what it names
     already exists, which is how a harness asking for a clean configuration
     used to get the developer's real one. */
  it('obeys MUDENGINE_HOME outright', () => {
    expect(homeRoot({ MUDENGINE_HOME: '/tmp/run' }, '/ignored').root).toBe('/tmp/run');
  });

  /*
   * The variable every harness and shell profile still has set named a *file*.
   * Silently ignoring it is how a test run ends up writing into somebody's real
   * options, so its directory is taken and the change is said out loud.
   */
  it('takes the directory of the variable it replaces, and says so', () => {
    const asked = homeRoot({ MUDENGINE_CONFIG: '/tmp/run/user.yaml' }, '/ignored');
    expect(asked.root).toBe('/tmp/run');
    expect(asked.note).toContain('MUDENGINE_HOME');
  });

  it('prefers the new name when both are set', () => {
    expect(homeRoot({ MUDENGINE_HOME: '/a', MUDENGINE_CONFIG: '/b/user.yaml' }, '/c')).toEqual({
      root: '/a'
    });
  });
});
