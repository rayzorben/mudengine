/**
 * What the client needs from whatever is hosting it.
 *
 * The client is `src/main/client.ts`: the sessions, the stores, the realm
 * data and the automation arbiter, and every handler behind `IpcApi`. None of
 * that knows whether it is a desktop application or a server. What differs
 * between the two is here — and it is short, because it was measured before
 * it was designed (todo 102, 2026-09-07): of main's fifty thousand lines,
 * exactly one file imported `electron`, and the twenty-six calls it made fall
 * into the handful of duties below.
 *
 * Two hosts implement it. `ElectronHost` is the desktop: `BrowserWindow`s,
 * `ipcMain`, the operating system's file manager, picker and clipboard.
 * `WebHost` is the same renderer served over HTTP to a browser tab, with the
 * contract carried on a WebSocket and the desktop duties either answered
 * another way or refused out loud. **A host that cannot do something says
 * so** — `windows` is null, `reveal` answers false, `chooseFile` answers null
 * — and the client turns each of those into a refusal the window can show.
 * Nothing here no-ops.
 *
 * `WindowRegistry` already proved the shape: it was typed against the part of
 * a window it needed rather than against `BrowserWindow`, precisely so it
 * could be tested without a browser, and a browser tab on a socket satisfies
 * it exactly as a window does.
 */
import type { HostKind, SessionId } from '../../shared/ipc';
import type { Home } from '../app/home';
import type { QuitAnswer, QuitGuard } from '../app/quit';
import type { WindowRegistry } from '../windows/WindowRegistry';
import type { Workspace } from '../windows/Workspace';

/**
 * Whoever made a call: the window (or tab) it came from, and a way to answer
 * it alone. `windowId` is what the registry knows the view by; `-1` is a
 * caller no window claims, which the client answers as it would answer
 * anybody.
 */
export interface Caller {
  readonly windowId: number;
  send(channel: string, payload: unknown): void;
}

/**
 * A handler behind one channel. The arguments are `any` for the reason
 * Electron's own `ipcMain.handle` types them so: each handler states its
 * own parameters and parses what crossed the wire at its own boundary.
 */
export type Handler = (caller: Caller, ...args: any[]) => unknown;

/** How `IpcApi` reaches the client: request/response and fire-and-forget. */
export interface Transport {
  /** `Invoke.*` — the answer, or a thrown error, goes back to the caller. */
  handle(channel: string, handler: Handler): void;
  /** `Send.*` — nothing goes back. */
  on(channel: string, listener: Handler): void;
}

/** Chromium's verdict on the GPU, where there is a Chromium to ask. */
export interface GpuStatus {
  compositing: string;
  rasterization: string;
  webgl: string;
}

/** The quit confirmation, worded by the client and put up by the host. */
export interface QuitQuestion {
  title: string;
  message: string;
  detail: string;
  confirm: string;
  cancel: string;
}

/** A file picker's terms, worded by the client and put up by the host. */
export interface FileChoice {
  title: string;
  extensions: readonly string[];
  extensionsLabel: string;
  allFilesLabel: string;
}

/**
 * Windows, for a host that has more than one.
 *
 * Popping a character out, gathering them back and closing an emptied window
 * are the three things the client does with a second window; a host with
 * `windows: null` has no second window, and the client refuses each with a
 * reason the tab can show.
 */
export interface WindowHost {
  /** Open a window owning these characters. Null if it could not be. */
  open(owns: SessionId[]): number | null;
  close(windowId: number): void;
  focus(windowId: number): void;
  /** How many are open, for the quit guard to know whether to make one. */
  count(): number;
}

/**
 * What the host may reach back into once the client is built.
 *
 * Handed over in `open`, which is the moment everything below exists: the
 * registry a new window registers with, the workspace it claims characters
 * through, the rosters to republish when it goes, and the quit guard a
 * closing window has to ask before it ends the application.
 */
export interface ClientHooks {
  home: Home;
  windows: WindowRegistry;
  workspace(): Workspace | null;
  publishRosters(): void;
  quitting: QuitGuard;
  /** The client's own icon, for a window's frame. */
  appIcon(): string;
  /**
   * The host cannot open. Ends the client with the reason said, the stores
   * disposed and the exit held until the reason has left the pipe — never
   * `process.exit` on the line after a `console.error`, which loses the one
   * sentence that says why and skips the teardown.
   */
  abort(reason: string): void;
}

/**
 * Where the built halves are, as `src/main/index.ts` states them. The hosts
 * are chunks of their own under `out/main/chunks/`, so their own location
 * says nothing about the preload's or the renderer's; the entry's does.
 */
export interface Layout {
  /** `out/preload/index.mjs`. */
  preload: string;
  /** `out/renderer/`, holding `index.html` and `assets/`. */
  rendererDir: string;
  /** `resources/` in a checkout; a package puts them elsewhere and says so. */
  resources: string;
}

export interface Host {
  readonly kind: HostKind;
  /** Whether this is an installed package, which is where resources live elsewhere. */
  readonly packaged: boolean;
  /** Where the platform keeps this user's data; the home when nothing overrides it. */
  readonly defaultHome: string;
  /** The packaged resources root, or null when running from a checkout. */
  readonly resourcesPath: string | null;
  /** Where the resources might be in a checkout, probed in order. */
  resourceCandidates(): string[];
  /** For a bug report: what is running the client. */
  readonly runtime: string;

  readonly transport: Transport;

  /** Resolves once the host can open anything. */
  ready(): Promise<void>;
  /**
   * Whether this process owns the profile and may go on starting. A host that
   * refuses has already said so and asked to leave (`app/instance.ts`).
   */
  claimInstance(options: { say(message: string): void; leave(): void }): boolean;
  /** The client is built and every channel is handled: show it, or serve it. */
  open(hooks: ClientHooks): void;

  /** A second window, or null where there can never be one. */
  readonly windows: WindowHost | null;
  /**
   * Whose rail the workspace calls main: the window unclaimed characters fall
   * to. A host with one rail for every view answers with that rail.
   */
  mainWindowId(): number | null;

  /** Chromium's compositing verdict, or null where nothing here composites. */
  gpu(): GpuStatus | null;
  /** Show a path in the operating system's file manager. False: it cannot be. */
  reveal(target: string, kind: 'file' | 'directory'): Promise<boolean>;
  /** A native file picker. Null when dismissed — or when there is no such thing. */
  chooseFile(caller: Caller, choice: FileChoice): Promise<string | null>;
  /** The system clipboard, or null where the window has to keep its own. */
  readonly clipboard: { read(): string; write(text: string): void } | null;
  /** Put the quit confirmation up and wait for the answer. */
  askAboutQuitting(question: QuitQuestion): QuitAnswer;

  /** Stop hosting: close what listens. Part of teardown; must not throw. */
  close(): void;
  /** End the process now. */
  exit(code: number): void;
}
