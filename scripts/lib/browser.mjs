/**
 * Electron as a plain browser, for a harness that needs one.
 *
 *   electron scripts/lib/browser.mjs --remote-debugging-port=9555
 *
 * Opens `MUDENGINE_BROWSE_URL` in a `BrowserWindow` with **no preload**: the
 * page gets nothing but Chromium, which is exactly what a browser tab gets,
 * so `window.mudengine` is absent and the renderer installs its own bridge
 * over the WebSocket (`src/renderer/src/lib/webBridge.ts`). Chromium is the
 * one browser this repository already ships, so the web mode is proved in a
 * real one without adding a second.
 *
 * `MUDENGINE_BROWSE_TABS` opens that many windows, because a second tab is
 * what proves every tab draws the one rail. Each is a page target over CDP.
 */
import { app, BrowserWindow } from 'electron';

const url = process.env['MUDENGINE_BROWSE_URL'] ?? '';
const tabs = Math.max(1, Number(process.env['MUDENGINE_BROWSE_TABS'] ?? '1') || 1);

if (url.length === 0) {
  console.error('MUDENGINE_BROWSE_URL is not set, so there is nothing to open.');
  app.exit(2);
}

app.whenReady().then(() => {
  for (let i = 0; i < tabs; i += 1) {
    const window = new BrowserWindow({
      width: 1400,
      height: 900,
      x: 40 * i,
      y: 40 * i,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    void window.loadURL(url);
  }
});

app.on('window-all-closed', () => app.quit());
