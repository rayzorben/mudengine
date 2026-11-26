/**
 * Whether a line another player types into a character it controls is sent
 * (todo 20261031-1156-01). Only a line that logs the character off or
 * deletes it is refused (`logsOffOrDeletes`, the user, 2026-11-03); a line
 * that sends an `@` command on to another character goes through, since
 * sharing a character is sharing its terminal (the user, 2026-11-25). The
 * answer is in the sharer's words.
 */
import { logsOffOrDeletes } from '../../shared/commands';
import { t } from '../app/i18n';

/** Why `line` is not sent; null to send it. */
export function screenLine(line: string): string | null {
  return logsOffOrDeletes(line) ? t('peers.control.leaves', { text: line }) : null;
}
