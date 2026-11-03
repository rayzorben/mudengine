/**
 * Remote control of a character another player shares with this one (todo
 * 20261031-1156-01), over this character's console: that character's
 * terminal text as its own client painted it, a line to send, and the fixed
 * list of actions both builds understand (`peerControl.ts`). Nothing here
 * reaches the other client's settings, loops or cards. Each refusal is
 * written into the console in the sharer's words. The console is read only:
 * a key typed into it goes nowhere, and the line below is what is sent.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import Icon from './Icon';
import TerminalView, { type TerminalHandle } from './TerminalView';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { TerminalConfig } from '@shared/config';
import type { IpcApi, SessionId } from '@shared/ipc';
import type { ControlAction, ControlAnswer } from '@shared/peerControl';
import type { TerminalPalette } from '@shared/themes';
import { errorMessage } from '@shared/values';
import { DIRECTIONS } from '@shared/world';

export type RemoteConsoleApi = Pick<
  IpcApi,
  'controlAct' | 'controlBacklog' | 'controlClose' | 'onControlText'
>;

export interface RemoteConsoleProps {
  api: RemoteConsoleApi;
  session: SessionId;
  /** The character being controlled. */
  name: string;
  settings: TerminalConfig;
  fontStack: string;
  palette: TerminalPalette;
}

const NO_INPUT = (): void => {};
const NO_RESULT = (): void => {};

function RemoteConsole({ api, session, name, settings, fontStack, palette }: RemoteConsoleProps) {
  const handle = useRef<TerminalHandle | null>(null);
  const seq = useRef(0);
  // Pieces that come before the backlog is written wait here, so none is drawn twice or above older text.
  const held = useRef<string[] | null>([]);
  const [line, setLine] = useState('');
  const [confirm, setConfirm] = useState<Extract<ControlAnswer, { r: 'confirm' }> | null>(null);

  const write = useCallback((text: string) => {
    seq.current += 1;
    handle.current?.write({ seq: seq.current, at: Date.now(), text });
  }, []);

  // The text kept so far, then each piece as it comes.
  const ready = useCallback(
    (terminal: TerminalHandle) => {
      handle.current = terminal;
      const release = (backlog: string): void => {
        const waiting = held.current ?? [];
        held.current = null;
        // What came while main answered is already in the backlog it answered with, or after it.
        const joined = waiting.join('');
        write(joined.length > 0 && backlog.endsWith(joined) ? backlog : backlog + joined);
      };
      api.controlBacklog(session).then(release, (error: unknown) => {
        release('');
        terminal.notice(t('remote.failed', { message: errorMessage(error) }));
      });
    },
    [api, session, write]
  );
  useEffect(
    () =>
      api.onControlText(({ session: from, payload }) => {
        if (from !== session) return;
        if (held.current !== null) held.current.push(payload);
        else write(payload);
      }),
    [api, session, write]
  );

  const act = useCallback(
    (action: ControlAction) => {
      setConfirm(null);
      api.controlAct(session, action).then(
        (answer) => {
          if (answer.r === 'refused')
            handle.current?.notice(t('remote.refused', { why: answer.why }));
          if (answer.r === 'confirm') setConfirm(answer);
        },
        (error: unknown) =>
          handle.current?.notice(t('remote.failed', { message: errorMessage(error) }))
      );
    },
    [api, session]
  );
  const close = useCallback(() => {
    void api.controlClose(session);
  }, [api, session]);

  const button = (label: string, action: ControlAction, key = label): React.JSX.Element => (
    <button
      className="quiet"
      key={key}
      onClick={() => act(action)}
      onMouseDown={keepFocus}
      type="button"
    >
      {label}
    </button>
  );

  return (
    <section aria-label={t('remote.aria', { name })} className="remote-console">
      <div className="remote-console-head">
        <Icon name="terminal" size={14} />
        <span className="remote-console-title">{t('remote.title', { name })}</span>
        <button
          aria-label={t('remote.close')}
          className="quiet quest-banner-dismiss"
          onClick={close}
          onMouseDown={keepFocus}
          title={t('remote.close')}
          type="button"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="remote-console-screen">
        <TerminalView
          fontStack={fontStack}
          onInput={NO_INPUT}
          onLostEnter={NO_INPUT}
          onReady={ready}
          onResize={NO_INPUT}
          onSearchResult={NO_RESULT}
          palette={palette}
          reportSize={false}
          scrollback={settings.scrollback}
          settings={settings}
          timestamps={false}
        />
      </div>
      <form
        className="remote-console-line"
        onSubmit={(event) => {
          event.preventDefault();
          const text = line.trim();
          if (text.length === 0) return;
          act({ a: 'line', text });
          setLine('');
        }}
      >
        <input
          aria-label={t('remote.line')}
          onChange={(event) => setLine(event.target.value)}
          placeholder={t('remote.linePlaceholder', { name })}
          type="text"
          value={line}
        />
        <button className="quiet" type="submit">
          {t('remote.send')}
        </button>
      </form>
      <div className="remote-console-actions">
        {DIRECTIONS.map((dir) => button(dir, { a: 'move', dir }))}
        {button(t('remote.rest'), { a: 'rest' })}
        {button(t('remote.stop'), { a: 'stop' })}
        {button(t('remote.play'), { a: 'play', loop: null, confirmed: null })}
        {button(t('remote.combatOn'), { a: 'switch', name: 'combat', on: true })}
        {button(t('remote.combatOff'), { a: 'switch', name: 'combat', on: false })}
        {button(t('remote.automationOn'), { a: 'switch', name: 'automation', on: true })}
        {button(t('remote.automationOff'), { a: 'switch', name: 'automation', on: false })}
      </div>
      {confirm !== null && (
        <div className="remote-console-confirm settings-control-row" role="status">
          <span>{t('remote.confirm', { name: confirm.name, steps: confirm.steps })}</span>
          {button(t('remote.walkOn'), { a: 'play', loop: null, confirmed: confirm.steps })}
        </div>
      )}
    </section>
  );
}

export default memo(RemoteConsole);
