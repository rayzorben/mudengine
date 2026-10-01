/**
 * One harness per debugging port on this machine, whichever checkout it runs
 * from. A second run on the same port attaches to the first one's Electron and
 * both read a home neither of them wiped, so a second run waits here until
 * the first exits. `mudengine-verify` › `parts/harnesses.md` › *One harness
 * per debugging port on the machine*.
 *
 * The lock is a file in the system temp directory holding the owner's pid. A
 * pid that is no longer running, or a file that names none, was left behind
 * (a kill), so it is taken.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const POLL_MS = 2000;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: running, under another user.
    return error.code === 'EPERM';
  }
}

function ownerOf(file) {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`reading the harness lock ${file}: ${error.message}`, { cause: error });
  }
}

/**
 * Creates the lock holding this pid, or false when one exists. The pid is
 * written first and linked into place, so no reader ever sees the file empty.
 */
function claim(file) {
  const draft = `${file}.${process.pid}`;
  fs.writeFileSync(draft, String(process.pid));
  try {
    fs.linkSync(draft, file);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw new Error(`taking the harness lock ${file}: ${error.message}`, { cause: error });
  } finally {
    fs.rmSync(draft, { force: true });
  }
}

/**
 * Removes a lock whose owner `dead` has exited. Renamed aside first, so of two
 * runs clearing it only one gets the file; and a file that turns out to hold
 * another pid, a run that took the lock in between, is put back.
 */
function clearStale(file, dead) {
  const aside = `${file}.stale.${process.pid}`;
  try {
    fs.renameSync(file, aside);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error(`clearing the harness lock ${file}: ${error.message}`, { cause: error });
  }
  if (ownerOf(aside) !== dead) {
    try {
      fs.linkSync(aside, file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  fs.rmSync(aside, { force: true });
}

/**
 * Holds `port` for this process until it exits, waiting while a live process
 * holds it. `label` names the harness in what it prints.
 */
export async function holdPort(port, label) {
  const file = path.join(os.tmpdir(), `mudengine-harness-${port}.lock`);
  let said = false;
  while (!claim(file)) {
    const owner = ownerOf(file);
    if (owner === null || !alive(owner)) {
      clearStale(file, owner);
      continue;
    }
    if (!said) {
      console.log(`${label}: waiting for pid ${owner}, which holds port ${port}`);
      said = true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  // A run killed by a signal leaves the file behind, and the pid test above
  // takes it; the harnesses' own signal handlers end in `exit` and remove it.
  process.on('exit', () => {
    if (ownerOf(file) === process.pid) fs.rmSync(file, { force: true });
  });
}
