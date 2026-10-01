/**
 * The Combat Stats card's `Time` face: MegaMUD's `Time Analysis`, and what
 * each kill cost. It shows where the time in the realm went (fighting,
 * walking, resting, meditating, or none of those) and which part of a kill
 * costs most, for a player working out why the exp rate is low. See `mudengine-ui` ›
 * *The Combat Stats card*.
 */
import { Fragment } from 'react';

import type { CombatTally, Pastime } from '@shared/tally';
import {
  engagedFor,
  mean,
  onlineFor,
  otherTime,
  roundsFought,
  shareOfOnline,
  spentOn,
  swings
} from '@shared/tally';
import type { SessionId } from '@shared/ipc';
import CardTable, { type Column } from './CardTable';
import { t } from '../lib/i18n';
import { duration, figure, percent } from '../lib/stats';
import { tuning } from '../lib/tuning';

type TimeKey = 'attacking' | Pastime | 'other';

interface TimeRow {
  key: TimeKey;
  label: string;
  ms: number;
}

/** The rows in MegaMUD's order. Literal `t()` calls, one per row. */
function timeRows(shown: CombatTally, now: number): TimeRow[] {
  return [
    { key: 'attacking', label: t('cards.stats.attackingLabel'), ms: engagedFor(shown, now) },
    { key: 'moving', label: t('cards.stats.time.moving'), ms: spentOn(shown, 'moving', now) },
    { key: 'resting', label: t('cards.stats.time.resting'), ms: spentOn(shown, 'resting', now) },
    {
      key: 'meditating',
      label: t('cards.stats.time.meditating'),
      ms: spentOn(shown, 'meditating', now)
    },
    { key: 'other', label: t('cards.stats.time.other'), ms: otherTime(shown, now) }
  ];
}

/** A stretch of time shared over the kills, or a dash before the first. */
function perKill(ms: number, kills: number): string {
  return duration(mean(ms, kills));
}

/** The readout under the table: what one kill took, in each of its costs. */
function killRows(
  shown: CombatTally,
  now: number
): { key: string; label: string; value: string }[] {
  const kills = shown.kills;
  const rounds = roundsFought(shown, now, tuning().combatRoundMs);
  return [
    {
      key: 'exp-per-kill',
      label: t('cards.stats.expPerKillLabel'),
      value: figure(mean(shown.experience, kills))
    },
    {
      key: 'kill-every',
      label: t('cards.stats.killEveryLabel'),
      value: perKill(onlineFor(shown, now), kills)
    },
    {
      key: 'rounds-per-kill',
      label: t('cards.stats.roundsPerKillLabel'),
      value: figure(rounds === null ? null : mean(rounds, kills), 1)
    },
    {
      key: 'swings-per-kill',
      label: t('cards.stats.swingsPerKillLabel'),
      value: figure(mean(swings(shown), kills), 1)
    },
    {
      key: 'taken-per-kill',
      label: t('cards.stats.takenPerKillLabel'),
      value: figure(mean(shown.taken.damage, kills), 1)
    }
  ];
}

/** The face's text for the copy menu, read at the same instant as what is drawn. */
export function timeCopyText(shown: CombatTally, now: number): string {
  return [
    ...timeRows(shown, now).map(
      (row) =>
        `${row.label}: ${duration(row.ms)} · ${percent(shareOfOnline(row.ms, shown, now))} · ${perKill(row.ms, shown.kills)}`
    ),
    ...killRows(shown, now).map((row) => `${row.label}: ${row.value}`)
  ].join('\n');
}

export default function TimeFace({
  shown,
  now,
  session
}: {
  shown: CombatTally;
  now: number;
  session: SessionId;
}): React.JSX.Element {
  const rows = timeRows(shown, now);
  const columns: Column<TimeRow>[] = [
    {
      id: 'doing',
      label: t('cards.stats.column.doing'),
      value: (row) => row.label,
      // The swatch is the bar's legend.
      cell: (row) => (
        <>
          <span aria-hidden className="time-swatch" data-time={row.key} />
          {row.label}
        </>
      )
    },
    {
      id: 'time',
      label: t('cards.stats.column.time'),
      numeric: true,
      value: (row) => row.ms,
      cell: (row) => duration(row.ms)
    },
    {
      id: 'share',
      label: t('cards.stats.column.share'),
      numeric: true,
      value: (row) => row.ms,
      cell: (row) => percent(shareOfOnline(row.ms, shown, now))
    },
    {
      id: 'per-kill',
      label: t('cards.stats.column.perKill'),
      numeric: true,
      value: (row) => mean(row.ms, shown.kills) ?? -1,
      cell: (row) => perKill(row.ms, shown.kills)
    }
  ];
  return (
    <>
      {/* The split as one bar, so the largest slice is seen before it is read. */}
      <div aria-hidden className="time-split">
        {rows
          .filter((row) => row.ms > 0)
          .map((row) => (
            <span
              data-time={row.key}
              key={row.key}
              style={{ flexGrow: row.ms }}
              title={row.label}
            />
          ))}
      </div>
      <CardTable
        caption={t('cards.stats.timeCaption')}
        className="stats-table"
        columns={columns}
        empty={t('cards.stats.empty')}
        keyOf={(row) => row.key}
        name="stats-time"
        rows={rows}
        session={session}
      />
      <dl className="readout">
        {killRows(shown, now).map((row) => (
          <Fragment key={row.key}>
            <dt>{row.label}</dt>
            <dd data-row={row.key}>{row.value}</dd>
          </Fragment>
        ))}
      </dl>
    </>
  );
}
