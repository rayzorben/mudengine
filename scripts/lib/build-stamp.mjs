/**
 * The commit a build is made from, stamped into main and the window as
 * `__BUILD_STAMP__` (`electron.vite.config.ts`, read by `src/shared/build.ts`).
 *
 * Git answers where the tree has it. A Docker build has no `.git`
 * (`.dockerignore`), so `MUDENGINE_COMMIT` and `MUDENGINE_DIRTY=1` carry it in
 * as build args (`Dockerfile`, `deploy/azure.sh`, `scripts/docker.mjs`).
 * Neither gives `commit: null`, which the client shows as unknown. Run
 * directly it prints the same for a shell, so an image tag and the tooltip
 * read one answer.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The short hash of HEAD at this length everywhere, so a tag and a tooltip match. */
export const COMMIT_LENGTH = 8;

/** `{ commit, dirty, builtAt }` for the tree at `root`. */
export function buildStamp(root) {
  const builtAt = new Date().toISOString();
  const given = (process.env['MUDENGINE_COMMIT'] ?? '').trim();
  if (given.length > 0) {
    const commit = given.slice(0, COMMIT_LENGTH);
    return { commit, dirty: process.env['MUDENGINE_DIRTY'] === '1', builtAt };
  }
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  try {
    return {
      commit: git('rev-parse', `--short=${COMMIT_LENGTH}`, 'HEAD'),
      dirty: git('status', '--porcelain', '--untracked-files=no').length > 0,
      builtAt
    };
  } catch (error) {
    console.warn(`[build stamp] no commit for this build, shown as unknown: ${error.message}`);
    return { commit: null, dirty: false, builtAt };
  }
}

// Run directly, prints `<commit> <1 when dirty>` for a shell (`deploy/azure.sh`).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { commit, dirty } = buildStamp(process.argv[2] ?? process.cwd());
  console.log(`${commit ?? ''} ${dirty ? '1' : ''}`);
}
