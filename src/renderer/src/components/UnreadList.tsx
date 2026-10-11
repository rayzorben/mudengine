import { memo, useCallback, useEffect, useState } from 'react';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { SessionId } from '@shared/ipc';
import type { UnreadLine } from '@shared/unread';
import { timeOfDay } from '@shared/values';

export interface UnreadListProps {
  session: SessionId;
  load(session: SessionId): Promise<UnreadLine[]>;
}

/**
 * The lines the parser did not read on this character's realm, by shape and
 * commonest first (todo 73). Asked for on open and on Refresh rather than
 * pushed: it is for finding parser gaps, and nobody reads it at stream rate.
 */
function UnreadList({ session, load }: UnreadListProps) {
  const [lines, setLines] = useState<UnreadLine[] | null>(null);

  const refresh = useCallback(() => {
    void load(session).then(setLines);
  }, [load, session]);

  useEffect(() => {
    let live = true;
    setLines(null);
    void load(session).then((answer) => {
      if (live) setLines(answer);
    });
    return () => {
      live = false;
    };
  }, [load, session]);

  const messages = lines?.filter((line) => line.kind === 'realm-message').length ?? 0;

  return (
    <>
      <div className="debug-status">
        <span>
          {lines === null
            ? t('debug.unread.loading')
            : t('debug.unread.counts', { shapes: lines.length, messages })}
        </span>
        <button className="quiet" onClick={refresh} onMouseDown={keepFocus} type="button">
          {t('debug.unread.refresh')}
        </button>
      </div>
      <div className="debug-log">
        {lines !== null && lines.length === 0 ? (
          <div className="empty">{t('debug.unread.empty')}</div>
        ) : (
          (lines ?? []).map((line) => <UnreadRow key={`${line.kind} ${line.shape}`} line={line} />)
        )}
      </div>
    </>
  );
}

const UnreadRow = memo(function UnreadRow({ line }: { line: UnreadLine }) {
  const where =
    line.room.name ??
    (line.room.map !== null && line.room.number !== null
      ? `${line.room.map}/${line.room.number}`
      : t('debug.unread.roomUnknown'));
  return (
    <div className="debug-row unread-row" data-unread={line.kind}>
      <span className="at">{timeOfDay(line.lastAt)}</span>
      <span className="kind">{line.count}</span>
      <span className="tag">
        {line.message === null
          ? t('debug.unread.unknown')
          : t('debug.unread.message', { number: line.message })}
      </span>
      <span className="what">
        {line.sample}
        <span className="detail">{t('debug.unread.seenIn', { room: where })}</span>
      </span>
    </div>
  );
});

export default memo(UnreadList);
