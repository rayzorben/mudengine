/**
 * The smoke failures already known, by name, so a new one stops the run.
 *
 * A count cannot tell a new failure from an old one: a stale assertion once
 * hid inside twenty-two "inherited" failures. Names are compared with the last
 * accepted list, as `captures/baseline.json` is for the corpus: a failure not
 * on it fails the run, and so does a listed one that now passes, so the list
 * shrinks only on purpose. `-- --accept` records this run's, `[]` when none
 * failed, since the gate hashes the file. A name is `check`'s second argument,
 * never its detail, so one carrying a number fails as new, the safe way.
 * `mudengine-verify` § The gate is chosen by path has the rule.
 */
import fs from 'node:fs';

/**
 * Prints the verdict and returns the exit code: 0 when the failures are
 * exactly the known ones (or were just recorded), 1 otherwise.
 */
export function judgeFailures(failed, { file, accept, command }) {
  const now = [...new Set(failed)].sort();
  if (accept) {
    fs.writeFileSync(file, JSON.stringify(now, null, 2) + '\n', 'utf8');
    console.log(`\n${now.length} known failure(s) recorded in ${file}.\n`);
    return 0;
  }

  const known = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  const knownSet = new Set(known);
  const nowSet = new Set(now);
  const fresh = now.filter((name) => !knownSet.has(name));
  const fixed = known.filter((name) => !nowSet.has(name));
  const still = now.filter((name) => knownSet.has(name));

  if (fresh.length === 0 && fixed.length === 0) {
    console.log(
      still.length === 0
        ? '\nAll checks passed.\n'
        : `\nNo new failures. ${still.length} known failure(s) still failing, listed in ${file}.\n`
    );
    return 0;
  }
  if (fresh.length > 0) {
    console.log(`\n${fresh.length} NEW failure(s), not in ${file}:`);
    for (const name of fresh) console.log(`   NEW   ${name}`);
  }
  if (fixed.length > 0) {
    console.log(`\n${fixed.length} known failure(s) now pass:`);
    for (const name of fixed) console.log(`   FIXED ${name}`);
  }
  if (still.length > 0) console.log(`\n${still.length} known failure(s) still failing.`);
  console.log(`\nIf that is the change intended, record it: ${command}\n`);
  return 1;
}
