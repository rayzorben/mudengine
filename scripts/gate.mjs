/**
 * The gate (`mudengine-verify` § The gate is chosen by path).
 *
 *   npm run verify     per todo: what the diff reaches, in test files
 *   npm run gate       once after the last todo, whole suites and the smokes
 *   npm run gate:all   everything, ignoring the ledger
 *
 * A step runs when the hash of the files it reads differs from the hash it
 * last passed at (`.gate/state.json`), so nothing is checked twice over the
 * same bytes; `--since <ref>` moves the report, never what runs. Output
 * goes to `.gate/logs/`; `--verbose` streams it, `--only=<step>` runs one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(ROOT);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};
const NARROW = flag('--narrow');
const ALL = flag('--all');
const DRY = flag('--dry-run');
const VERBOSE = flag('--verbose');
const ONLY_GIVEN = args.some((a) => a === '--only' || a.startsWith('--only='));
const ONLY = (value('--only') ?? args.find((a) => a.startsWith('--only='))?.slice(7) ?? '')
  .split(',')
  .filter(Boolean);
const SINCE = value('--since') ?? 'HEAD';

// ------------------------------------------------------------ what changed

const git = (...argv) => {
  const r = spawnSync('git', argv, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout.split('\n').filter(Boolean);
};
const changed = new Set([
  ...git('diff', '--name-only', SINCE),
  ...git('ls-files', '--others', '--exclude-standard')
]);
const isTest = (file) => file.includes('/__tests__/');

// ------------------------------------------------------- the module graph

/*
 * A test runs when a changed file is in its import closure, or is a file on
 * disk that something in that closure names (`resources/`, `locales/`,
 * `captures/`, `mdb/`, `src/` — the guards read source as text rather than
 * importing it, so `src/main/client.ts` in a string is a claim on that file
 * and `src` is a claim on the tree). The same closure decides the realm tests and the
 * corpus replay. Nothing here is a guessed directory mapping.
 */
const ALIASES = [
  ['@shared/', 'src/shared/'],
  ['@main/', 'src/main/'],
  ['@renderer/', 'src/renderer/src/']
];
const SPECIFIER =
  /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;
const DISK = /['"]((?:resources|locales|captures|mdb|src)(?:\/[^'"]*)?)['"]/g;
const toPosix = (p) => p.split(path.sep).join('/');
const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();

function resolveSpecifier(spec, from) {
  let base;
  if (spec.startsWith('.')) base = path.join(path.dirname(from), spec);
  else {
    const alias = ALIASES.find(([prefix]) => spec.startsWith(prefix));
    if (!alias) return null;
    base = alias[1] + spec.slice(alias[0].length);
  }
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx')
  ]) {
    if (isFile(candidate)) return toPosix(path.normalize(candidate));
  }
  return null;
}

const edges = new Map();
function edgesOf(file) {
  const known = edges.get(file);
  if (known) return known;
  const text = fs.readFileSync(file, 'utf8');
  const imports = [];
  for (const m of text.matchAll(SPECIFIER)) {
    const target = resolveSpecifier(m[1] ?? m[2] ?? m[3], file);
    if (target) imports.push(target);
  }
  const reads = [...text.matchAll(DISK)].map((m) => m[1]);
  const e = { imports, reads };
  edges.set(file, e);
  return e;
}

/**
 * Every module an entry reaches, itself included, and every disk path the
 * entries and their test helpers name. A disk path named deeper in the
 * closure is not a claim: `i18n.ts` naming `locales/` would wake the realm
 * tests for a copy change.
 */
function reach(entries) {
  const modules = new Set();
  const reads = new Set();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop();
    if (modules.has(file)) continue;
    modules.add(file);
    const e = edgesOf(file);
    // A bare 'mdb' in a source module is a word; in a test it is a fixture root.
    if (isTest(file)) for (const r of e.reads) reads.add(r);
    else if (entries.includes(file)) for (const r of e.reads) if (r.includes('/')) reads.add(r);
    stack.push(...e.imports);
  }
  return { modules, reads };
}

const under = (file, prefix) =>
  file === prefix ||
  (file.startsWith(prefix) && (prefix.endsWith('/') || file[prefix.length] === '/'));

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(toPosix(p));
  }
  return out;
};
const SRC = walk('src');
const UNIT_TESTS = SRC.filter(
  (f) => f.endsWith('.test.ts') && !f.endsWith('.realm.test.ts')
).sort();
const REALM_TESTS = SRC.filter((f) => f.endsWith('.realm.test.ts')).sort();

