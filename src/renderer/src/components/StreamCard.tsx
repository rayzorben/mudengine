import { memo, useEffect, useMemo, useRef } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import Columns from './viz/Columns';
import SplitBar, { type SplitPart } from './viz/SplitBar';
import { clock } from '../lib/clock';
import { t } from '../lib/i18n';
import type { StreamLine } from '@shared/types';

export interface StreamCardProps extends CardChrome {
  lines: StreamLine[];
  /** Under pressure the wash animation is suppressed; see docs/ui-design.md 3.7. */
  quiet: boolean;
}

/** How many columns the large card draws the backlog's pace in. */
const PACE_BUCKETS = 30;

/**
 * The framed stream, as the parser will see it.
 *
 * Framing is invisible by design — the terminal renders the raw bytes — so
 * without a window onto it there is no way to tell a correct tokenizer from a
 * broken one until the parser starts producing nonsense. Each row shows the
 * plain text a parser rule would match against, tagged with what terminated it.
 *
 * The `repaint` tag is the one to watch: it marks the in-place status-line
 * rewrite (`ESC[79D ESC[K`) that this game family uses instead of a newline. If
 * those rows stop appearing, framing has regressed and every downstream block
 * boundary will be wrong. So the head of the card is the share of each ending,
 * where a missing repaint is a missing colour.
 */
function StreamCard({ lines, quiet, ...chrome }: StreamCardProps) {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines.length]);

  const { kinds, pace } = useMemo(() => {
    let text = 0;
    let blank = 0;
    let repaint = 0;
    let flush = 0;
    const first = lines[0]?.at ?? 0;
    const span = Math.max(1, (lines[lines.length - 1]?.at ?? 0) - first);
    const buckets = new Array<number>(PACE_BUCKETS).fill(0);
    for (const line of lines) {
      if (line.terminator === 'repaint') repaint += 1;
      else if (line.terminator === 'flush') flush += 1;
      else if (line.plain.length === 0) blank += 1;
      else text += 1;
      const at = Math.min(PACE_BUCKETS - 1, Math.floor(((line.at - first) / span) * PACE_BUCKETS));
      buckets[at] = (buckets[at] ?? 0) + 1;
    }
    const parts: SplitPart[] = [
      { key: 'text', label: t('cards.stream.kinds.text'), value: text, tone: 'accent' },
      { key: 'blank', label: t('cards.stream.kinds.blank'), value: blank, tone: 'quiet' },
      { key: 'repaint', label: t('cards.stream.kinds.repaint'), value: repaint, tone: 'warn' },
      { key: 'flush', label: t('cards.stream.kinds.flush'), value: flush, tone: 'd' }
    ];
    return { kinds: parts, pace: buckets };
  }, [lines]);

  return (
    <BentoCard
      {...chrome}
      badge={<span className="chip off">{lines.length}</span>}
      className="stream-card"
      paned
      title={t('cards.stream.title')}
    >
      {lines.length > 0 && (
        <div className="stream-head">
          <SplitBar label={t('cards.stream.kindsAria')} parts={kinds} />
          {/* Large, how the backlog arrived: bursts are rooms and fights, gaps are quiet. */}
          <div className="stream-pace from-large">
            <Columns label={t('cards.stream.paceAria')} values={pace} />
          </div>
        </div>
      )}
      <div className="line-log scroller" ref={logRef}>
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
              <span className="at from-large">{clock(line.at)}</span>
              <span
                className="mark from-medium"
                title={t('cards.stream.terminatorTooltip', { terminator: line.terminator })}
              >
                {line.terminator === 'repaint' ? '⏎̸' : line.terminator === 'flush' ? '…' : '⏎'}
              </span>
              {/* An empty line is structural in this game's output — room
                  description, blank, exits — so it gets a visible row. */}
              <span className="text">{line.plain.length > 0 ? line.plain : ' '}</span>
            </div>
          ))
        )}
      </div>
    </BentoCard>
  );
}

export default memo(StreamCard);
