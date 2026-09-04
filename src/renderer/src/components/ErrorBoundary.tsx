/**
 * The renderer's last line: a render error must not cost four characters.
 *
 * `guardTheProcess()` keeps the *main* process up when something throws, but
 * React unmounts the whole tree when a render throws, and an unmounted tree
 * is a white window with every session still silently connected behind it.
 * This boundary is the renderer's half of the same promise: say what broke,
 * say out loud that the characters are still up — they live in main, not
 * here — and offer the redraw. It reports through console.error, which the
 * session log captures.
 *
 * A class component because error boundaries still have no hook equivalent.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { errorMessage } from '@shared/values';
import { t } from '../lib/i18n';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  message: string | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { message: errorMessage(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[render] the renderer tree threw while drawing:', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    return (
      <div className="crash-screen" role="alert">
        <div className="crash-panel">
          <h1>{t('app.errorBoundary.heading')}</h1>
          <p>{t('app.errorBoundary.body')}</p>
          <pre>{this.state.message}</pre>
          <button type="button" onClick={() => window.location.reload()}>
            {t('app.errorBoundary.reload')}
          </button>
        </div>
      </div>
    );
  }
}