// ---------------------------------------------------------- what runs when

/*
 * The two smokes drive the whole app, so their closure is everything; these
 * are the paths whose change the real UI alone can catch (wiring, focus, a
 * measured box), which is `CLAUDE.md`'s smoke-by-path rule plus the renderer
 * itself. World, automation, the parser and pure shared modules are unit
 * tested and never wake a smoke.
 */
const SMOKE_PATHS = [
  'src/renderer/',
  'src/preload/',
  'src/main/index.ts',
  'src/main/windows/',
  'src/main/session/',
  'src/main/config/',
  'src/main/net/',
  'src/main/app/',
  'src/main/host/Host.ts',
  'src/main/host/ElectronHost.ts',
  'src/shared/ipc.ts',
  'src/shared/types.ts',
  'src/shared/config.ts',
  'src/shared/internal.ts',
  'src/shared/themes.ts',
  'src/shared/notifications.ts',
  'src/shared/map.ts',
  'src/shared/drafts.ts',
  'src/shared/i18n.ts',
  'src/shared/profiles.ts',
  'src/shared/files.ts',
  'locales/',
  'resources/config/',
  'resources/servers/',
  'electron.vite.config.ts',
  'package.json',
  'package-lock.json',
  'scripts/smoke.mjs',
  'scripts/smoke-baseline.json'
];
const WEB_SMOKE_PATHS = [
  'src/main/host/',
  'src/main/client.ts',
  'src/main/index.ts',
  'src/preload/',
  'src/shared/ipc.ts',
  'src/shared/internal.ts',
  'src/renderer/src/lib/webBridge.ts',
  'src/renderer/src/lib/pickers.ts',
  'scripts/web.mjs',
  'scripts/web-smoke.mjs',
  'scripts/web-smoke-baseline.json',
  'scripts/lib/browser.mjs',
  'electron.vite.config.ts',
  'package.json',
  'package-lock.json'
];
const CORPUS_ENTRIES = [
  'src/main/parse/Classifier.ts',
  'src/main/parse/patterns.ts',
  'src/main/world/WorldGraph.ts',
  // The fourth of `analyse-corpus.mjs`'s dynamic imports, and the one the
  // other three do not reach: the shipped sentence tables it classifies with.
  'src/main/world/ShippedSentences.ts'
];
const CORPUS_PATHS = ['captures/', 'resources/world/', 'scripts/analyse-corpus.mjs'];
/*
 * `buildRealm.ts` and the built worlds belong here as much as the archives do:
 * `RealmLibrary.realm.test.ts` is the assertion that the shipped files are at
 * `REALM_FORMAT` and were built from the archives in `mdb/`, and a format bump
 * touches the converter and the output without touching either path that used
 * to wake it. `buildRealm.ts` is claimed by typecheck, so it was not even
 * printed as unclaimed; `resources/world/` woke the corpus and not this.
 */
const REALM_PATHS = [
  'mdb/',
  'scripts/build-world.mjs',
  'src/main/world/buildRealm.ts',
  'resources/world/'
];

for (const p of [
  ...SMOKE_PATHS,
  ...WEB_SMOKE_PATHS,
  ...CORPUS_ENTRIES,
  ...CORPUS_PATHS,
  ...REALM_PATHS
]) {
  if (!fs.existsSync(p) && p !== 'captures/' && p !== 'mdb/')
    console.error(`gate: ${p} is named here and does not exist`);
}

// ------------------------------------------------------------- the ledger

/*
 * Which checks are already green, and at what inputs.
 *
 * A check's input set is the closure above plus the disk paths it reads; its
 * fingerprint is a hash of every one of those files' contents and of the
 * command itself. It runs when that differs from the fingerprint recorded the
 * last time it passed, and is skipped when it does not — so three changes in
 * a row under `src/main/world/` never wake a smoke and the fourth, under
 * `src/renderer/`, does. Contents and not mtimes: a branch switch rewrites
 * every mtime without changing a byte, and 11 MB of inputs hash in ~50ms.
 * `--all` ignores the ledger; a failing check records nothing.
 */
