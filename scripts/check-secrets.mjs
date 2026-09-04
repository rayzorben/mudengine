/**
 * Is a password of yours sitting in a file this client wrote — or in a package
 * about to leave this machine?
 *
 *   npm run check:secrets
 *
 * The client writes three kinds of file that could contain one: session logs
 * (server output), captures (every outbound command, verbatim) and the options
 * file's own backups. Only the captures ever *could* — `reportable()` redacts
 * the answer to a password prompt before it reaches one — and "could not" is a
 * property of the current code, not of files written by older code.
 *
 * That is exactly what this is for. Three captures from before the redaction
 * existed were sitting in `out/` with a password in them, and nothing would ever
 * have said so.
 *
 * **Where it looks is resolved the way the client resolves it.** `logging.directory`
 * is empty by default, and empty means `<home>/logs` — where every capture
 * actually lands. For a while this treated the empty string as "no directory"
 * and walked `out/` and the options directory instead: it checked 91 files and
 * reported that nothing contained a password without having opened one of the
 * 92 captures in `logs/` that hold a password prompt. A count that is not zero
 * can still be the check not running, so the report now names every root it
 * walked and how many files each gave it.
 *
 * `dist/` is walked too, archive included: the packaged application is the one
 * file that leaves this machine, so it is read byte for byte. `pack:dir` and
 * `dist:*` run this before building — the tree that is about to be packed —
 * and again after, on what was packed.
 *
 * **It never prints a password**, or any part of one. It reports which files
 * contain one and stops; a tool that told you what it found would be the leak
 * it is looking for.
 *
 * Exits non-zero when it finds something, so it can gate a release.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { normalizeConfig } from '../src/shared/config.ts';
import { resolveProfile } from '../src/shared/profiles.ts';
import { homePaths } from './lib/home.mjs';
import { baseConfig } from './lib/local-realm.mjs';

const home = homePaths();
const configPath = home.options;
if (!fs.existsSync(configPath)) {
  console.log(`\nNo options file at ${configPath}; nothing to check against.\n`);
  process.exit(0);
}

const config = normalizeConfig(YAML.parse(fs.readFileSync(configPath, 'utf8')) ?? {});
/*
 * Resolved the way the client resolves them, with the realms on disk folded
 * in. A character names its realm by name, so resolving against the bare
 * options file finds no character — and this script did exactly that for a
 * day after realms became directories, reporting that no password was
 * configured against a home with two. A check that cannot find what it is
 * looking for must not read as a check that found nothing.
 */
const source = baseConfig(home);

/**
 * Where a configuration's logs go: the directory it names, or the client's
 * default beside everything else it keeps. The same answer `logDirectory` in
 * `src/main/index.ts` gives.
 */
const logsFor = (resolved) =>
  resolved.logging.directory.length > 0 ? path.resolve(resolved.logging.directory) : home.logs;

/**
 * Every password this client knows about: the global login, and whatever each
 * character resolves to — every account is inline on its own file now, so
 * there is no separate named-account list to walk.
 *
 * Short ones are skipped. A two-character password would match half the corpus
 * and bury the real answer in noise — and anybody using one has a different
 * problem.
 */
const secrets = new Set();
const consider = (value) => {
  if (typeof value === 'string' && value.length >= 4) secrets.add(value);
};
// The options file has held no account since 2026-08-29 (`dropAnonymousConnection`
// takes an old one out), but this runs without the app, against whatever is on
// disk — and a file the migration has not yet touched is exactly the kind of
// file this check exists for.
consider(config.connection.login.password);

/** Where the client writes. `out/` is where every probe and harness puts things. */
const roots = new Set([path.resolve('out'), path.resolve('dist'), home.root, logsFor(config)]);

// A character is a directory: `profiles/<id>/profile.yaml`, its loops beside it.
const profilesDir = home.profilesDir;
let characters = 0;
if (fs.existsSync(profilesDir)) {
  for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      const raw = YAML.parse(fs.readFileSync(home.profile(entry.name).file, 'utf8'));
      const result = resolveProfile(entry.name, raw, source);
      if (result.error !== undefined) continue;
      characters += 1;
      consider(result.profile.config.connection.login.password);
      // A character may log somewhere of its own; that directory is one more root.
      roots.add(logsFor(result.profile.config));
    } catch {
      // An unparseable character file has no password to leak.
    }
  }
}

console.log(
  `\n${characters} character(s) resolved, ${secrets.size} distinct password(s) to look for`
);

