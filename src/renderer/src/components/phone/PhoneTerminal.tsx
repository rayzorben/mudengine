/**
 * The Terminal tab: the framed lines the server sent, in the colours it chose.
 *
 * The real console stays mounted under the shell at its own width, which a
 * phone cannot give 80 columns; this reads the same stream (`view.lines`, the
 * last `lineLogLimit` of it) and wraps it. Scrolling up holds the place, and
 * it follows the newest line only while it is at the bottom.
 */
import { memo, useLayoutEffect, useMemo, useRef } from 'react';

import type { StreamLine } from '@shared/types';
import { t } from '../../lib/i18n';
import { runsOf } from '../../lib/phone';

/** Within this many pixels of the end counts as being at it. */
const AT_END = 24;

const Line = memo(function Line({ text }: { text: string }) {
  const runs = useMemo(() => runsOf(text), [text]);
  return (
    <p>
      {runs.length === 0
        ? ' '
        : runs.map((run, index) => (
            <span
              data-bold={run.bold ? 'true' : undefined}
              data-tone={run.tone ?? undefined}
              key={index}
            >
              {run.text}
            </span>
          ))}
    </p>
  );
});

function PhoneTerminal({ lines }: { lines: readonly StreamLine[] }) {
  const log = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const node = log.current;
    if (node && following.current) node.scrollTop = node.scrollHeight;
  }, [lines]);
  return (
    <div
      aria-label={t('phone.terminal.aria')}
      className="phone-terminal"
      onScroll={(event) => {
        const node = event.currentTarget;
        following.current = node.scrollHeight - node.scrollTop - node.clientHeight < AT_END;
      }}
      ref={log}
      role="log"
    >
      {lines.length === 0 ? (
        <p className="phone-quiet">{t('phone.terminal.empty')}</p>
      ) : (
        lines.map((line) => <Line key={line.seq} text={line.text} />)
      )}
    </div>
  );
}

export default memo(PhoneTerminal);
