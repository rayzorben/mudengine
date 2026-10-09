/**
 * Where an Electron harness opens its window. On Linux it is always a virtual
 * X server when `xvfb-run` is installed, at the smallest screen the client is
 * built for, so every run measures the same layout on every machine. Without
 * one it opens a real window only when asked (`--windowed`), and refuses
 * otherwise. `mudengine-verify` › `parts/harnesses.md` › *Every harness runs
 * on a 1920x1080 virtual screen*.
 */
import { spawn, spawnSync } from 'node:child_process';

/*
 * The smallest screen the client is developed for (user, 2026-10-09). The
 * main window opens at a share of the screen's work area, so `xvfb-run`'s own
 * default (640x480 on Arch, 1280x1024 on Ubuntu) tested a different layout on
 * each machine.
 */
export const VIRTUAL_SCREEN = { width: 1920, height: 1080 };

const hasXvfbRun = () =>
  spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status === 0;

/**
 * True when the harness runs on a virtual display. Exits the process with the
 * reason when there is no display it may use: a desktop session with no
 * `xvfb-run` (the client takes the keyboard on launch, which is its focus
 * policy), or no display at all.
 */
export function useVirtualDisplay(windowed) {
  if (process.platform !== 'linux' || windowed) return false;
  if (hasXvfbRun()) return true;
  const hasSession = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  console.error(
    hasSession
      ? '\nThere is a desktop session here and no `xvfb-run` to hide behind, so this\n' +
          'would open a window and take your keyboard. Install xvfb, or pass --windowed\n' +
          'if you meant to watch it.\n'
      : '\nThere is no display here and no `xvfb-run` to make one. Install xvfb.\n'
  );
  process.exit(1);
}

/**
 * Spawn Electron on the display `useVirtualDisplay` chose. On the virtual one
 * it forces the X11 backend and drops `WAYLAND_DISPLAY`: Electron prefers
 * Wayland when it is set and opened on the real desktop, taking the keyboard
 * mid-sentence into the game's login prompt.
 *
 * Pass `detached: true` to signal the whole tree: `xvfb-run` is a shell
 * wrapper, and killing it alone leaves Electron holding the debugging port.
 */
export function spawnElectron(virtual, electron, args, options) {
  if (!virtual) return spawn(electron, args, options);
  const env = { ...(options.env ?? process.env) };
  delete env.WAYLAND_DISPLAY;
  const { width, height } = VIRTUAL_SCREEN;
  return spawn(
    'xvfb-run',
    ['-a', '-s', `-screen 0 ${width}x${height}x24`, electron, '--ozone-platform=x11', ...args],
    { ...options, env }
  );
}
