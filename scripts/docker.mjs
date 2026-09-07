/**
 * Builds, runs and pushes the container image.
 *
 *   npm run docker:build          build rayzorben/mudengine:<package version>
 *   npm run docker:run            run what was just built, on port 8080
 *   npm run docker:push           push the version tag and `latest`
 *   npm run docker:build -- --list   say what would happen, do nothing
 *
 * The one thing this exists for is that **the tag is read out of
 * `package.json` and never typed**. `release.yml` already refuses a tag that
 * disagrees with the version for the desktop artefacts, for a stated reason —
 * the tag names the release and `package.json` names every file inside it — and
 * an image is one more artefact of that release. Typing `:0.5.0` by hand is how
 * `rayzorben/mudengine:0.5.0` comes to hold the 0.6.0 build.
 *
 * **Pushing is a separate command and never happens as part of a build.** An
 * image push is public and cannot be taken back — the tag can be overwritten
 * but the layers stay in anybody's cache that pulled them — so it is a thing
 * somebody asks for, in one word, rather than the tail end of a build they
 * asked for. `--list` says what a push *would* do without doing it.
 *
 * CI does the same three steps in `.github/workflows/release.yml`, from a tag,
 * with the Docker Hub credentials in repository secrets. This script is the
 * local equivalent, and it is what proves the Dockerfile still builds before a
 * tag is pushed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The repository the image is published under. */
const IMAGE = process.env['MUDENGINE_IMAGE'] ?? 'rayzorben/mudengine';

/**
 * The host port `docker:run` publishes the container's 8080 on.
 *
 * Its own name, not `MUDENGINE_PORT`: that one is the port the *client*
 * listens on, inside the container and under `npm run web` alike, and a
 * shell that set it to 9000 would otherwise mean two different things to
 * two commands.
 */
const PUBLISH_PORT = process.env['MUDENGINE_PUBLISH_PORT'] ?? '8080';

function version() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const value = String(pkg.version ?? '').trim();
  if (value.length === 0) {
    console.error('package.json states no version, so there is nothing to tag an image with.');
    process.exit(1);
  }
  return value;
}

/**
 * Runs a command, inheriting stdio, and stops the script if it fails.
 *
 * `shell: false` and an argument array: a version string interpolated into a
 * shell line is an injection waiting for somebody to put a space in
 * `package.json`.
 */
