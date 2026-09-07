import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import type { IpcApi } from '@shared/ipc';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { t } from './lib/i18n';
import { createWebBridge } from './lib/webBridge';
import './styles/tokens.css';
import './styles/fonts.css';
import './styles/index.css';
import '@xterm/xterm/css/xterm.css';

/*
 * The bridge. On the desktop the preload has already put `window.mudengine`
 * there, before any script ran. In a browser tab nothing has — the page came
 * over HTTP with no preload — so the same contract is put there over a
 * WebSocket (`lib/webBridge.ts`), and everything below reads it the same way.
 * Decided by presence rather than by a flag, because presence is the fact —
 * and by the page having come over HTTP, because a desktop window whose
 * preload failed to run has no socket to open and would otherwise die
 * constructing one here, outside the boundary that would have said so.
 */
const bridged = (window as { mudengine?: IpcApi }).mudengine;
if (bridged === undefined) {
  if (/^https?:$/.test(location.protocol)) window.mudengine = createWebBridge();
  else throw new Error('The preload did not run, so this window has no bridge to main.');
}

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing from index.html');

// index.html carries the literal title as the pre-boot fallback; the dictionary owns it from here.
document.title = t('app.windowTitle');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
