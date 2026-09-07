import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import Icon from './Icon';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { tuning } from '../lib/tuning';
import type { DebugKind, DebugRecord } from '@shared/debug';
import type { SessionId } from '@shared/ipc';

/**
 * Every kind, in the order a line of the game actually produces them.
 *
 * The order is the argument for the row of chips: it is the pipeline, left to
 * right — bytes arrive, a line is framed out of them, it is classified, the
 * character changes, the client decides something. Somebody muting `in` to see
 * only the classifications is reading down one stage of that, and an
 * alphabetical row would hide the shape they are reading.
 */
const KIND_ORDER: Record<DebugKind, number> = {
  in: 0,
  line: 1,
  block: 2,
  state: 3,
  event: 4,
  out: 5,
  link: 6,
  notice: 7
};

const KIND_LABEL: Record<DebugKind, string> = {
  in: t('debug.kind.in'),
  out: t('debug.kind.out'),
  line: t('debug.kind.line'),
  block: t('debug.kind.block'),
  state: t('debug.kind.state'),
  event: t('debug.kind.event'),
  link: t('debug.kind.link'),
  notice: t('debug.kind.notice')
};

/*
 * Derived from the two records above rather than written out a third time.
 *
 * Both are `Record<DebugKind, …>`, so a ninth kind added to `debug.ts` fails
 * to compile in two places instead of quietly getting no chip and no hue — a
 * kind that can never be muted and can never be found by colour. That is the
 * closed-union rule: the type and the runtime list that walks it move
 * together. The stylesheet is the third half and cannot be type-checked, so
 * `debug-view.test.ts` reads the hues out of it and asserts the same set.
 */
const KINDS: readonly DebugKind[] = (Object.keys(KIND_LABEL) as DebugKind[]).sort(
  (a, b) => KIND_ORDER[a] - KIND_ORDER[b]
);

export interface DebugViewProps {
  /** The character this is a trace of. */
  session: SessionId;
  /** Everything the ring holds, and how much it has already thrown away. */
  load(session: SessionId): Promise<{ records: DebugRecord[]; dropped: number }>;
  /** Subscribes to the live feed; returns the unsubscribe. */
  subscribe(handler: (session: SessionId, record: DebugRecord) => void): () => void;
  /** Writes the bug report and answers with where it went, or why not. */
  save(session: SessionId): Promise<{ path: string } | { error: string }>;
  /** Open the folder the report was written into. */
  reveal(): void;
  onClose(): void;
}

/**
 * What the client is doing, in place of the console.
 *
 * The console shows what a *player* sees; this shows what the *client* sees,
 * which is a different stream and mostly an invisible one: the bytes as they
 * arrived, the line the tokenizer framed out of them, what the classifier made
 * of it, what changed in the character as a result, and what automation decided
 * about that. Until this existed, answering "why did it read that line wrongly"
 * meant replaying a capture through a script.
 *
 * ## It sits over the console rather than replacing it
 *
 * The terminal stays mounted and laid out underneath, and this is drawn on top
 * of it. Unmounting the terminal would rebuild its scrollback and its parser
 * state, and *resizing* it would go out over NAWS and re-wrap a scrollback
 * nobody asked to re-wrap — which is the same reason the docked strips overlay
 * the console instead of taking rows from it.
 *
 * ## The records arrive faster than the window can render them
 *
 * Several per line of the game, and a line is not slow. So they land in a ref
 * and flush on a fixed tick, which is `useStreamPressure`'s rule applied one
 * feed along: a burst costs one render rather than one render per record. The
 * subscription lives here rather than in the root, so nothing outside this
 * view re-renders for a feed only this view reads — and the history comes from
 * one fetch on open, because main records whether or not anybody is watching.
 */
