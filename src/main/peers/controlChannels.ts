/**
 * Remote control's channels (todo 20261031-1156-01): a window opens, acts
 * on and closes the character one of its characters controls, and the
 * sharer's window stops whoever controls its own. Each payload is parsed
 * here: an action is read by the same reader the sharer reads it with, so a
 * window cannot send what the contract does not hold.
 */
import { Invoke } from '../../shared/ipc';
import {
  asControlAction,
  CONTROL_VERSION,
  NO_CONTROL_TEXT,
  type ControlAnswer
} from '../../shared/peerControl';
import { isPeerName } from '../../shared/peers';
import { isRecord } from '../../shared/values';
import { t } from '../app/i18n';
import type { Host } from '../host/Host';
import type { Peers } from './wiring';

export interface ControlChannelsDeps {
  host: Pick<Host, 'transport'>;
  /** The sharing client, while there is one. */
  peers(): Peers | null;
}

export function handleControlChannels({ host, peers }: ControlChannelsDeps): void {
  const { transport } = host;
  transport.handle(Invoke.controlOpen, (_caller, session: unknown, name: unknown) => {
    if (typeof session !== 'string' || !isPeerName(name)) return t('peers.control.badName');
    return peers()?.controlOpen(session, name) ?? t('peers.control.notSharing');
  });
  transport.handle(Invoke.controlClose, (_caller, session: unknown) => {
    if (typeof session === 'string') peers()?.controlClose(session);
  });
  transport.handle(
    Invoke.controlAct,
    (_caller, session: unknown, action: unknown): Promise<ControlAnswer> | ControlAnswer => {
      const read = asControlAction(isRecord(action) ? { ...action, v: CONTROL_VERSION } : null);
      if (!read.ok) return { r: 'refused', why: t('peers.control.malformed') };
      const sharing = peers();
      if (typeof session !== 'string' || sharing === null) {
        return { r: 'refused', why: t('peers.control.notControlling') };
      }
      return sharing.controlAct(session, read.action);
    }
  );
  transport.handle(Invoke.controlBacklog, (_caller, session: unknown) =>
    typeof session === 'string'
      ? (peers()?.controlBacklog(session) ?? NO_CONTROL_TEXT)
      : NO_CONTROL_TEXT
  );
  transport.handle(Invoke.controlStop, (_caller, session: unknown) => {
    if (typeof session === 'string') peers()?.controlStop(session);
  });
}
