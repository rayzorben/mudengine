import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { DEFAULT_CONFIG, DEFAULT_REALM_NAME, asServer, normalizeConfig } from '../config';

/**
 * What a fresh install dials, and what it does not.
 *
 * Everything under `resources/` is copied verbatim into the package, and
 * `locales/ui.en.yaml` is inlined into the bundle — so a value left in any of
 * them is shipped to everybody who installs this. That has been wrong twice in
 * the same way: `connection.host` was `gmud-tgs` in `DEFAULT_CONFIG` and
 * `orohost` in the template, both of them a private GreaterMUD box on one
 * developer's network, and the one realm the client seeded on first run
 * pointed at it. A default nobody else can reach is a client that cannot be
 * given to anybody.
 *
 * **Stated as a positive control rather than as a list of names to forbid.**
 * A test that greps for `orohost` passes the moment somebody's own machine is
 * called something else; asserting that every shipped realm dials the realm
 * this client ships *for* fails whichever private address takes its place.
 */
const PARADIGM_HOST = 'paramud.mudinfo.net';
const SERVERS = path.resolve('resources/servers');

/**
 * Whether an address is one somebody who is not on this network can reach.
 *
 * This is the positive control, generalised — and generalising it is what let a
 * second realm ship. Naming Paradigm's host was the control while Paradigm was
 * the only thing here; the moment a GreaterMUD realm joined it, that assertion
 * had to become either a second literal (which passes for whatever private
 * address takes its place next) or the property the literal was standing in
 * for. This is the property: **a shipped realm must be reachable from off this
 * network.** It fails for every spelling of the failure that has actually
 * happened here — `gmud-tgs` and `orohost` (bare names, resolvable on one
 * network), `localhost`, `127.0.0.1`, the RFC1918 ranges, and 100.64/10, which
 * is the carrier-grade block Tailscale hands out and which `orohost` resolves
 * inside today.
 */
function reachableFromAnywhere(host: string): boolean {
  const name = host.trim().toLowerCase();
  if (name.length === 0 || name === 'localhost') return false;

  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (octets) {
    const parts = octets.slice(1).map(Number);
    // Four numbers separated by dots is not yet an address: `999.1.1.1` reads
    // as reachable to a check that only looks at the first two.
    if (parts.some((part) => part > 255)) return false;
    const [a, b] = parts as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 169 && b === 254) return false;
    // 100.64/10 — carrier-grade NAT, and what Tailscale hands out.
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }

  // A name with no dot in it resolves on one network's search domain and
  // nowhere else, which is exactly what `gmud-tgs` and `orohost` are. So does
  // anything under a private tailnet suffix, dots and all.
  if (!name.includes('.')) return false;
  return !name.endsWith('.ts.net') && !name.endsWith('.local');
}

