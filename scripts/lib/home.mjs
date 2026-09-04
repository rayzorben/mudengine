/**
 * Where the client keeps its files, for a script that has to read or write them.
 *
 * The same answer `src/main/app/home.ts` gives, computed without Electron —
 * because a probe is a plain Node process and `app.getPath('userData')` is not
 * available to it. Kept deliberately small and in one place for the reason
 * CLAUDE.md records about the realm address: a path spelled out in eight probes
 * goes stale in seven of them, and the failure is silent.
 *
 *   Linux    $XDG_CONFIG_HOME/mudengine, or ~/.config/mudengine
 *   Windows  %APPDATA%\mudengine
 *   macOS    ~/Library/Application Support/mudengine
 *
 * `MUDENGINE_HOME` overrides it outright, which is how every harness gets a
 * tree of its own rather than writing into the developer's characters.
 */
import os from 'node:os';
import path from 'node:path';

/** The client's home directory for this run. */
export function homeRoot() {
  const asked = (process.env.MUDENGINE_HOME ?? '').trim();
  if (asked.length > 0) return path.resolve(asked);

  // The variable this replaced named a *file*; its directory is the home, and
  // main says so out loud when it sees it. Honoured here so a shell that still
  // exports it drives the same tree the client would use.
  const legacy = (process.env.MUDENGINE_CONFIG ?? '').trim();
  if (legacy.length > 0) return path.dirname(path.resolve(legacy));

  return path.join(userData(), 'mudengine');
}

/** Every path inside a home directory. Mirrors `homeAt` in `app/home.ts`. */
export function homePaths(root = homeRoot()) {
  return {
    root,
    options: path.join(root, 'global', 'default.yaml'),
    globalLoops: path.join(root, 'global', 'loops'),
    serversDir: path.join(root, 'servers'),
    profilesDir: path.join(root, 'profiles'),
    /**
     * Where session logs and captures land when `logging.directory` is empty —
     * which is the default. Mirrors `home.state('logs')` in `src/main/index.ts`.
     */
    logs: path.join(root, 'logs'),
    server: (id) => ({
      dir: path.join(root, 'servers', id),
      file: path.join(root, 'servers', id, 'server.yaml'),
      loops: path.join(root, 'servers', id, 'loops')
    }),
    profile: (id) => ({
      dir: path.join(root, 'profiles', id),
      file: path.join(root, 'profiles', id, 'profile.yaml'),
      loops: path.join(root, 'profiles', id, 'loops')
    })
  };
}

function userData() {
  if (process.platform === 'win32') {
    return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
}
