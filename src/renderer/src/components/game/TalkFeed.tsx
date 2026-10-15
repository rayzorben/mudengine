/**
 * The game view's talk feed (todo 140): the newest lines said, over the map
 * above the command bar. Each fades after `--dur-game-talk-linger`; a line for
 * this character (`forYou`) stays lit until the Talk panel is opened with `t`.
 * The words are the server's line as printed.
 */
import { memo } from 'react';

import type { Block } from '@shared/blocks';
import { forYou } from '../../lib/gameTalk';
import { t } from '../../lib/i18n';

function TalkFeed({
  lines,
  self,
  unread
}: {
  lines: readonly Block[];
  self: string | null;
  unread: number;
}) {
  if (lines.length === 0) return null;
  return (
    <section aria-label={t('game.talk.feedAria')} className="gv-hud gv-talk-feed">
      {lines.map((block) => (
        <p
          data-channel={block.type}
          data-for-you={forYou(block, self) ? 'true' : undefined}
          key={block.seq}
        >
          {block.text}
        </p>
      ))}
      {unread > 0 && (
        <div className="gv-talk-hint">
          <kbd>t</kbd>{' '}
          {unread === 1 ? t('game.talk.unread.one') : t('game.talk.unread.many', { count: unread })}
        </div>
      )}
    </section>
  );
}

export default memo(TalkFeed);
