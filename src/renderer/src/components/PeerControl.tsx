/**
 * Remote control over one character's console (todo 20261031-1156-01): the
 * banner its player sees while another player controls it, with Stop, and
 * the remote console while it controls a character shared with it. Both
 * come from main's `ShareView`, so a window that opens or reloads shows
 * what is so now.
 */
import { memo, useCallback } from 'react';

import Icon from './Icon';
import RemoteConsole, { type RemoteConsoleApi } from './RemoteConsole';
import { useShares, type SharesApi } from '../hooks/useShares';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { TerminalConfig } from '@shared/config';
import type { IpcApi, SessionId } from '@shared/ipc';
import type { TerminalPalette } from '@shared/themes';

export type PeerControlApi = SharesApi & RemoteConsoleApi & Pick<IpcApi, 'controlStop'>;

export interface PeerControlProps {
  api: PeerControlApi;
  session: SessionId;
  settings: TerminalConfig;
  fontStack: string;
  palette: TerminalPalette;
}

function PeerControl({ api, session, settings, fontStack, palette }: PeerControlProps) {
  const { controlledBy, controlling } = useShares(api, session);
  const stop = useCallback(() => {
    void api.controlStop(session);
  }, [api, session]);
  return (
    <>
      {controlledBy.length > 0 && (
        <section
          aria-label={t('remote.controlledAria')}
          className="quest-banner peer-banner"
          data-status="stopped"
          role="status"
        >
          <div className="quest-banner-head">
            <Icon name="terminal" size={14} />
            <span className="quest-banner-title">
              {t('remote.controlledBy', { names: controlledBy.join(', ') })}
            </span>
            <button
              className="quest-plan-btn quest-banner-stop"
              onClick={stop}
              onMouseDown={keepFocus}
              title={t('remote.stopControlTitle')}
              type="button"
            >
              {t('remote.stopControl')}
            </button>
          </div>
        </section>
      )}
      {controlling !== null && (
        <RemoteConsole
          api={api}
          fontStack={fontStack}
          name={controlling.name}
          palette={palette}
          session={session}
          settings={settings}
        />
      )}
    </>
  );
}

export default memo(PeerControl);