/** Every realm directory the client seeds on first run. */
const shipped = fs
  .readdirSync(SERVERS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/** Every shipped realm, read the way the client reads one. */
function realmOf(id: string) {
  return asServer(YAML.parse(fs.readFileSync(path.join(SERVERS, id, 'server.yaml'), 'utf8')), id);
}

describe('the realms the client ships', () => {
  it('is Paradigm’s six and GMUD, one directory per realm', () => {
    // A count, so deleting one is a decision somebody makes here rather than a
    // directory that goes missing.
    expect(shipped).toEqual([
      'gmud-5x',
      'paradigm-game-1-pve',
      'paradigm-game-2-pvp',
      'paradigm-game-3',
      'paradigm-game-4',
      'paradigm-test-pve',
      'paradigm-test-pvp'
    ]);
  });

  it.each(shipped)('%s loads, and dials somewhere anybody can reach', (id) => {
    const server = realmOf(id);

    // Not merely parseable: a realm the client would drop is a Realms page
    // that comes up short with nothing said.
    expect(server).not.toBeNull();
    expect(server?.encoding).toBe('cp437');
    // The rule this file exists for, and the one that has been broken twice.
    expect(reachableFromAnywhere(server?.host ?? '')).toBe(true);

    /*
     * A `database:` here is **relative or nothing**, never absolute.
     *
     * That was `toBe('')` while every shipped realm used the built-in world,
     * and the rule behind it was never "no database" — it was *no path that
     * exists on one computer*. A realm naming `/home/somebody/…` falls back on
     * every install with a notice, which is the failure the assertion was
     * about; a relative path resolves against the client's own resources
     * wherever it is installed (`RealmLibrary.resolve`).
     */
    const database = server?.database ?? '';
    expect(path.isAbsolute(database)).toBe(false);
    // And it has to actually be there, or the realm falls back to a map that is
    // not its own — silently, as far as anything in this suite could tell.
    if (database.length > 0) {
      expect(fs.existsSync(path.resolve('resources', database))).toBe(true);
    }
  });

  /*
   * And the seventh is pinned literally, exactly as the six are.
   *
   * `reachableFromAnywhere` is the property every shipped realm must have; it
   * is not a substitute for somebody having *stated* where a realm dials. Left
   * to the property alone, this realm's host could be changed to any public
   * address — a different server, somebody's VPS — and the suite would stay
   * green, which is the hole the Paradigm literal was closing before there was
   * a second realm to cover.
   */
  it('dials GMUD at the address it was added for', () => {
    const server = realmOf('gmud-5x');
    expect(server?.name).toBe(DEFAULT_REALM_NAME);
    expect(server?.host).toBe('70.176.151.219');
    expect(server?.port).toBe(2427);
  });

  it('gives GMUD its own map, because the built-in one is Paradigm’s', () => {
    /*
     * The realm the client defaults to is a GreaterMUD one and the world built
     * into the client is Paradigm's. Left to the built-in map, every new
     * character would resolve rooms against names that are not in the realm
     * they are standing in — which degrades honestly (the client says it is
     * lost) and is useless, and there is no other check that would notice.
     */
    expect(realmOf('gmud-5x')?.database).toBe('mdb/gmud20230902.mdb');
  });

  it('leaves the Paradigm six on the built-in world, which is already theirs', () => {
    for (const id of shipped.filter((name) => name.startsWith('paradigm-'))) {
      expect(realmOf(id)?.database).toBe('');
    }
  });

  it.each(shipped.filter((id) => id.startsWith('paradigm-')))('%s answers Paradigm', (id) => {
    const server = realmOf(id);
    expect(server?.host).toBe(PARADIGM_HOST);
    expect([2323, 2324]).toContain(server?.port);

    // The realm number is the whole reason there are six of these. A file
    // that cannot answer the realm menu logs in to whichever realm the server
    // defaults to, which is somebody else's map.
    const realm = server?.login.find((step) => /select a realm/i.test(step.when));
    expect(realm?.send).toMatch(/^[1-4]$/);
  });

  it.each(shipped)('%s can answer every menu it will meet', (id) => {
    /*
     * A menu with no row is left alone silently, which is right for one this
     * client has never seen and wrong for the three every WorldGroup front end
     * puts up. A realm missing one of these stalls at it with the player
     * watching a prompt nobody is going to answer.
     */
    const steps = realmOf(id)?.login ?? [];
    for (const prompt of [/enter your selection/i, /select a realm/i, /select a character/i]) {
      expect(steps.some((step) => prompt.test(step.when))).toBe(true);
    }
  });

  it('gives every realm its own name, because a character addresses one by name', () => {
    const names = shipped.map((id) => {
      const file = path.join(SERVERS, id, 'server.yaml');
      return asServer(YAML.parse(fs.readFileSync(file, 'utf8')), id)?.name;
    });
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('what a new realm starts from', () => {
  it('is Paradigm in the constant', () => {
    expect(DEFAULT_CONFIG.connection.host).toBe(PARADIGM_HOST);
    expect(DEFAULT_CONFIG.connection.port).toBe(2323);
  });

  /*
   * The pair `internal.yaml` and `DEFAULT_INTERNAL` drifted once and cost a
   * day; the options template and `DEFAULT_CONFIG` drifted twice, and this is
   * the half of that pair somebody edits by hand while pointing the client at
   * their own server.
   */
  it('is Paradigm in the template too', () => {
    const template = normalizeConfig(
      YAML.parse(fs.readFileSync(path.resolve('resources/config/default.yaml'), 'utf8'))
    );
    expect(template.connection.host).toBe(DEFAULT_CONFIG.connection.host);
    expect(template.connection.port).toBe(DEFAULT_CONFIG.connection.port);
    expect(template.connection.login.steps).toEqual(DEFAULT_CONFIG.connection.login.steps);
  });

  it('ships no credential anywhere in it', () => {
    expect(DEFAULT_CONFIG.connection.login.username).toBe('');
    expect(DEFAULT_CONFIG.connection.login.password).toBe('');
    expect(DEFAULT_CONFIG.connection.login.enabled).toBe(false);
  });
});

describe('the character template', () => {
  const text = fs.readFileSync(path.resolve('resources/config/profile.default.yaml'), 'utf8');

  it('names a realm that actually ships', () => {
    const raw = YAML.parse(text) as { server?: unknown };
    expect(shipped.map((id) => realmOf(id)?.name)).toContain(raw.server);
  });

  /*
   * The third closed pair in this file, and it exists because the default used
   * to be stated nowhere: the settings screen took `servers[0]`, so which realm
   * a new character started on was decided by whichever directory sorted first
   * — a choice nobody had made, that moved when a realm was added, and that
   * could only be changed by renaming a directory. `DEFAULT_REALM_NAME` states
   * it; this holds the template and the shipped realm to it.
   */
  it('names the realm the constant names, and that realm ships', () => {
    const raw = YAML.parse(text) as { server?: unknown };
    expect(raw.server).toBe(DEFAULT_REALM_NAME);
    expect(shipped.map((id) => realmOf(id)?.name)).toContain(DEFAULT_REALM_NAME);
  });

  it('states no account', () => {
    // Every `account:` line in it is commented out. A template carrying a
    // username is a template somebody fills a password in beside and commits.
    const raw = YAML.parse(text) as { account?: unknown };
    expect(raw.account).toBeUndefined();
  });
});
