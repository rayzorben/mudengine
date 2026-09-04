import { memo, useEffect, useRef } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import CardTable, { type Column, type Facet } from './CardTable';
import NamedText from './NamedText';
import { t } from '../lib/i18n';
import type { NameIndex } from '../lib/names';
import type { PopoverAnchor } from '../lib/popover';
import type { CharacterState } from '@shared/character';
import type { SessionId } from '@shared/ipc';
import { SEVERITIES, type Notice, type Severity } from '@shared/notifications';

export interface NotificationsCardProps extends CardChrome {
  /** Notices for this character, oldest first. */
  notices: Notice[];
  /** Which character's card this is, so its filters are remembered per character. */
  session: SessionId;
  /** The console's name index for this character, so the names in a line are controls. */
  names?: NameIndex | null;
  character?: CharacterState;
  inspect?(name: string, anchor: HTMLElement): void;
  onSelect?(name: string, anchor: PopoverAnchor): void;
}

/** The word each level is announced by, so the hue is never the only statement. */
const LABEL: Record<Severity, string> = {
  critical: t('cards.alerts.severity.critical'),
  warning: t('cards.alerts.severity.warning'),
  info: t('cards.alerts.severity.info')
};

/**
 * The levels, as the table's one filtering dimension.
 *
 * These were the card's own chips before the table existed, and they are the
 * same control doing the same thing — so they are the table's facets now rather
 * than a second row of toggles above it. The storage name is kept (`alerts`,
 * giving `alerts-muted`), because somebody who muted `info` a month ago said so
 * once and should not be asked again by a refactor.
 */
const LEVELS: readonly Facet[] = SEVERITIES.map((severity) => ({
  id: severity,
  label: LABEL[severity],
  level: severity
}));

/** How each level is ranked, so sorting by it puts the loudest at one end. */
const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** `hh:mm:ss`, because the record is read against when something happened. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

/**
 * What has just happened that is worth knowing.
 *
 * The terminal carries all of it and that is exactly the problem: the line that
 * mattered is three screens up behind a combat burst, and the moment you need
 * it is the moment you cannot go and find it. This keeps the same facts,
 * ranked, and lets a player say which ranks they want to see.
 *
 * Filtering is per level and remembered for the session. Nothing here is sent
 * and nothing is re-requested — it reads the block feed every other consumer
 * reads, exactly as the Talk card does.
 *
 * The level is in **words as well as hue**, per §6 of the design language: a
 * client that says "this one is urgent" only by turning something red says it
 * to some of its users and not to others.
 */
function NotificationsCard({
  notices,
  session,
  names = null,
  character,
  inspect,
  onSelect,
  ...card
}: NotificationsCardProps) {
  const logRef = useRef<HTMLDivElement>(null);

  const counts = { critical: 0, warning: 0, info: 0 };
  for (const notice of notices) counts[notice.severity] += 1;

  /*
   * The badge reports the loudest thing outstanding, not a total.
   *
   * "3 critical" is a number someone acts on; "212" is a number they stop
   * reading. Nothing here clears itself — a notice that disappears on its own
   * is one nobody can go back to, which is the failure this card exists to fix.
   */
  const badge =
    counts.critical > 0 ? (
      <span className="chip bad">
        {t('cards.alerts.badge.critical', { count: counts.critical })}
      </span>
    ) : counts.warning > 0 ? (
      <span className="chip warn">
        {t('cards.alerts.badge.warning', { count: counts.warning })}
      </span>
    ) : (
      <span className="chip off">{t('cards.alerts.badge.kept', { count: notices.length })}</span>
    );

  /*
   * Pinned to the newest, like the terminal it draws from — and it is the
   * *table* that scrolls, not the card. The filters and the find field are how
   * you cut a busy feed down to what you can act on, and tools that scroll away
   * are reached for exactly when they cannot be.
   */
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [notices.length]);

  const columns: Column<Notice>[] = [
    {
      /*
       * When it happened. The record is read hours later, and roughly-when is
       * how a line is found again — nobody remembers the level it printed at.
       */
      id: 'at',
      label: t('cards.alerts.columns.when'),
      value: (notice) => clock(notice.at)
    },
    {
      id: 'level',
      label: t('cards.vitals.labels.level'),
      // Ranked, not alphabetical: `critical` before `warning` before `info` is
      // the order this card is read in, and A-to-Z would put `critical`
      // between them.
      value: (notice) => RANK[notice.severity],
      cell: (notice) => <span className="alert-level">{LABEL[notice.severity]}</span>
    },
    {
      id: 'channel',
      label: t('cards.alerts.columns.channel'),
      value: (notice) => notice.channel,
      cell: (notice) => <span className="alert-channel">{notice.channel}</span>
    },
    {
      /*
       * What happened, in the words the notice was made with — and the one
       * column that wraps, because this is a sentence rather than a field. A
       * table exists to line figures up; it must not cut prose into a column
       * too narrow to read.
       */
      id: 'text',
      label: t('cards.alerts.columns.whatHappened'),
      wide: true,
      value: (notice) => notice.text,
      // An alert quotes the server's sentence, and the names in it are the
      // same names the console makes controls of; the wrapping span keeps the
      // text readable as one run for copy and for the harness.
      cell: (notice) => (
        <span className="alert-text">
          {names && character && inspect && onSelect ? (
            <NamedText
              character={character}
              index={names}
              inspect={inspect}
              onSelect={onSelect}
              text={notice.text}
            />
          ) : (
            notice.text
          )}
        </span>
      )
    }
  ];

  return (
    <BentoCard {...card} badge={badge} className="alert-card" paned title={t('cards.alerts.title')}>
      {/*
        Finding one, as well as filtering to a level: "what was that room called"
        is asked of the record hours later, and the level of the line it was on
        is not something anybody remembers.
      */}
      <CardTable
        caption={t('cards.alerts.tableCaption')}
        className="alert-list"
        columns={columns}
        empty={t('cards.alerts.empty')}
        facetOf={(notice) => notice.severity}
        facets={LEVELS}
        find={t('cards.alerts.find')}
        keyOf={(notice) => notice.id}
        name="alerts"
        returnFocus={card.returnFocus}
        rowAttrs={(notice) => ({ 'data-level': notice.severity })}
        rows={notices}
        scrollerRef={logRef}
        session={session}
      />
    </BentoCard>
  );
}

export default memo(NotificationsCard);