const STATE = '.gate/state.json';
const LOGS = '.gate/logs';
let ledger = { version: 1, checks: {}, digests: {} };
try {
  const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  if (saved?.version === 1 && saved.checks) ledger = { digests: {}, ...saved };
} catch (e) {
  // Absent is the ordinary first run. Present and unreadable is a truncated
  // write or an older shape, and a silent 35s `verify` looks exactly like a
  // real one, so it is said out loud.
  if (fs.existsSync(STATE))
    console.error(`gate: ${STATE} unreadable (${e.message}); everything runs`);
}
/*
 * What each file hashed to when a step last passed over it: the label saying
 * *which* input woke a step, which `git diff` cannot answer because a file
 * changed and checked an hour ago is still in it. A label, never a decision.
 * `format` keeps its own copy — narrowing a command to a subset has to know
 * that step passed over them, not that some step did.
 */
const seen = { ...ledger.digests };
function remember(entries, inputs) {
  Object.assign(ledger.checks, entries);
  for (const file of new Set(inputs)) ledger.digests[file] = digestOf(file);
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  // Written whole and renamed over: a run killed mid-write leaves the last
  // good ledger rather than the half that would discard every green in it.
  fs.writeFileSync(`${STATE}.tmp`, JSON.stringify(ledger, null, 1));
  fs.renameSync(`${STATE}.tmp`, STATE);
}

const digests = new Map();
function digestOf(file) {
  let d = digests.get(file);
  if (d === undefined) {
    try {
      d = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
    } catch {
      // A named input that is not there is a state of its own, and a stable
      // one: `captures/` absent hashes the same on every run.
      d = 'absent';
    }
    digests.set(file, d);
  }
  return d;
}
function fingerprint(files, salt) {
  const h = crypto.createHash('sha256').update(`${salt}\n`);
  for (const f of [...new Set(files)].sort()) h.update(`${f} ${digestOf(f)}\n`);
  return h.digest('hex').slice(0, 16);
}

/** Directories in an input list stand for the files under them. */
function expand(paths) {
  const out = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(toPosix(p));
  }
  return out;
}

const CONFIGS = [
  'package.json',
  'package-lock.json',
  'electron.vite.config.ts',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json',
  'vitest.config.ts',
  'vitest.realm.config.ts',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yaml',
  'prettier.config.js'
].filter(isFile);
const TS_FILES = SRC.filter((f) => /\.tsx?$/.test(f));
const FORMATTABLE = SRC.filter((f) => /\.(ts|tsx|css)$/.test(f));
/** A closure's modules, the files it reads off disk, and what every run reads. */
const inputsOf = (entries, prefixes = []) => {
  const { modules, reads } = reach(entries);
  return [...modules, ...expand([...reads, ...prefixes]), ...CONFIGS];
};

// ---------------------------------------------------------- what runs when

const NODE = process.execPath;
const REGISTER = ['--import', './scripts/lib/register.mjs'];
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const now = () => new Date().toISOString();
const named = (list) =>
  list.length === 0 ? [] : [list[0] + (list.length > 1 ? ` (+${list.length - 1})` : '')];

const claimed = new Set();
/** A step the ledger decides: its fingerprint against the one it passed at. */
function gated(name, key, cmd, inputs) {
  const set = new Set(inputs);
  for (const c of changed) if (set.has(c)) claimed.add(c);
  const hash = fingerprint(inputs, cmd.join(' '));
  const was = ledger.checks[key];
  const green = !ALL && was?.hash === hash;
  const stale = [...set].filter((f) => seen[f] !== digestOf(f)).sort();
  const woke = named(stale)[0] ?? named([...changed].filter((c) => set.has(c)))[0];
  return {
    name,
    cmd,
    inputs,
    run: !green,
    because: ALL ? 'everything' : (woke ?? (was ? 'inputs changed' : 'never run')),
    since: was?.at,
    record: () => ({ [key]: { hash, at: now() } })
  };
}

/*
 * Every unit test file is its own ledger entry, so the inner loop shrinks as
 * it goes: the change that woke two test files stops waking them the moment
 * they pass, where `git diff HEAD` would keep waking them for the rest of the
 * session. `gate` still runs the whole suite as one check — the per-file
 * entries it writes on the way through are what make the next `verify` free.
 */
