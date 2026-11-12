/**
 * Whether a line another player types into a character it controls is sent
 * (todo 20261031-1156-01). A line that logs the character off or deletes it
 * is refused (`logsOffOrDeletes`, the user, 2026-11-03), and so is one that
 * would pass an `@` command on to another character, as a `@do`'s is
 * (`ChainedRemote`, which says and writes down its own refusal). Every answer
 * is in the sharer's words.
 */
import { logsOffOrDeletes } from '../../shared/commands';
import { t } from '../app/i18n';
import { refusedChain, type ChainedRemoteEvents } from '../automation/ChainedRemote';

/** Why `line`, typed by `by`, is not sent; null to send it. */
export function screenLine(line: string, by: string, reports: ChainedRemoteEvents): string | null {
  if (logsOffOrDeletes(line)) return t('peers.control.leaves', { text: line });
  if (refusedChain(by, line, reports, 'remote-control'))
    return t('automation.remotes.chainedReason');
  return null;
}
