/**
 * One client per home, whichever host it runs under.
 *
 * `app/instance.ts` keeps one client per *profile* on the desktop, through
 * Electron's own lock on its user-data directory — and records why, as a
 * measurement: two clients on one home write the same lore, memory, fight
 * logs and workspace, each a lazily flushed file whose last writer wins, and
 * with `autoConnect` dial characters already in the realm, where the server
 * drops one of the two.
 *
 * That lock is Electron's, and a plain Node process neither takes it nor is
 * refused by it. `npm run web` with no `MUDENGINE_HOME` lands on exactly the
 * directory the desktop client is holding (`platformUserData` was written to
 * make sure of that), and two web hosts on two ports never consult anything.
 * So the *home* is locked here, by the client and not by a host, with a file
 * either host respects: a pid, taken exclusively, checked for life when it is
 * found, and released on the way out.
 *
 * Advisory and honest about it. A lock left by a process that died — a
 * `kill -9`, a crash, a container stopped hard — names a pid nobody has, and
 * is taken over and said so. A pid that has been reused by something else is
 * refused as though it were a client, which is the safe wrong answer: the
 * remedy is deleting a file whose location is printed.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Where the lock lives, under the home. */
export const LOCK_FILE = '.lock';

export interface HomeLock {
  readonly file: string;
  /** Gives the home up. Idempotent, and never removes a lock somebody else took. */
  release(): void;
}

export type HomeClaim =
  | { held: true; lock: HomeLock; recovered: number | null }
  | { held: false; by: number; file: string };

/** Whether a process is running. `EPERM` is a process that exists and is not ours. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPid(file: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function claimHome(
  root: string,
  pid: number = process.pid,
  alive: (pid: number) => boolean = isAlive
): HomeClaim {
  const file = path.join(root, LOCK_FILE);
  fs.mkdirSync(root, { recursive: true });

  const lock = (): HomeLock => ({
    file,
    release: () => {
      if (readPid(file) !== pid) return;
      try {
        fs.unlinkSync(file);
      } catch {
        // Already gone, which is what release means.
      }
    }
  });

  const take = (): boolean => {
    let handle: number;
    try {
      handle = fs.openSync(file, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    try {
      fs.writeSync(handle, `${pid}\n`);
    } finally {
      fs.closeSync(handle);
    }
    return true;
  };

  if (take()) return { held: true, lock: lock(), recovered: null };

  const holder = readPid(file);
  // A file with no pid in it is a lock nobody can be holding; one whose pid
  // is not running is a lock its holder never released.
  if (holder !== null && holder !== pid && alive(holder)) return { held: false, by: holder, file };
  try {
    fs.unlinkSync(file);
  } catch {
    // Somebody else may have just cleared it; the retry below decides.
  }
  if (take()) return { held: true, lock: lock(), recovered: holder };
  const winner = readPid(file);
  return { held: false, by: winner ?? -1, file };
}
