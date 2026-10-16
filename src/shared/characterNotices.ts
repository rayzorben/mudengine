/**
 * Two notices no single block is (todo 80): a level waiting at a trainer, and
 * a telepath to this character. Each has its own alert event, so a row can
 * claim it and sound it (MegaMUD's `[Alerts]` train and telepath sounds).
 */
import type { Block } from './blocks';
import type { CharacterState } from './character';
import { experienceOf } from './experience';
import type { UiLookup } from './i18n';
import { rowAsks, type AlertRule, type Notice } from './notifications';
import { isRemoteTalk } from './remotes';

/**
 * The highest level the experience pays for past the one held, or null when
 * none is waiting or the figures are unread. The table answers where it has
 * the rows; else the realm's own `Exp needed` of 0 says the next one is.
 */
export function levelWaiting(progress: CharacterState['progress']): number | null {
  const { level } = progress;
  if (level === null) return null;
  const { standing } = experienceOf(progress);
  if (standing !== null) return standing.earned > level ? standing.earned : null;
  return progress.expNeeded === 0 ? level + 1 : null;
}

/** Said when the level waiting rises: once per level, never per status line. */
export function levelReadyNotices(
  before: CharacterState,
  after: CharacterState,
  at: number,
  t: UiLookup
): Notice[] {
  const now = levelWaiting(after.progress);
  if (now === null) return [];
  const was = levelWaiting(before.progress);
  if (was !== null && was >= now) return [];
  return [
    {
      id: `level${at}`,
      at,
      severity: 'info',
      channel: 'session',
      event: 'level-ready',
      text: t('cards.alerts.level.ready', { level: now })
    }
  ];
}

/**
 * A player's telepath to this character, in the server's words. Never remote
 * traffic (an `@` command or a reply in braces, `isRemoteTalk`), which is one
 * client talking to another and arrives every few seconds in a party, and
 * never the receipt for one this character sent.
 *
 * Only while an enabled row names `telepath`, the same gate as `namedNotices`:
 * conversation belongs on the Talk card, and `wanted` shows a notice no row
 * claims.
 */
export function telepathNotice(block: Block, rules: readonly AlertRule[]): Notice | null {
  if (block.type !== 'conversation-telepath') return null;
  if (!rowAsks(rules, 'telepath')) return null;
  const message = block.groups['message'];
  if (message === undefined || isRemoteTalk(message)) return null;
  return {
    id: `tele${block.seq}`,
    at: block.at,
    severity: 'info',
    channel: 'presence',
    event: 'telepath',
    text: block.text.trim()
  };
}
