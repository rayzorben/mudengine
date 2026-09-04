/**
 * Builds installable redistributables from this checkout.
 *
 *   npm run dist                 everything this machine can actually produce
 *   npm run dist -- linux win    only those
 *   npm run dist -- --list       say what this machine can produce, build nothing
 *
 * The three `dist:*` scripts each package one platform and each spell out the
 * same four steps; this is the one command for "give me something I can hand
 * somebody", and it exists mainly for the thing those three cannot do — **say
 * what it is not building, and why**.
 *
 * That matters because the failure is silent in both directions. `electron-builder
 * --win` on a Linux box without wine fails several minutes into a build with an
 * error about a missing binary; `--mac` on Linux produces an app directory that
 * cannot be signed, cannot be opened and looks like a package. Refusing up
 * front, by name, is the whole value:
 *
 *   linux   only on Linux. AppImage and .deb are built with Linux tooling.
 *   win     natively on Windows; on Linux or macOS it needs `wine` on PATH for
 *           the NSIS installer.
 *   mac     only on macOS. The .dmg is made with `hdiutil`, which is Apple's.
 *
 * For the platforms this machine refuses, the answer is CI:
 * `.github/workflows/release.yml` builds all three on their own runners, and
 * pushing a `v*` tag publishes them. `workflow_dispatch` runs the same thing
 * without making a release, which is how to get a Windows or macOS build to
 * test with from here.
 *
 * **`check:secrets` runs before and after**, exactly as `dist:*` does — the
 * tree that is about to be packed, and then the package itself, which is the
 * one file that leaves this machine. It reports what it found without printing
 * it and exits non-zero, so a leak stops the build. Its own warning applies and
 * is repeated below: with no options file it has nothing to check against and
 * says so, and "nothing found" from a check that did not run is the reassuring
 * answer this repository does not accept.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Every platform this script knows how to ask electron-builder for. */
const PLATFORMS = ['linux', 'win', 'mac'];

/**
 * Whether this machine can build for a platform, and the sentence to print
 * when it cannot.
 *
 * Answered from the host rather than attempted and recovered from: a refusal
 * that arrives four minutes into a build has already cost the four minutes.
 */
function capability(platform) {
  const host = process.platform;
  switch (platform) {
    case 'linux':
      return host === 'linux'
        ? { can: true }
        : { can: false, why: 'AppImage and .deb are built with Linux tooling; this is not Linux.' };
    case 'mac':
      return host === 'darwin'
        ? { can: true }
        : { can: false, why: 'A .dmg is made with hdiutil, which only exists on macOS.' };
    case 'win':
      if (host === 'win32') return { can: true };
      if (!has('wine')) {
        return {
          can: false,
          why: 'The NSIS installer is built by running the Windows toolchain under wine, and wine is not on PATH.'
        };
      }
      /*
       * On PATH is not the same as ready, and the difference costs four
       * minutes. Measured 2026-09-02: with no `~/.wine`, this build packaged
       * the whole application and then died at `rcedit` — the step that stamps
       * the version metadata into the .exe — because wine was still creating
       * its prefix while rcedit ran against it. The same command succeeded on
       * the next attempt with nothing changed but the prefix existing.
       *
       * Which is exactly the failure this function is for: a refusal that
       * arrives after the build has already run is not a refusal. So the
       * prefix is a precondition, and the fix is one command.
       */
      return winePrefixExists()
        ? { can: true }
        : {
            can: false,
            why: 'wine is on PATH but has never been initialised. Run `wineboot -i` once, then try again.'
          };
    default:
      return { can: false, why: 'Not a platform this script knows.' };
  }
}

/**
 * Has wine set its prefix up?
 *
 * `WINEPREFIX` when it is set, `~/.wine` otherwise — the same two places wine
 * itself looks. Existence is the whole test: wine creates the directory as its
 * first act, and what broke was a build racing that creation.
 */
function winePrefixExists() {
  const prefix = process.env.WINEPREFIX ?? path.join(os.homedir(), '.wine');
  return fs.existsSync(prefix);
}