const testKey = (t) => `unit:${t}`;
const testHash = new Map();
for (const t of UNIT_TESTS) testHash.set(t, fingerprint(inputsOf([t]), 'vitest run'));
const testEntries = (files) =>
  Object.fromEntries(files.map((t) => [testKey(t), { hash: testHash.get(t), at: now() }]));
const staleTests = UNIT_TESTS.filter(
  (t) => ALL || ledger.checks[testKey(t)]?.hash !== testHash.get(t)
);

const typecheck = () =>
  gated('typecheck', 'typecheck', [npm, 'run', 'typecheck'], [...TS_FILES, ...CONFIGS]);
const corpus = () =>
  gated(
    'corpus',
    'corpus',
    [NODE, ...REGISTER, 'scripts/analyse-corpus.mjs'],
    inputsOf(CORPUS_ENTRIES, [...CORPUS_PATHS, 'scripts/lib'])
  );

const plan = [];
if (NARROW) {
  plan.push(typecheck());
  plan.push({
    name: 'unit tests',
    cmd: [npx, 'vitest', 'run', ...staleTests],
    run: staleTests.length > 0,
    because: ALL ? 'everything' : (named(staleTests)[0] ?? 'never run'),
    skipped: `all ${UNIT_TESTS.length} green`,
    inputs: staleTests.flatMap((t) => inputsOf([t])),
    record: () => testEntries(staleTests)
  });
  plan.push(corpus());
} else {
  plan.push(typecheck());
  /*
   * Narrowing is sound only for the files this step's own map covers: the
   * fingerprint also holds `.prettierrc` and the lockfile, so a config bump
   * or a deletion moves it while no source file moved. `prettier --check`
   * with no file argument exits 0 having read nothing, which would stamp the
   * tree green against a config nothing was checked under — so an empty
   * narrowing is the whole tree, not an empty command.
   */
  const staleFormat = FORMATTABLE.filter((f) => ledger.checks.format?.files?.[f] !== digestOf(f));
  const formatting =
    ALL || !ledger.checks.format || staleFormat.length === 0
      ? ['src/**/*.{ts,tsx,css}']
      : staleFormat;
  const format = gated(
    'format',
    'format',
    [npx, 'prettier', '--check'],
    [...FORMATTABLE, ...CONFIGS]
  );
  format.cmd = [npx, 'prettier', '--check', ...formatting];
  const formatRecord = format.record;
  format.record = () => ({
    format: {
      ...formatRecord().format,
      files: Object.fromEntries(FORMATTABLE.map((f) => [f, digestOf(f)]))
    }
  });
  plan.push(format);

  const unit = gated('unit tests', 'unit', [npx, 'vitest', 'run'], inputsOf(UNIT_TESTS));
  const unitRecord = unit.record;
  unit.record = () => ({ ...unitRecord(), ...testEntries(UNIT_TESTS) });
  plan.push(unit);

  plan.push(
    gated(
      'realm tests',
      'realm',
      [npx, 'vitest', 'run', '--config', 'vitest.realm.config.ts'],
      inputsOf(REALM_TESTS, REALM_PATHS)
    )
  );
  plan.push(
    // A test file is typechecked and formatted but never bundled: the build's
    // entries reach the app, not `__tests__`.
    gated(
      'build',
      'build',
      [npx, 'electron-vite', 'build'],
      [
        ...SRC.filter((c) => !isTest(c)),
        ...expand(['locales', 'resources/config', 'resources/servers']),
        ...CONFIGS
      ]
    )
  );
  plan.push(corpus());
  plan.push(
    gated(
      'smoke',
      'smoke',
      [NODE, 'scripts/smoke.mjs'],
      [...expand([...SMOKE_PATHS, 'scripts/lib']).filter((c) => !isTest(c)), ...CONFIGS]
    )
  );
  plan.push(
    gated(
      'web smoke',
      'web-smoke',
      [NODE, ...REGISTER, 'scripts/web-smoke.mjs'],
      [...expand([...WEB_SMOKE_PATHS, 'scripts/lib']).filter((c) => !isTest(c)), ...CONFIGS]
    )
  );
}
/*
 * What a check would read is a claim on a changed file whether or not this
 * mode runs that check: `verify` does not run the smokes, and a changed
 * `locales/` file is still covered by the gate that will.
 */
