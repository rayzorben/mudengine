/**
 * Remote control's channels (todo 20261031-1156-01): a window opens a
 * character one of its characters is given control of as a session here, or
 * closes it, and the sharer's window stops whoever controls its own. Every
 * other call about a controlled character is relayed (`relayTransport`).
 */
import { Invoke } from '../../shared/ipc';
import { isPeerName } from '../../shared/peers';
import { t } from '../app/i18n';
import type { Host } from '../host/Host';
import type { Peers } from './wiring';
import { handleSharedSettings, type SharedSettingsEditor } from './sharedSettings';

export interface ControlChannelsDeps {
  host: Pick<Host, 'transport'>;
  /** The sharing client, while there is one. */
  peers(): Peers | null;
  /** The settings editor, for the settings of a character another player controls. */
  editor(): SharedSettingsEditor;
}

export function handleControlChannels({ host, peers, editor }: ControlChannelsDeps): void {
  handleSharedSettings({ host, editor });
  const { transport } = host;
  transport.handle(Invoke.controlOpen, (_caller, session: unknown, name: unknown) => {
    if (typeof session !== 'string' || !isPeerName(name)) return t('peers.control.badName');
    return peers()?.controlOpen(session, name) ?? t('peers.control.notSharing');
  });
  transport.handle(Invoke.controlClose, (_caller, session: unknown) => {
    if (typeof session === 'string') peers()?.controlClose(session);
  });
  transport.handle(Invoke.controlStop, (_caller, session: unknown) => {
    if (typeof session === 'string') peers()?.controlStop(session);
  });
}
