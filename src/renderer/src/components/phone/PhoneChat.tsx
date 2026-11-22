/**
 * The Chat tab: what was said, newest at the bottom, in the words the server
 * printed. Sending is the dock's.
 */
import { memo, useLayoutEffect, useMemo, useRef } from 'react';

import type { Block } from '@shared/blocks';
import { isOwnName } from '@shared/players';
import { forYou } from '../../lib/gameTalk';
import { t } from '../../lib/i18n';

function PhoneChat({ talk, self }: { talk: readonly Block[]; self: string | null }) {
  const said = useMemo(() => talk.filter((block) => block.domain === 'conversation'), [talk]);
  const end = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => end.current?.scrollIntoView({ block: 'end' }), [said]);
  return (
    <div aria-label={t('phone.chat.aria')} className="phone-chat" role="log">
      {said.length === 0 && <p className="phone-quiet">{t('phone.chat.empty')}</p>}
      {said.map((block) => (
        <p
          className="phone-glass"
          data-channel={block.type}
          data-for-you={forYou(block, self) ? 'true' : undefined}
          data-mine={isOwnName(self, block.groups['player'] ?? '') ? 'true' : undefined}
          key={block.seq}
        >
          {block.text}
        </p>
      ))}
      <div ref={end} />
    </div>
  );
}

export default memo(PhoneChat);