const COVERED = [...SMOKE_PATHS, ...WEB_SMOKE_PATHS, ...REALM_PATHS, ...CORPUS_PATHS];
for (const c of changed)
  if (isTest(c) || /\.(ts|tsx)$/.test(c) || COVERED.some((p) => under(c, p))) claimed.add(c);
if (ONLY_GIVEN) {
  const names = plan.map((s) => s.name);
  const unknown = ONLY.filter((o) => !names.some((n) => n.startsWith(o)));
  if (ONLY.length === 0 || unknown.length > 0) {
    console.error(
      `gate: --only ${ONLY.length === 0 ? 'needs a step name' : `names no step: ${unknown.join(', ')}`}. This run has: ${names.join(', ')}`
    );
    process.exit(2);
  }
  for (const s of plan)
    if (!ONLY.some((o) => s.name.startsWith(o))) {
      s.run = false;
      s.skipped = 'not named by --only';
    }
}
const unclaimed = [...changed].filter((c) => !claimed.has(c));

// ------------------------------------------------------------ say it, do it

const mode = NARROW ? 'verify' : 'gate';
const clock = (at) => (at ? new Date(at).toTimeString().slice(0, 5) : 'never');
console.log(
  `${mode} ${ALL ? 'of everything' : `against ${SINCE}`}: ${changed.size} file${changed.size === 1 ? '' : 's'} changed\n`
);
for (const s of plan) {
  console.log(
    `  ${s.run ? 'run ' : 'skip'}  ${s.name.padEnd(12)} ${
      s.run ? s.because : (s.skipped ?? `green since ${clock(s.since)}`)
    }`
  );
}
if (NARROW && staleTests.length > 0) {
  console.log(
    `\n  ${staleTests.length} of ${UNIT_TESTS.length} unit test files changed since they last passed:`
  );
  for (const t of staleTests.slice(0, 12)) console.log(`    ${t}`);
  if (staleTests.length > 12) console.log(`    … ${staleTests.length - 12} more`);
}
if (unclaimed.length > 0 && !ALL) {
  console.log(
    `\n  no check claims: ${unclaimed.slice(0, 8).join(', ')}${unclaimed.length > 8 ? ` (+${unclaimed.length - 8})` : ''}`
  );
}
console.log('');
if (DRY) process.exit(0);
if (!plan.some((s) => s.run)) {
  console.log(
    ONLY_GIVEN
      ? `${mode}: nothing to run — ${ONLY.join(', ')} is green at these inputs.`
      : `${mode}: nothing to run — every check is green at these inputs. gate:all ignores the ledger.`
  );
  process.exit(0);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(LOGS, { recursive: true });
const took = [];
const started = Date.now();
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
for (const s of plan) {
  if (!s.run) continue;
  const log = path.join(LOGS, `${s.name.replace(/\s+/g, '-')}.log`);
  process.stdout.write(`── ${s.name}${VERBOSE ? '\n\n' : ' '}`);
  const t0 = Date.now();
  let r;
  if (VERBOSE) r = spawnSync(s.cmd[0], s.cmd.slice(1), { stdio: 'inherit', env });
  else {
    // A green run is one line; a failing one is its own tail and a path. The
    // output of a passing smoke is the largest thing this script can print.
    const fd = fs.openSync(log, 'w');
    try {
      r = spawnSync(s.cmd[0], s.cmd.slice(1), { stdio: ['ignore', fd, fd], env });
    } finally {
      fs.closeSync(fd);
    }
  }
  const ms = Date.now() - t0;
  took.push(`${s.name} ${seconds(ms)}`);
  if (r.status === 0) {
    remember(s.record(), s.inputs ?? []);
    console.log(VERBOSE ? `\n── ${s.name} ${seconds(ms)}\n` : seconds(ms));
    continue;
  }
  console.log(VERBOSE ? '' : 'failed');
  if (!VERBOSE) {
    const tail = fs.readFileSync(log, 'utf8').split('\n').slice(-40).join('\n');
    console.log(`\n${tail}\n  … ${log}\n`);
  }
  console.log(
    `${mode}: ${s.name} failed (exit ${r.status ?? r.signal}) after ${seconds(Date.now() - started)}`
  );
  console.log(`  ${took.join(' · ')}`);
  process.exit(r.status ?? 1);
}
console.log(`\n${mode}: clean in ${seconds(Date.now() - started)}`);
if (took.length > 0) console.log(`  ${took.join(' · ')}`);
