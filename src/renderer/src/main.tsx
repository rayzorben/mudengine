import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { t } from './lib/i18n';
import './styles/tokens.css';
import './styles/fonts.css';
import './styles/index.css';
import '@xterm/xterm/css/xterm.css';

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