/** Is this command on PATH? */
function has(command) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
    stdio: 'ignore'
  });
  return probe.status === 0;
}

/**
 * Runs a command, inheriting the terminal, and stops the whole run if it fails.
 *
 * Nothing is swallowed and nothing is summarised: electron-builder's own output
 * is what says which target it is on and which one broke.
 */
function run(command, args) {
  console.log(`\n$ ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`\n${command} ${args.join(' ')} exited ${result.status ?? 'on a signal'}.\n`);
    process.exit(result.status ?? 1);
  }
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const builder = path.join('node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const asked = args.filter((arg) => !arg.startsWith('-'));

const unknown = asked.filter((name) => !PLATFORMS.includes(name));
if (unknown.length > 0) {
  console.error(`\nUnknown platform: ${unknown.join(', ')}. Choose from ${PLATFORMS.join(', ')}.\n`);
  process.exit(1);
}

/*
 * With nothing named, build everything this machine can do — and say nothing
 * about the rest beyond one line each. Named explicitly, a platform this
 * machine cannot build is an *error*: somebody asked for a Windows installer
 * and must not be told it worked.
 */
const wanted = asked.length > 0 ? asked : PLATFORMS;
const explicit = asked.length > 0;

console.log(`\nmudengine ${version()} — packaging on ${os.type()} ${process.arch}\n`);

const buildable = [];
for (const platform of wanted) {
  const { can, why } = capability(platform);
  if (can) {
    buildable.push(platform);
    console.log(`  ${platform.padEnd(6)} yes`);
  } else {
    console.log(`  ${platform.padEnd(6)} no   ${why}`);
    if (explicit) {
      console.error(
        `\n${platform} was asked for by name and cannot be built here. ` +
          'Push a `v*` tag, or run the release workflow by hand — CI builds all three.\n'
      );
      process.exit(1);
    }
  }
}

if (buildable.length < PLATFORMS.length) {
  console.log(
    '\nWhat this machine will not build, CI will: .github/workflows/release.yml\n' +
      'builds linux, win and mac on their own runners. Run it from the Actions tab\n' +
      '(workflow_dispatch) to get artifacts without making a release.'
  );
}

if (listOnly) {
  console.log('');
  process.exit(0);
}

if (buildable.length === 0) {
  console.error('\nNothing to build here.\n');
  process.exit(1);
}

/*
 * The tree first, then the build, then what was built. The middle step is the
 * expensive one, so a password in the checkout stops the run before it rather
 * than after — and the second pass is the one that matters, because the
 * archive is what leaves the machine.
 */
run(npm, ['run', 'check:secrets']);
run(npm, ['run', 'build']);
run(builder, buildable.map((platform) => `--${platform}`));
run(npm, ['run', 'check:secrets']);

report();

/** This package's version, which is what every artifact is named after. */
function version() {
  return JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
}

/**
 * What was produced, with sizes.
 *
 * electron-builder prints each file as it writes it, interleaved with
 * everything else it says; this is the list somebody actually uploads, in one
 * place, after the secret check has passed on it.
 */
function report() {
  const dist = path.resolve('dist');
  if (!fs.existsSync(dist)) return;

  const installers = fs
    .readdirSync(dist, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(AppImage|deb|rpm|exe|dmg|zip|tar\.gz)$/i.test(entry.name))
    .map((entry) => {
      const file = path.join(dist, entry.name);
      return { name: entry.name, size: fs.statSync(file).size };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (installers.length === 0) {
    console.log('\nNothing installable in dist/ — read electron-builder’s output above.\n');
    return;
  }

  const width = Math.max(...installers.map((file) => file.name.length));
  console.log(`\n${installers.length} file(s) in dist/:\n`);
  for (const file of installers) {
    console.log(`  ${file.name.padEnd(width)}  ${(file.size / 1024 / 1024).toFixed(1)} MB`);
  }
  console.log(
    '\nUnsigned. Windows will show a SmartScreen warning; macOS needs Ctrl-click →\n' +
      'Open, or `xattr -dr com.apple.quarantine <the app>`. Say so when you share them.\n'
  );
}
