import { memo, useEffect, useRef } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import { t } from '../lib/i18n';
import type { StreamLine } from '@shared/types';

export interface StreamCardProps extends CardChrome {
  lines: StreamLine[];
  /** Under pressure the wash animation is suppressed; see docs/ui-design.md 3.7. */
  quiet: boolean;
}

/**
 * The framed stream, as the parser will see it.
 *
 * Framing is invisible by design — the terminal renders the raw bytes — so
 * without a window onto it there is no way to tell a correct tokenizer from a
 * broken one until Phase 3's parser starts producing nonsense. Each row shows
 * the plain text a parser rule would match against, tagged with what terminated
 * it.
 *
 * The `repaint` tag is the one to watch: it marks the in-place status-line
 * rewrite (`ESC[79D ESC[K`) that this game family uses instead of a newline. If
 * those rows stop appearing, framing has regressed and every downstream block
 * boundary will be wrong.
 */
function StreamCard({ lines, quiet, ...chrome }: StreamCardProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines.length]);

  return (
    <BentoCard
      {...chrome}
      badge={<span className="chip off">{lines.length}</span>}
      bodyRef={bodyRef}
      className="stream-card"
      scroll
      title={t('cards.stream.title')}
    >
      <div className="line-log">
        {lines.length === 0 ? (
          <div className="empty">{t('cards.stream.empty')}</div>
        ) : (
          lines.map((line, index) => (
            <div
              className={[
                'row',
                line.terminator,
                !quiet && index === lines.length - 1 ? 'fresh' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              key={line.seq}
            >
              <span
                className="mark"
                title={t('cards.stream.terminatorTooltip', { terminator: line.terminator })}
              >
                {line.terminator === 'repaint' ? '⏎̸' : line.terminator === 'flush' ? '…' : '⏎'}
              </span>
              {/* An empty line is structural in this game's output — room
                  description, blank, exits — so it gets a visible row. */}
              <span className="text">{line.plain.length > 0 ? line.plain : ' '}</span>
            </div>
          ))
        )}
      </div>
    </BentoCard>
  );
}

export default memo(StreamCard);
