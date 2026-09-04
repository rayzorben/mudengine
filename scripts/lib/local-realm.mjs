/**
 * The one place that says where the test realm is, and who may be told a
 * password.
 *
 * Every probe used to spell this out for itself: a `HOST` constant, a loop over
 * the profile files, and `host !== 'localhost' && host !== '127.0.0.1'`. Eight
 * copies of a rule whose whole purpose is that it is never wrong — and the
 * failure mode of a missed copy is not a broken script, it is a script that
 * quietly skips, or one that sends somebody's credentials to a host the rule
 * exists to keep them away from.
 *
 * Renaming the test server is what proved it: the server moved and the repo
 * disagreed with itself in eight files, three names deep (`localhost`,
 * `orohost`, `gmud-tgs`) — which had already left two test expectations
 * asserting a hostname their own fixture did not use.
 *
 * **Credentials never leave this target.** That is enforced here, structurally,
 * by never returning a profile that points anywhere else. Anything that dials
 * a third party — `bbs.bearfather.net` is the only sanctioned one, read-only
 * and pre-login — must not use `localProfiles`.
 *
 * See CLAUDE.md, "Sanctioned servers, and the credential rule".
 */
import fs from 'node:fs';
import path from 'node:path';

import { homePaths } from './home.mjs';
import YAML from 'yaml';

import { resolveProfile } from '../../src/shared/profiles.ts';

/**
 * The GreaterMUD test realm.
 *
 * It has now been called four things. `gmud-tgs` stopped resolving at all —
 * and because `orohost` was not in the set below, every probe went on
 * *skipping cleanly*: `localProfiles()` matched no character, each script said
 * "no character configured" and exited zero. Which is the failure this module's
 * own header warns about, arriving through the one door it left open.
 */
export const HOST = 'orohost';
export const PORT = 2427;

/**
 * The names that mean *this* realm.
 *
 * Every name kept, and the old ones deliberately: the server is reachable as
 * `orohost` from one machine and as `localhost` from the machine it runs on,
 * and an options file written any time in the past year names it `gmud-tgs`.
 * All of them are the same sanctioned target. What the rule refuses is a
 * *third party*, not another spelling of the same host — and a spelling
 * dropped from this set does not fail loudly, it makes every probe skip.
 */
const LOCAL_NAMES = new Set([HOST, 'gmud-tgs', 'localhost', '127.0.0.1', '::1']);

export function isLocalRealm(host) {
  return LOCAL_NAMES.has(
    String(host ?? '')
      .trim()
      .toLowerCase()
  );
}

/** Where to dial, for a probe that has decided to. */
export function target(encoding = 'cp437') {
  return { host: HOST, port: PORT, encoding };
}

/** The options file this run reads. See `scripts/lib/home.mjs`. */
export function configPath() {
  return homePaths().options;
}

/**
 * Every character that plays on the test realm **and** has credentials, in
 * filename order.
 *
 * Chosen by *target*, never by filename: a file renamed, or a second character
 * added, cannot send a password somewhere else by accident. A profile that
 * will not resolve is skipped rather than guessed at, exactly as the client
 * skips it.
 */
export function localProfiles() {
  const home = homePaths();
  const source = baseConfig(home);
  if (!fs.existsSync(home.profilesDir)) return [];

  const found = [];
  for (const id of fs
    .readdirSync(home.profilesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()) {
    let raw;
    try {
      raw = YAML.parse(fs.readFileSync(home.profile(id).file, 'utf8'));
    } catch {
      continue;
    }
    if (!raw) continue;
    const result = resolveProfile(id, raw, source);
    if (result.error !== undefined) continue;
    if (!isLocalRealm(result.profile.target.host)) continue;
    if (!result.profile.config.connection.login.username) continue;
    found.push(result.profile);
  }
  return found;
}

/**
 * The options file with the servers on disk folded in.
 *
 * Servers are files now (`servers/<id>/server.yaml`), and a character names one
 * by name — so a base without them resolves no character at all, and every
 * probe would print "no character configured" and exit zero. Which is exactly
 * the silence CLAUDE.md records this realm's rename causing once already.
 *
 * Exported for `check-secrets.mjs`, which resolves every character for the
 * opposite reason — to learn the passwords it must then find nowhere else —
 * and which had gone on resolving against the bare options file for a day
 * after the servers moved, finding no character and so no password.
 */
export function baseConfig(home) {
  let source = {};
  try {
    source = YAML.parse(fs.readFileSync(home.options, 'utf8')) ?? {};
  } catch {
    source = {};
  }

  const servers = [...(Array.isArray(source.servers) ? source.servers : [])];
  let ids = [];
  try {
    ids = fs
      .readdirSync(home.serversDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    ids = [];
  }
  for (const id of ids) {
    try {
      const server = YAML.parse(fs.readFileSync(home.server(id).file, 'utf8'));
      if (!server?.host) continue;
      const at = servers.findIndex(
        (entry) =>
          String(entry?.name ?? '').toLowerCase() === String(server.name ?? id).toLowerCase()
      );
      const named = { name: server.name ?? id, ...server };
      if (at === -1) servers.push(named);
      else servers[at] = named;
    } catch {
      // A server that will not parse is one the client would skip too.
    }
  }
  return { ...source, servers };
}

/** The first such character, or null. */
export function localProfile() {
  return localProfiles()[0] ?? null;
}

/**
 * One of ours by directory id (`soul`, `yang`), for a probe that needs a
 * particular character — a low-level one for a room behind a level gate. The
 * same list as above, so it can only ever hand out a character on the local
 * realm; a name not in it is null, never a fallback to the first.
 */
export function localProfileNamed(id) {
  const wanted = String(id).trim().toLowerCase();
  return localProfiles().find((profile) => profile.id.toLowerCase() === wanted) ?? null;
}

/**
 * How a probe's exit is read.
 *
 * Three answers, and the middle one is why this exists. A probe that could
 * not find a character says so *differently* from one that ran and found
 * nothing: the evening `orohost` was missing from the name set, every probe
 * printed "no character configured" and exited zero, and nothing was red. A
 * suite that goes quiet is worse than one that goes wrong.
 *
 * - `0` — ran, and found what it went looking for.
 * - `2` — ran, and found nothing. Still a result; a check can assert on it.
 * - `3` — could not run: no character, no credentials, wrong realm. Distinct
 *   from both, so a runner that expected a probe to *run* can tell.
 */
export const EXIT = Object.freeze({ found: 0, nothing: 2, skipped: 3 });

/**
 * Says why a probe cannot run, and exits with `EXIT.skipped`.
 *
 * Not a failure — "no character configured" is a developer's machine, not a
 * defect — but not success either. The exit code is what tells a caller which
 * of the two happened; the message is for the person watching.
 */
export function skip(reason) {
  console.log(`\nSKIPPED: ${reason} (exit ${EXIT.skipped})\n`);
  process.exit(EXIT.skipped);
}

/**
 * Says a probe ran and found nothing, and exits with `EXIT.nothing`.
 *
 * For a probe whose point is to surface something — a line the classifier
 * could not read, a channel the server carries — and that surfaced none.
 * That may be the good news; it is still distinguishable from not having run.
 */
export function nothing(reason) {
  console.log(`\nNOTHING FOUND: ${reason} (exit ${EXIT.nothing})\n`);
  process.exit(EXIT.nothing);
}