function run(command, args) {
  console.log(`\n$ ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) {
    console.error(`Could not run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/**
 * Whether `docker` is on PATH and its daemon is answering.
 *
 * Both, not just the first: `docker build` against a daemon that is not
 * running fails a long way in with an error about a socket, and the useful
 * thing to say is which of the two is missing.
 */
function requireDocker() {
  const present = spawnSync('docker', ['--version'], { stdio: 'ignore', shell: false });
  if (present.error || present.status !== 0) {
    console.error('docker is not on PATH. Install Docker, or build in CI (release.yml).');
    process.exit(1);
  }
  const up = spawnSync('docker', ['info'], { stdio: 'ignore', shell: false });
  if (up.status !== 0) {
    console.error('docker is installed but its daemon is not answering. Start it and try again.');
    process.exit(1);
  }
}

const [action = 'build', ...rest] = process.argv.slice(2);
const listOnly = rest.includes('--list');
const tag = version();
const versioned = `${IMAGE}:${tag}`;
const latest = `${IMAGE}:latest`;

if (!['build', 'run', 'push'].includes(action)) {
  console.error(`Unknown action "${action}". Use build, run or push.`);
  process.exit(1);
}

if (listOnly) {
  console.log(`version   ${tag}`);
  console.log(`image     ${versioned}`);
  console.log(`also      ${latest}`);
  console.log(`\n${action} would run against those and nothing else.`);
  process.exit(0);
}

requireDocker();

/**
 * Nothing of the user's may be inside the image.
 *
 * `pack:dir` and `dist:*` run `check:secrets` before *and* after, on the tree
 * and then on the package, because the package is the file that leaves the
 * machine. Only the first half of that transfers here: the build happens
 * inside a container, so the application directory `check:secrets` would want
 * to read never exists on this disk for it to walk.
 *
 * So the second half is asked of the image directly, and it is asked as a
 * *positive* check rather than a grep for a password. `.dockerignore` keeps
 * the user's files out of the build context, and the Dockerfile copies
 * `resources/` from that context whole — so what is worth verifying is that
 * the exclusion still works, which is a question about **which files are
 * there**, answerable exactly.
 *
 * A grep would be the weaker check twice over: it needs a password to search
 * for, and finding none in an image whose config directory it failed to locate
 * is the reassuring answer this repository does not accept.
 */
function refuseUserFilesInImage(image) {
  const forbidden = ['user.yaml', 'profiles', 'realms', 'memory', 'fights', 'mob-lore.json'];
  const listing = spawnSync(
    'docker',
    ['run', '--rm', '--entrypoint', 'sh', image, '-c', 'ls -A /opt/mudengine/resources/config'],
    { encoding: 'utf8', shell: false }
  );

  if (listing.status !== 0) {
    console.error("\nCould not list the image's config directory, so nothing was verified.");
    console.error('That is a failure, not a pass: the check did not run.');
    console.error(listing.stderr?.trim() ?? '');
    process.exit(1);
  }

  const present = listing.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // The check running at all is part of the result. An empty listing means the
  // path moved, not that the image is clean.
  if (present.length === 0) {
    console.error('\n/opt/mudengine/resources/config is empty, which the shipped template is not.');
    console.error('The path has moved and this check is no longer looking at anything.');
    process.exit(1);
  }

  const leaked = present.filter((name) => forbidden.includes(name));
  if (leaked.length > 0) {
    console.error(
      `\nThe image carries files that belong to whoever built it: ${leaked.join(', ')}`
    );
    console.error('Fix .dockerignore before pushing.');
    process.exit(1);
  }

  console.log(`\nChecked ${present.length} shipped config entries; none of them is yours.`);
}

if (action === 'build') {
  // The tree that is about to become the build context, which is the half of
  // `pack:dir`'s bracket that transfers to a container build.
  run('npm', ['run', 'check:secrets']);

  // Both tags in one build: `latest` and the version are the same image, and
  // building twice would produce two of them that could differ.
  run('docker', ['build', '--tag', versioned, '--tag', latest, '.']);

  refuseUserFilesInImage(versioned);

  console.log(`\nBuilt ${versioned} and ${latest}.`);
  console.log(`Run it with:  npm run docker:run`);
}

if (action === 'run') {
  // A named volume rather than a bind mount, so a first run on a fresh machine
  // does not depend on a directory existing with the right ownership -- the
  // image runs as uid 1000 and a bind-mounted host directory owned by anybody
  // else is a container that cannot write its own options file.
  //
  // The client prints where it is listening and, on the first start, the
  // password it generated. `MUDENGINE_PASSWORD` in this shell's environment
  // is passed through so a chosen password can be chosen here too.
  const chosen = process.env['MUDENGINE_PASSWORD'];
  run('docker', [
    'run',
    '--rm',
    '--publish',
    `${PUBLISH_PORT}:8080`,
    '--volume',
    'mudengine:/config',
    ...(chosen ? ['--env', `MUDENGINE_PASSWORD=${chosen}`] : []),
    '--name',
    'mudengine',
    versioned
  ]);
}

if (action === 'push') {
  console.log(`About to push ${versioned} and ${latest} to Docker Hub.`);
  console.log('A push is public and the layers cannot be recalled from anybody who pulled them.');
  console.log('Ctrl-C now if that is not what you meant.\n');
  run('docker', ['push', versioned]);
  run('docker', ['push', latest]);
}
