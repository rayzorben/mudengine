/**
 * Where everything the client owns lives, said once.
 *
 * The client writes eleven kinds of file — the options, the characters, the
 * servers, the loops, the internal settings, the world memory, the fight logs,
 * the realm cache, the monster lore, the session logs and the workspace — and
 * until now each named its own place by joining onto `path.dirname(the options
 * file)`. Five copies of that expression is five chances for one of them to
 * end up somewhere else, and the one that does is silent: a file written to the
 * wrong directory is not an error, it is a record nobody ever reads again.
 *
 * Two rules, and they are the whole module.
 *
 * - **One root.** `~/.config/mudengine` on Linux, `%APPDATA%\mudengine` on
 *   Windows, `~/Library/Application Support/mudengine` on macOS — which is
 *   Electron's `userData` and the platform's own answer, in development as well
 *   as in a package. It used to be `resources/config/` beside the source tree
 *   while developing, which put a player's real characters and their real
 *   passwords inside a git checkout, and made "what does a fresh install look
 *   like" a question nobody could answer without moving files by hand.
 * - **A path is a function of the root**, so a test names a temporary directory
 *   and gets the whole tree, and the harnesses need no environment variable per
 *   record they want to keep out of the developer's own.
 *
 * The tree:
 *
 * ```
 * <root>/
 *   global/default.yaml        the options everything inherits
 *   global/loops/*.yaml        loops every character may walk
 *   servers/<id>/server.yaml   one BBS or realm
 *   servers/<id>/loops/*.yaml  loops for every character on that server
 *   profiles/<id>/profile.yaml one character
 *   profiles/<id>/loops/*.yaml loops only that character may walk
 *   internal.yaml              the client's settings about itself
 *   memory/  fights/  realms/  logs/  mob-lore.json  workspace.json
 * ```
 *
 * Pure: no `electron`, no `fs`. {@link homeRoot} is the one function that asks
 * the platform anything, and it is handed what it needs.
 */
import path from 'node:path';

/** Every path the client writes to, derived from one root. */
export interface Home {
  /** The directory everything below is inside. */
  root: string;
  /** The options file: what every character inherits. */
  options: string;
  /** `global/`, which holds the options file and the loops everyone may walk. */
  globalDir: string;
  /** Loops available to every character, whatever server they play on. */
  globalLoops: string;
  /** Where servers live, one directory each. */
  serversDir: string;
  /** Where characters live, one directory each. */
  profilesDir: string;
  /** The client's own settings, hot-reloaded beside the options. */
  internal: string;
  /** One server's directory, its file, and the loops it lends its characters. */
  server(id: string): Scope;
  /** One character's directory, its file, and the loops only it may walk. */
  profile(id: string): Scope;
  /** A record the client keeps: `memory`, `fights`, `realms`, `logs`. */
  state(...names: string[]): string;
}

/** A directory that holds one thing's own file and its own loops. */
export interface Scope {
  dir: string;
  file: string;
  loops: string;
}

/** What a server's file is called inside its directory. */
export const SERVER_FILE = 'server.yaml';
/** What a character's file is called inside its directory. */
export const PROFILE_FILE = 'profile.yaml';
/** What the options file is called inside `global/`. */
export const OPTIONS_FILE = 'default.yaml';
/** The directory a scope keeps its loops in, at every one of the three. */
export const LOOPS_DIR = 'loops';

export function homeAt(root: string): Home {
  const globalDir = path.join(root, 'global');
  const serversDir = path.join(root, 'servers');
  const profilesDir = path.join(root, 'profiles');

  const scope = (dir: string, file: string): Scope => ({
    dir,
    file: path.join(dir, file),
    loops: path.join(dir, LOOPS_DIR)
  });

  return {
    root,
    globalDir,
    options: path.join(globalDir, OPTIONS_FILE),
    globalLoops: path.join(globalDir, LOOPS_DIR),
    serversDir,
    profilesDir,
    internal: path.join(root, 'internal.yaml'),
    server: (id) => scope(path.join(serversDir, id), SERVER_FILE),
    profile: (id) => scope(path.join(profilesDir, id), PROFILE_FILE),
    state: (...names) => path.join(root, ...names)
  };
}

/**
 * Where the root is, given the environment and the platform's answer.
 *
 * `MUDENGINE_HOME` names a **directory** and wins outright — it is an
 * instruction, not a candidate, for the reason `ConfigStore` records about the
 * variable it replaces: a search path only wins if what it names already
 * exists, so pointing a harness at a fresh location used to fall through to
 * whichever ordinary place had a file, which on a developer's machine is their
 * real configuration with their real characters in it.
 *
 * `MUDENGINE_CONFIG` named a *file* and is what every harness and shell profile
 * still has set. Its directory is taken as the root and the change is said out
 * loud, because a variable that silently stops working is how a test run ends
 * up writing into somebody's real options.
 */
export function homeRoot(
  env: NodeJS.ProcessEnv,
  userData: string
): { root: string; note?: string } {
  const asked = (env['MUDENGINE_HOME'] ?? '').trim();
  if (asked.length > 0) return { root: asked };

  const legacy = (env['MUDENGINE_CONFIG'] ?? '').trim();
  if (legacy.length > 0) {
    return {
      root: path.dirname(legacy),
      note:
        `MUDENGINE_CONFIG named a file and now the client keeps a directory, so ` +
        `${path.dirname(legacy)} is being used as its home. Set MUDENGINE_HOME instead.`
    };
  }

  return { root: userData };
}