function DebugView({ session, load, subscribe, save, reveal, onClose }: DebugViewProps) {
  const [records, setRecords] = useState<DebugRecord[]>([]);
  const [dropped, setDropped] = useState(0);
  const [muted, setMuted] = useState<ReadonlySet<DebugKind>>(new Set());
  const [query, setQuery] = useState('');
  const [saved, setSaved] = useState<{ path: string } | { error: string } | null>(null);
  /** Pinned to the tail until somebody scrolls back, like the console. */
  const [following, setFollowing] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  /*
   * The history, then the live feed. In that order and in one effect, because
   * the fetch is a snapshot of a *growing* ring: a record pushed while the
   * fetch was in the air must not be dropped by the answer landing on top of
   * it. Merged on `seq`, which is monotonic within a session — the same seam
   * the framed-line catch-up already guards.
   */
  const pending = useRef<DebugRecord[]>([]);
  useEffect(() => {
    let live = true;
    pending.current = [];
    setRecords([]);
    setDropped(0);
    const stop = subscribe((sid, record) => {
      if (sid !== session) return;
      pending.current.push(record);
    });
    /*
     * A macrotask after mount, not during it.
     *
     * The root turns the feed on (`api.diagnostics(true)`) from *its* effect,
     * which React runs after this child's — so a fetch issued here directly
     * would be handled by main before the feed was on, and anything the socket
     * produced between the two handlers would be in neither the snapshot nor
     * the pushes. Every effect in a commit runs in one task, so yielding once
     * puts this strictly after the root's.
     */
    const fetch = window.setTimeout(() => {
      void load(session).then((answer) => {
        if (!live) return;
        setDropped(answer.dropped);
        setRecords((held) => {
          const newest = answer.records[answer.records.length - 1];
          if (!newest) return held;
          const tail = held.filter((record) => record.seq > newest.seq);
          // Bounded here too. Main's ring and this window's row cap are two
          // different keys on purpose, and the fetch is the one path that could
          // otherwise put the whole of the larger one into the DOM at once.
          return [...answer.records, ...tail].slice(-tuning().debugRows);
        });
      });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(fetch);
      stop();
    };
  }, [load, session, subscribe]);

  useEffect(() => {
    const limit = tuning().debugRows;
    const timer = window.setInterval(() => {
      if (pending.current.length === 0) return;
      const arrived = pending.current;
      pending.current = [];
      setRecords((held) => {
        const newest = held[held.length - 1];
        const fresh =
          newest === undefined ? arrived : arrived.filter((record) => record.seq > newest.seq);
        return fresh.length === 0 ? held : [...held, ...fresh].slice(-limit);
      });
    }, tuning().chromeFlushMs);
    return () => window.clearInterval(timer);
  }, []);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return records.filter((record) => {
      if (muted.has(record.kind)) return false;
      if (needle.length === 0) return true;
      return (
        record.text.toLowerCase().includes(needle) ||
        record.tag.toLowerCase().includes(needle) ||
        (record.detail ?? '').toLowerCase().includes(needle)
      );
    });
  }, [muted, query, records]);

  /*
   * Follow the tail, and stop following the moment somebody scrolls back —
   * the console's own rule. A view that snapped back to the newest record
   * while somebody was reading the one that caused the bug would be unusable
   * for the one thing it is for.
   */
  useEffect(() => {
    const node = scroller.current;
    if (node && following) node.scrollTop = node.scrollHeight;
  }, [shown, following]);

  const onScroll = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    // A few pixels of slack: a tail that only counts as followed at exactly
    // zero is one that stops following on a fractional scroll position.
    setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 8);
  }, []);

  const toggle = useCallback((kind: DebugKind) => {
    setMuted((held) => {
      const next = new Set(held);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const write = useCallback(() => {
    setSaved(null);
    void save(session).then(setSaved);
  }, [save, session]);

  const hidden = records.length - shown.length;

  return (
    <div className="surface debug-view" role="region" aria-label={t('debug.ariaLabel')}>
      <header className="debug-head">
        <h2>{t('debug.title')}</h2>
        {/*
          Every kind is a chip, present whether or not anything of that kind has
          arrived — the map legend's rule. A row that gained a chip the first
          time a rule fired would change width while somebody was reading it,
          and the absence of a kind is itself a fact worth being able to see.
        */}
        <div className="debug-kinds" role="group" aria-label={t('debug.kindsAria')}>
          {KINDS.map((kind) => (
            <button
              aria-pressed={!muted.has(kind)}
              className={`chip debug-kind${muted.has(kind) ? ' off' : ''}`}
              data-kind={kind}
              key={kind}
              onClick={() => toggle(kind)}
              onMouseDown={keepFocus}
              type="button"
            >
              {KIND_LABEL[kind]}
            </button>
          ))}
        </div>
        <input
          className="debug-find"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Escape means done *once*: it clears the query and hands the caret
            // back in one press, exactly as a card's find field does.
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setQuery('');
            event.currentTarget.blur();
          }}
          placeholder={t('debug.findPlaceholder')}
          type="search"
          value={query}
        />
        <button
          className="card-action"
          onClick={write}
          onMouseDown={keepFocus}
          title={t('debug.saveTooltip')}
          type="button"
        >
          <Icon name="fileText" />
          <span className="sr-only">{t('debug.saveTooltip')}</span>
        </button>
        <button
          aria-label={t('cards.chrome.close')}
          className="card-action card-close"
          onClick={onClose}
          onMouseDown={keepFocus}
          title={t('cards.chrome.close')}
          type="button"
        >
          <Icon name="close" />
        </button>
      </header>

      {/*
        What is not on screen, and how to get it back. The same rule a narrowed
        table follows: a filtered view that does not say it is filtered is a
        view lying about what happened, which here is worse than on a card —
        somebody reading this is trying to find out what happened.
      */}
      <div className="debug-status">
        <span>
          {t('debug.counts', { shown: shown.length, total: records.length })}
          {dropped > 0 ? ` · ${t('debug.dropped', { count: dropped })}` : ''}
        </span>
        {hidden > 0 && (
          <button
            className="quiet"
            onClick={() => {
              setMuted(new Set());
              setQuery('');
            }}
            onMouseDown={keepFocus}
            type="button"
          >
            {t('debug.showAll')}
          </button>
        )}
        {!following && (
          <button
            className="quiet"
            onClick={() => setFollowing(true)}
            onMouseDown={keepFocus}
            type="button"
          >
            {t('debug.follow')}
          </button>
        )}
        {saved !== null && (
          <span className={'path' in saved ? 'debug-saved' : 'debug-failed'}>
            {'path' in saved ? (
              <>
                {t('debug.savedTo', { path: saved.path })}{' '}
                <button className="quiet" onClick={reveal} onMouseDown={keepFocus} type="button">
                  {t('debug.revealReport')}
                </button>
              </>
            ) : (
              t('debug.saveFailed', { error: saved.error })
            )}
          </span>
        )}
      </div>

      <div className="debug-log" onScroll={onScroll} ref={scroller}>
        {shown.length === 0 ? (
          <div className="empty">
            {records.length === 0 ? t('debug.emptyNothingYet') : t('debug.emptyAllFiltered')}
          </div>
        ) : (
          shown.map((record) => <DebugRow key={record.seq} record={record} />)
        )}
      </div>
    </div>
  );
}

/**
 * One record.
 *
 * Memoised on the record, which never changes once it exists — so a flush that
 * appends five rows re-renders five rows and not four thousand. That is the
 * Talk card's `TalkLine` rule, and this feed is an order of magnitude denser
 * than that one.
 */
const DebugRow = memo(function DebugRow({ record }: { record: DebugRecord }) {
  const at = new Date(record.at);
  const stamp = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:${String(at.getSeconds()).padStart(2, '0')}.${String(at.getMilliseconds()).padStart(3, '0')}`;
  return (
    <div className="debug-row" data-kind={record.kind}>
      <span className="at">{stamp}</span>
      <span className="kind">{record.kind}</span>
      <span className="tag">{record.tag}</span>
      <span className="what">
        {record.text}
        {record.detail !== undefined && <span className="detail">{record.detail}</span>}
      </span>
    </div>
  );
});

export default memo(DebugView);