if (secrets.size === 0) {
  console.log('\nNo passwords configured, so there is nothing that could have leaked.\n');
  process.exit(0);
}

/**
 * Looked for as bytes, in two encodings: UTF-8 is what every file this client
 * writes uses, and UTF-16LE is how Chromium stores a renderer's `localStorage`
 * under the same home — the one place a settings draft could persist without
 * going through main. A byte search also reads an `.asar` archive as it is,
 * which is a plain concatenation of the files it holds.
 */
const needles = [...secrets].flatMap((secret) => [
  Buffer.from(secret, 'utf8'),
  Buffer.from(secret, 'utf16le')
]);

/**
 * `.bak` anywhere in the name, not only at the end: the client's rolling
 * backups are `default.yaml.bak`, and a hand-made copy is `default.yaml.bak-old`.
 */
const WORTH_READING = /\.(log|jsonl|txt|json|yaml|yml|asar|ldb)$|\.bak|\.mudcap\./i;

/**
 * A root inside another root is walked once, as part of the outer one. The
 * home holds `global/` and the default `logs/`, so without this every file
 * under both would be counted twice and read twice.
 */
const distinctRoots = [...roots]
  .filter((dir) => fs.existsSync(dir))
  .filter((dir, _, all) => !all.some((other) => other !== dir && dir.startsWith(other + path.sep)));

const found = [];
const unreadable = [];
const walked = new Map();
let checked = 0;

const walk = (dir, root) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Not into a realm cache or a node_modules: large, derived, and no
      // credential ever reaches either.
      if (entry.name === 'node_modules' || entry.name === 'realms') continue;
      walk(full, root);
      continue;
    }
    if (!WORTH_READING.test(entry.name)) continue;
    /*
     * Three things are *supposed* to hold a password, and flagging them would
     * make this a tool that cries wolf every time somebody saves a setting.
     *
     * The options file. The character files. And the client's own rolling
     * backup of the options file, which sits beside it under the same name —
     * that backup is what makes a settings save reversible, it is covered by
     * the same gitignore rule and the same directory permissions, and the one
     * way it could have escaped was the packaging filter, which is where that
     * was fixed.
     *
     * A copy *anywhere else* is not sanctioned, whatever it is called.
     */
    if (path.resolve(full) === path.resolve(configPath)) continue;
    // A character's own file, and the rolling backup the client keeps beside it.
    if (
      path.resolve(path.dirname(path.dirname(full))) === path.resolve(profilesDir) &&
      entry.name.startsWith('profile.yaml')
    ) {
      continue;
    }
    const besideConfig =
      path.resolve(path.dirname(full)) === path.resolve(path.dirname(configPath)) &&
      entry.name.startsWith(path.basename(configPath));
    if (besideConfig) continue;

    checked += 1;
    walked.set(root, (walked.get(root) ?? 0) + 1);
    let bytes;
    try {
      bytes = fs.readFileSync(full);
    } catch {
      // Said, not skipped: a file this could not open is a file it did not check.
      unreadable.push(path.relative(process.cwd(), full));
      continue;
    }
    if (needles.some((needle) => bytes.includes(needle))) {
      found.push(path.relative(process.cwd(), full));
    }
  }
};

for (const root of distinctRoots) {
  walked.set(root, 0);
  walk(root, root);
}

console.log(`\nchecked ${checked} files this client could have written, under:\n`);
for (const [root, count] of walked) console.log(`    ${count.toString().padStart(5)}  ${root}`);
if (unreadable.length > 0) {
  console.log(`\n  ${unreadable.length} file(s) could not be read, so were not checked:\n`);
  for (const file of unreadable) console.log(`    ${file}`);
}

if (found.length === 0) {
  console.log('\n  Nothing contains a configured password.\n');
  process.exit(unreadable.length === 0 ? 0 : 1);
}

console.log(`\n  ${found.length} file(s) contain one:\n`);
for (const file of found) console.log(`    ${file}`);
console.log(
  '\n  These are worth deleting. A capture written before `reportable()` redacted\n' +
    '  the answer to a password prompt has that answer in it, and a stray copy of\n' +
    '  the options file is a verbatim copy. A package under `dist/` that holds one\n' +
    '  must not ship.\n' +
    '\n  The options file itself, the character files, and the rolling backup the\n' +
    '  client keeps beside the options file are not listed: those are supposed to\n' +
    '  hold one.\n'
);
process.exit(1);
