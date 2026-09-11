/**
 * The desktop host: Electron.
 *
 * The one module in `src/main/` that imports `electron`, and deliberately so
 * — `src/main/index.ts` chooses between this and `WebHost` at startup, and a
 * static `electron` import anywhere the web host's chunk can reach would end
 * the process under plain Node during ESM preparse, before a line of the
 * client ran (the same failure `ELECTRON_RUN_AS_NODE` causes, recorded in
 * CLAUDE.md). Everything here was lifted out of `index.ts` on 2026-09-07 with
 * its reasoning intact; the reasoning is the part worth keeping.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, screen, shell } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { SessionId } from '../../shared/ipc';
import { t } from '../app/i18n';
import { ownTheProfile } from '../app/instance';
import type { QuitAnswer } from '../app/quit';
import type { Caller, ClientHooks, Host, Layout, Transport } from './Host';

export function createElectronHost(layout: Layout): Host {
  let mainWindow: BrowserWindow | null = null;
  let hooks: ClientHooks | null = null;

  /** Who sent this, as the client wants to know it. */
  const callerOf = (sender: Electron.WebContents): Caller => ({
    windowId: BrowserWindow.fromWebContents(sender)?.id ?? -1,
    send: (channel, payload) => {
      if (!sender.isDestroyed()) sender.send(channel, payload);
    }
  });

  const transport: Transport = {
    handle: (channel, handler) =>
      ipcMain.handle(channel, (event, ...args) => handler(callerOf(event.sender), ...args)),
    on: (channel, listener) =>
      ipcMain.on(channel, (event, ...args) => {
        listener(callerOf(event.sender), ...args);
      })
  };

  /**
   * Whether closing this window is what ends the application.
   *
   * On macOS it never is: the last window closing leaves the app in the dock
   * with every session alive, so there is nothing to warn about — `Cmd Q` goes
   * through `before-quit`, which asks.
   */
  function lastWindowStanding(window: BrowserWindow): boolean {
    if (process.platform === 'darwin') return false;
    return BrowserWindow.getAllWindows().every((other) => other === window || other.isDestroyed());
  }

  /**
   * A window.
   *
   * `owns` names the characters whose tabs live here; empty means the main
   * window, which answers for everything nobody else claims. A popped-out
   * window is the *same renderer* — there is nothing special about it beyond
   * which characters it has tabs for, which is what keeps one code path for
   * both.
   */
  function createWindow(options: { owns?: SessionId[] } = {}): BrowserWindow | null {
    // Before `open`, there is no registry to put a window in and nothing for
    // it to show; a `second-instance` arriving in that gap is left to the
    // window `open` is about to make.
    if (!hooks) return null;
    const client = hooks;
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const popped = (options.owns?.length ?? 0) > 0;
    const icon = client.appIcon();

    const window = new BrowserWindow({
      // A pop-out is narrower by default because it holds one character, but
      // not below the floor: the console needs 80 columns and no server in
      // this family will format to fewer (docs/profiles.md §9.1).
      width: popped
        ? Math.max(900, Math.floor(width * 0.5))
        : Math.max(1100, Math.floor(width * 0.8)),
      height: Math.max(760, Math.floor(height * 0.85)),
      minWidth: 720,
      minHeight: 480,
      show: false,
      backgroundColor: '#0b0d12',
      autoHideMenuBar: true,
      title: t('app.windowTitle'),
      /*
       * The window's own icon, which is a different thing from the installer's.
       *
       * `build/icon.*` is what electron-builder stamps into a package, and that
       * covers the Windows executable and the macOS bundle — but on Linux the
       * running window and its taskbar entry take the icon from *here*, and in
       * development every platform does. Without it the client somebody is
       * actually looking at wears the default Electron logo however carefully
       * the installer was built.
       *
       * Omitted rather than passed as a missing path, because Electron's own
       * complaint about one is less useful than the default icon.
       */
      ...(existsSync(icon) ? { icon } : {}),
      webPreferences: {
        preload: layout.preload,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    if (!popped) mainWindow = window;
    window.once('ready-to-show', () => window.show());

    /*
     * A window is a view onto sessions, and the registry is what routes output
     * to it. Registering here — and dropping it on `closed` — is the whole of a
     * window's relationship with the engine; nothing about closing one reaches
     * a socket.
     */
    client.windows.add({
      id: window.id,
      isDestroyed: () => window.isDestroyed(),
      send: (channel, payload) => window.webContents.send(channel, payload)
    });
    client.workspace()?.open(window.id);
    for (const session of options.owns ?? []) client.workspace()?.move(session, window.id);

    /*
     * The question is asked *here*, before the window goes.
     *
     * Closing the last window is what raises `window-all-closed`, which calls
     * `app.quit`, which is what asks — so the window had already gone by the
     * time anybody was asked, and "keep playing" left four characters connected
     * to a PvP realm with nothing on screen to play them with. Vetoing the
     * close is the only thing that actually keeps the window, and it is the
     * same on every platform: `close` is raised by the frame's own button, by
     * the window menu and by Alt-F4 / Cmd-W alike.
     *
     * Only for a close that would *end the app*. A pop-out closing hands its
     * characters back and disconnects nobody (docs/profiles.md §4), so asking
     * would be a confirmation nobody needs — and on macOS the last window
     * closing leaves the app running, which disconnects nobody either.
     */
    window.on('close', (event) => {
      if (!lastWindowStanding(window)) return;
      if (!client.quitting.mayQuit()) event.preventDefault();
    });

    window.on('closed', () => {
      client.windows.remove(window.id);
      /*
       * Its characters go back to the main window rather than with it. Closing
       * a window must never disconnect a character, and a character with a
       * live socket and no tab anywhere is one nobody can reach.
       */
      client.workspace()?.close(window.id);
      if (mainWindow === window) mainWindow = null;
      client.workspace()?.save();
      client.publishRosters();
    });

    /*
     * Keep external links out of the app frame — and keep everything that is
     * not a web address out of the system entirely.
     *
     * This is reached by a *click on server text*: the terminal linkifies what
     * the realm prints, and what the realm prints is written by whoever is
     * playing on it. `shell.openExternal` hands a string to the operating
     * system to do as it sees fit, and `file:`, `smb:` and a long tail of
     * registered handlers are all things it will do. Only `http` and `https`
     * reach it.
     */
    window.webContents.setWindowOpenHandler(({ url }) => {
      let scheme = '';
      try {
        scheme = new URL(url).protocol;
      } catch {
        // Not a URL at all. Nothing to open.
      }
      if (scheme === 'http:' || scheme === 'https:') void shell.openExternal(url);
      return { action: 'deny' };
    });

    const devServer = process.env['ELECTRON_RENDERER_URL'];
    if (devServer) {
      void window.loadURL(devServer);
    } else {
      void window.loadFile(path.join(layout.rendererDir, 'index.html'));
    }
    client.workspace()?.save();
    return window;
  }

  const ensureWindow = (): void => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  };

  return {
    kind: 'electron',
    packaged: app.isPackaged,
    defaultHome: app.getPath('userData'),
    resourcesPath: app.isPackaged ? process.resourcesPath : null,
    /*
     * In development the resources cannot be derived from `app.getAppPath()`:
     * launching the built main directly puts it at `<root>/out`, while
     * `electron-vite dev` puts it at `<root>`. Depending on one of those
     * silently found no resources under the other — the realm data failed to
     * load and the annotated config template was quietly replaced by an empty
     * file. So the client probes these in order for a file that must be there.
     */
    resourceCandidates: () => [
      layout.resources,
      path.join(app.getAppPath(), 'resources'),
      path.join(app.getAppPath(), '..', 'resources'),
      path.join(process.cwd(), 'resources')
    ],
    runtime: `Electron ${process.versions.electron}`,
    transport,

    ready: () => app.whenReady(),

    /*
     * Claimed before anything is built, because everything built here is
     * shared. The reasoning, and the measurement that produced it, are in
     * `src/main/app/instance.ts`.
     */
    claimInstance: ({ say, leave }) =>
      ownTheProfile({
        claim: () => app.requestSingleInstanceLock(),
        onAnotherLaunch: (handler) => app.on('second-instance', handler),
        raise: () => {
          const window = mainWindow ?? BrowserWindow.getAllWindows()[0];
          // Every window may have been closed on macOS, where that does not quit.
          if (!window || window.isDestroyed()) {
            createWindow();
            return;
          }
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
        },
        say,
        leave
      }),

    open: (client) => {
      hooks = client;
      createWindow();
      /*
       * Whatever was popped out last time.
       *
       * After the main window, so `mainWindowId()` answers and the characters
       * that are *not* restored fall to it. A remembered window naming only
       * characters that have since been deleted is dropped rather than opened
       * empty.
       */
      for (const owns of client.workspace()?.restore() ?? []) createWindow({ owns });

      app.on('activate', ensureWindow);
      /*
       * Closing windows does not end sessions.
       *
       * A session belongs to the app (docs/profiles.md §4). This used to
       * dispose the one session here, which was indistinguishable from correct
       * while a window and a session were the same thing — and is exactly
       * wrong once a character can be popped out into a window of its own,
       * where closing that window has to hand the tab back rather than
       * disconnect. Quitting is what ends a session, and `before-quit` does it.
       */
      app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
      });
      app.on('before-quit', client.quitting.beforeQuit);
    },

    windows: {
      open: (owns) => createWindow({ owns })?.id ?? null,
      close: (windowId) => BrowserWindow.fromId(windowId)?.close(),
      /*
       * Minimised counts as behind everything else: a window brought forward
       * for a character that has just been attacked has to actually appear,
       * which `focus()` alone does not do to an iconified window. Same three
       * calls as `claimInstance`'s `raise`, for the same reason.
       */
      focus: (windowId) => {
        const window = BrowserWindow.fromId(windowId);
        if (!window || window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      },
      count: () => BrowserWindow.getAllWindows().length
    },
    mainWindowId: () => mainWindow?.id ?? null,

    gpu: () => {
      const status = app.getGPUFeatureStatus();
      return {
        compositing: status.gpu_compositing,
        rasterization: status.rasterization,
        webgl: status.webgl
      };
    },

    reveal: async (target, kind) => {
      if (kind === 'file') shell.showItemInFolder(target);
      else await shell.openPath(target);
      return true;
    },

    /*
     * A native picker. Owned by the window that asked, so the sheet is
     * attached to it on macOS and modal to it everywhere. A window that has
     * already gone gets the unparented form rather than a thrown null.
     */
    chooseFile: async (caller, choice) => {
      const owner = BrowserWindow.fromId(caller.windowId);
      const options: Electron.OpenDialogOptions = {
        title: choice.title,
        properties: ['openFile'],
        filters: [
          { name: choice.extensionsLabel, extensions: [...choice.extensions] },
          { name: choice.allFilesLabel, extensions: ['*'] }
        ]
      };
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },

    clipboard: {
      read: () => clipboard.readText(),
      write: (text) => clipboard.writeText(text)
    },

    /*
     * The question, asked where somebody can still answer it. Synchronous
     * and modal, which is what lets the decision be made *after* the answer
     * rather than before it (`app/quit.ts`).
     */
    askAboutQuitting: (question): QuitAnswer => {
      const box: Electron.MessageBoxSyncOptions = {
        type: 'warning',
        buttons: [question.confirm, question.cancel],
        defaultId: 1,
        cancelId: 1,
        title: question.title,
        message: question.message,
        detail: question.detail
      };
      const owner = mainWindow ?? BrowserWindow.getAllWindows()[0];
      const answer =
        owner && !owner.isDestroyed()
          ? dialog.showMessageBoxSync(owner, box)
          : dialog.showMessageBoxSync(box);
      return answer === 0 ? 'quit' : 'stay';
    },

    // Nothing listens: the windows are closed by the quit itself.
    close: () => {},
    /*
     * `app.exit` deliberately does **not** raise `before-quit`: a confirmation
     * nobody is looking at is a client that hangs on a modal dialog, and
     * whoever signalled the process has already decided.
     */
    exit: (code) => app.exit(code)
  };
}
