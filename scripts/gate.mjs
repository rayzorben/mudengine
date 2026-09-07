/**
 * The gate, chosen by path (`mudengine-verify` § The gate is chosen by path).
 *
 *   npm run verify                  per todo: typecheck, the unit tests whose
 *                                   module graph reaches a changed file, and
 *                                   the corpus when the parser changed
 *   npm run gate [-- --since <ref>] once after the last todo: what the whole
 *                                   diff calls for, cheapest first
 *   npm run gate:all                everything, for a release
 *
 * Changed is the working tree against HEAD (index and untracked included) or
 * against --since. Every step says whether it runs and which file decided it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
 * `captures/`, `mdb/`). The same closure decides the realm tests and the
 * corpus replay. Nothing here is a guessed directory mapping.
 */
const ALIASES = [
  ['@shared/', 'src/shared/'],
  ['@main/', 'src/main/'],
  ['@renderer/', 'src/renderer/src/']
];
const SPECIFIER =
  /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;
const DISK = /['"]((?:resources|locales|captures|mdb)(?:\/[^'"]*)?)['"]/g;
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

/** The changed files a closure (plus some paths outside it) explains. */
function hits(entries, prefixes = []) {
  const { modules, reads } = reach(entries);
  return [...changed].filter(
    (c) =>
      modules.has(c) || [...reads].some((r) => under(c, r)) || prefixes.some((p) => under(c, p))
  );
}
const byPath = (prefixes) =>
  [...changed].filter((c) => !isTest(c) && prefixes.some((p) => under(c, p)));

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
  'scripts/smoke.mjs'
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
  'scripts/lib/browser.mjs',
  'electron.vite.config.ts',
  'package.json',
  'package-lock.json'
];
const CORPUS_ENTRIES = [
  'src/main/parse/Classifier.ts',
  'src/main/parse/patterns.ts',
  'src/main/world/WorldGraph.ts'
];
const CORPUS_PATHS = ['captures/', 'resources/world/', 'scripts/analyse-corpus.mjs'];
const REALM_PATHS = ['mdb/', 'scripts/build-world.mjs'];

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

const typesChanged = [...changed].filter(
  (c) => /\.(ts|tsx)$/.test(c) || c.startsWith('tsconfig') || c === 'electron.vite.config.ts'
);
const claimed = new Set(typesChanged);
const unitSelected = [];
for (const t of UNIT_TESTS) {
  const h = hits([t]);
  if (h.length === 0) continue;
  unitSelected.push(t);
  for (const c of h) claimed.add(c);
}
const realmHits = hits(REALM_TESTS, REALM_PATHS);
const corpusHits = hits(CORPUS_ENTRIES, CORPUS_PATHS);
const smokeHits = byPath(SMOKE_PATHS);
const webHits = byPath(WEB_SMOKE_PATHS);
for (const c of [...realmHits, ...corpusHits, ...smokeHits, ...webHits]) claimed.add(c);
const unclaimed = [...changed].filter((c) => !claimed.has(c));

const NODE = process.execPath;
const REGISTER = ['--import', './scripts/lib/register.mjs'];
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const plan = [];
const step = (name, cmd, because) =>
  plan.push({ name, cmd, because, run: ALL || because.length > 0 });
const always = ['always'];
const named = (list) =>
  list.length === 0 ? [] : [list[0] + (list.length > 1 ? ` (+${list.length - 1})` : '')];

if (NARROW) {
  step('typecheck', [npm, 'run', 'typecheck'], named(typesChanged));
  step('unit tests', [npx, 'vitest', 'run', ...unitSelected], named(unitSelected));
  step('corpus', [NODE, ...REGISTER, 'scripts/analyse-corpus.mjs'], named(corpusHits));
} else {
  step('typecheck', [npm, 'run', 'typecheck'], always);
  step('format', [npx, 'prettier', '--check', 'src/**/*.{ts,tsx,css}'], always);
  step('unit tests', [npx, 'vitest', 'run'], always);
  step(
    'realm tests',
    [npx, 'vitest', 'run', '--config', 'vitest.realm.config.ts'],
    named(realmHits)
  );
  step('build', [npx, 'electron-vite', 'build'], always);
  step('corpus', [NODE, ...REGISTER, 'scripts/analyse-corpus.mjs'], named(corpusHits));
  step('smoke', [NODE, 'scripts/smoke.mjs'], named(smokeHits));
  step('web smoke', [NODE, ...REGISTER, 'scripts/web-smoke.mjs'], named(webHits));
}

// ------------------------------------------------------------ say it, do it

const mode = NARROW ? 'verify' : 'gate';
if (changed.size === 0 && !ALL) {
  console.error(
    `${mode}: nothing changed against ${SINCE}. Pass --since <ref> for a committed range, or --all.`
  );
  process.exit(1);
}
console.log(
  `${mode} ${ALL ? 'of everything' : `against ${SINCE}`}: ${changed.size} file${changed.size === 1 ? '' : 's'} changed\n`
);
for (const s of plan) {
  console.log(
    `  ${s.run ? 'run ' : 'skip'}  ${s.name.padEnd(12)} ${s.run ? (ALL ? 'everything' : s.because[0]) : 'nothing reaches it'}`
  );
}
if (NARROW && unitSelected.length > 0) {
  console.log(
    `\n  ${unitSelected.length} of ${UNIT_TESTS.length} unit test files reach a changed file:`
  );
  for (const t of unitSelected.slice(0, 12)) console.log(`    ${t}`);
  if (unitSelected.length > 12) console.log(`    … ${unitSelected.length - 12} more`);
}
if (unclaimed.length > 0 && !ALL) {
  console.log(
    `\n  no check claims: ${unclaimed.slice(0, 8).join(', ')}${unclaimed.length > 8 ? ` (+${unclaimed.length - 8})` : ''}`
  );
}
console.log('');
if (DRY) process.exit(0);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const took = [];
const started = Date.now();
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
for (const s of plan) {
  if (!s.run) continue;
  console.log(`── ${s.name}\n`);
  const t0 = Date.now();
  const r = spawnSync(s.cmd[0], s.cmd.slice(1), { stdio: 'inherit', env });
  const ms = Date.now() - t0;
  took.push(`${s.name} ${seconds(ms)}`);
  if (r.status !== 0) {
    console.log(
      `\n${mode}: ${s.name} failed (exit ${r.status ?? r.signal}) after ${seconds(Date.now() - started)}`
    );
    console.log(`  ${took.join(' · ')}`);
    process.exit(r.status ?? 1);
  }
}
console.log(`\n${mode}: clean in ${seconds(Date.now() - started)}`);
if (took.length > 0) console.log(`  ${took.join(' · ')}`);
