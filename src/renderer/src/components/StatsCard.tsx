import { memo, useCallback, type ReactNode } from 'react';

import BentoCard, { type CardChrome, type CardTab } from './BentoCard';
import { useRememberedChoice } from '../hooks/useRemembered';
import CardTable, { type Column } from './CardTable';
import type { CharacterState } from '@shared/character';
import { experienceOwed, experienceStanding } from '@shared/experience';
import {
  BLOW_KINDS,
  DEFAULT_STATS_GRAPH,
  DEFAULT_STATS_HOURS,
  damageDealt,
  engagedFor,
  engagedShare,
  hitsDealt,
  mean,
  perRound,
  onlineFor,
  ratePerHour,
  rateSeries,
  share,
  sinceBaseline,
  swings,
  turnedAside,
  type BlowKind,
  type BlowTally,
  type CombatTally,
  type AwaySpell,
  type ExperienceSample,
  type StatsGraph
} from '@shared/tally';
import type { SessionId } from '@shared/ipc';
import { t } from '../lib/i18n';
import { tuning } from '../lib/tuning';

export interface StatsCardProps extends CardChrome {
  character: CharacterState;
  /** Which character's card this is, for its table to remember its own sort. */
  session: SessionId;
  /**
   * The reading every figure is a difference from, or null for the whole
   * session. Owned by `App` rather than by this card — see `onReset`.
   */
  baseline: CombatTally | null;
  /** Re-base to the totals as they stand now. */
  onReset(): void;
}

/** A figure the realm has not made yet reads as a dash, never as zero. */
function figure(value: number | null, digits = 0): string {
  return value === null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

/** A share as a percentage, or a dash. `share` already returns null for 0/0. */
function percent(value: number | null): string {
  return value === null ? '—' : t('cards.stats.percent', { value: (value * 100).toFixed(1) });
}

/**
 * A rate an hour, in the unit that keeps it readable.
 *
 * MegaMUD switched between `k/hr` and `m/hr` for the same reason: six figures
 * of experience per hour is a number nobody reads at a glance, and the card is
 * three inches wide.
 */
function rate(value: number | null): string {
  if (value === null) return '—';
  const size = Math.abs(value);
  if (size >= 1_000_000)
    return t('cards.stats.ratePerHour', { value: `${(value / 1_000_000).toFixed(2)}M` });
  if (size >= 1_000)
    return t('cards.stats.ratePerHour', { value: `${(value / 1_000).toFixed(1)}k` });
  return t('cards.stats.ratePerHour', { value: value.toFixed(0) });
}

/** `12 – 48`, or a dash while nothing has landed. */
function span(blows: BlowTally): string {
  if (blows.least === null || blows.most === null) return '—';
  return blows.least === blows.most
    ? String(blows.least)
    : t('cards.stats.span', { least: blows.least, most: blows.most });
}

/**
 * A stretch of time on the clock, `h:mm:ss` — MegaMUD's own `Duration:` shape.
 *
 * It was `3m` / `51s`, and the badge these go in is uppercased, so a three
 * minute count read `3M`. One unbroken format also means the badge and the
 * Attacking row cannot disagree about what counts as a long time.
 */
function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${Math.floor(total / 3600)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

/** A quiet `avg 4.4`, or nothing where nothing has landed. */
function average(damage: number, hits: number): string | null {
  const value = mean(damage, hits);
  return value === null ? null : t('cards.stats.avg', { mean: figure(value, 1) });
}

/**
 * How long the experience still owed will take at the rate being made.
 *
 * MegaMUD's `Will level in`, and the two halves it needs are the two this card
 * already draws. Null the moment either is missing or the rate is not positive:
 * a character making no experience never levels, and `∞` is not a time.
 */
function levelIn(needed: number | null, perHour: number | null): number | null {
  if (needed === null || perHour === null || perHour <= 0) return null;
  return (needed / perHour) * 3_600_000;
}

/** One row of the accuracy table: a kind of blow, or the summary under them. */
interface Row {
  key: string;
  label: string;
  hits: number;
  /** Null where the wire cannot say how many attempts a kind took. See below. */
  accuracy: number | null;
  blows: BlowTally;
}

/*
 * MegaMUD's own words for the rows of its accuracy box — `Crit:`, `Cast:`,
 * `Miss:` — read out of `MegaRes.dll`, because the point of this card is that
 * somebody coming from that client recognises it without translating. `BS:` is
 * the one spelled out: the realm's own command table calls it `Backstab`, and
 * `docs/terminology.md` puts the realm's word above MegaMUD's.
 */
const KIND_LABEL: Record<BlowKind, string> = {
  melee: t('cards.stats.kind.melee'),
  critical: t('cards.stats.kind.crit'),
  backstab: t('cards.stats.kind.backstab'),
  spell: t('cards.stats.kind.cast'),
  proc: t('cards.stats.kind.proc')
};

/**
 * How this character has been fighting, added up.
 *
 * The MegaMUD Stats window's question, answered from the stream — and after
 * 2026-09-02 it answers rather more of it, because the objection that had kept
 * four of its rows out dissolved. The old reasoning was *a row that would be a
 * confident zero for every character on this realm is worse than no row*. It
 * still holds; what changed is that **a row is now drawn only once the thing it
 * counts has happened**, so a class that cannot cast, backstab or sneak never
 * sees those rows at all and the rows can exist for the classes that can.
 *
 * Three of MegaMUD's rows came in on that reasoning, each with a wire frame
 * behind it rather than an inference:
 *
 * - **`BS`** — `You surprise <verb> <target> for N damage!`, five captures
 *   (001, 008, 009, 011, 013, 022), every one of them following a typed `bs`.
 *   This file used to say no frame for it existed in the corpus. It did; the
 *   claim had never been checked against a grep.
 * - **`Dodge`** — `but you dodge!` and its three variants, 362 lines. They were
 *   all being counted as unexplained turns, which threw away the one thing
 *   about them that is a fact about the *character*.
 * - **`Sneak`** — `Attempting to sneak...`, with the refusal glued to the
 *   attempt on the failures, so both halves of a real success rate are on the
 *   wire.
 *
 * What is still deliberately **not** here:
 *
 * - **No proc, off-hand, Pre / Main / Aux / Multi row.** Those are names
 *   MegaMUD gave to *its own* attack script's rungs, not things the server
 *   says. The wire says a spell landed and for how much, and that is one row.
 * - **"Deflected", not "dodged", for the rest.** The server prints `The
 *   lashworm lunges at you!` and says nothing about why it did no damage.
 *   Calling *that* a dodge would be a claim read off a sentence that makes
 *   none — which is exactly why the dodges it does state are counted apart.
 * - **One time figure, not four.** The server announces engagement and
 *   announces nothing that could add up resting, walking or idling the same
 *   way. `Attacking 41%` is true; a pie of four slices where three were
 *   guessed is not.
 * - **No coin banked or sold, and no item count.** MegaMUD's `Deposit/Sold`
 *   and `Stashed` are totals of what *it* did, and this client is not the only
 *   thing spending a purse. Its `Items` column has no frame at all: the server
 *   confirms a coin pick-up (`You picked up 17 copper farthings`) and says
 *   **nothing** when an item is taken — grepped across all 220 captures,
 *   2026-09-02, and the only `You get …` line in any of them is `You get back
 *   on your feet.` The pack changing is an inference, not a statement, and
 *   this card states. `Coins collected` counts the server's own sentence and
 *   nothing else.
 *
 * Nothing here sends, and nothing here decides. Same rule as the Reference
 * card: this is a readout of what already happened.
 */
/*
 * Two faces (todo 08): the card, with what decides an evening — the level
 * meter, the rates and the damage — and *More*, with what qualifies it. The
 * face is remembered per character, as the Self card's is.
 */
const FACE_IDS = ['stats', 'more'] as const;
const MORE_ROWS: ReadonlySet<string> = new Set([
  'deflected',
  'dodged',
  'sneak',
  'coins',
  'income',
  'attacking'
]);

interface LevelReading {
  next: number;
  into: number;
  span: number;
  over: number;
  made: number;
}

/**
 * Where the character stands in its level, off the experience table.
 *
 * `into` is what it has past the level's own threshold and `span` what the
 * next one costs from there; past the next threshold `over` is the surplus,
 * which is a banked level the trainer has not been asked for. `made` is this
 * scope's own experience, drawn as the band it accounts for.
 */
function levelReading(progress: CharacterState['progress'], made: number): LevelReading | null {
  const { level, exp, expTable } = progress;
  if (level === null || exp === null || expTable === null) return null;
  const rowAt = (which: number): number | null =>
    expTable.rows.find((row) => row.level === which)?.experience ?? null;
  const base = rowAt(level) ?? (level <= 1 ? 0 : null);
  const top = rowAt(level + 1);
  if (base === null || top === null || top <= base) return null;
  const into = Math.max(0, exp - base);
  const span = top - base;
  return { next: level + 1, into, span, over: Math.max(0, into - span), made: Math.max(0, made) };
}

/**
 * The level meter. The scale is the larger of the way into the level and the
 * level's span, so a character past the threshold fills the whole track, the
 * 100% mark moves left to where the span ends and the overage is tinted past
 * it — the todo's own picture. The band inside the fill is this scope's
 * share, as the target meter draws this character's share of the damage.
 */
function LevelMeter({ reading }: { reading: LevelReading }) {
  const scale = Math.max(reading.into, reading.span, 1);
  const pct = (value: number): number => Math.max(0, Math.min(100, (value / scale) * 100));
  const fill = pct(reading.into);
  const mark = pct(reading.span);
  const mineFrom = pct(Math.max(0, reading.into - reading.made));
  const percent = Math.round((reading.into / reading.span) * 100);
  return (
    <div className="stats-level">
      <div className="meter exp-meter" data-level="ok">
        <div className="fill" style={{ width: `${fill}%` }} />
        {reading.made > 0 && (
          <span className="mine" style={{ left: `${mineFrom}%`, width: `${fill - mineFrom}%` }} />
        )}
        {reading.over > 0 && (
          <>
            <span className="over" style={{ left: `${mark}%`, width: `${100 - mark}%` }} />
            <span className="mark" style={{ left: `${mark}%` }} />
          </>
        )}
        {/* A figure and a word, like every meter: a sentence in a bar wraps
            when the chrome font is turned up. The sentence is the hint's. */}
        <span className="meter-label">
          {t('cards.stats.percent', { value: String(percent) })}
          {reading.over > 0 && (
            <span className="meter-state">
              {t('cards.stats.levelOver', { over: figure(reading.over) })}
            </span>
          )}
        </span>
      </div>
      <span className="hint">
        {t('cards.stats.levelFigure', { percent, next: reading.next })}
        {' · '}
        {t('cards.stats.levelMade', { made: figure(reading.made) })}
      </span>
    </div>
  );
}

/**
 * The rate over the window, one bar or point per bin, the scope's own rate
 * ruled across it. Drawn from `CombatTally.samples`; a bin before the first
 * sample is left blank rather than drawn as a rate of nothing.
 */
function RateGraph({
  samples,
  away,
  leftAt,
  hours,
  graph,
  now,
  current
}: {
  samples: readonly ExperienceSample[];
  away: readonly AwaySpell[];
  leftAt: number | null;
  hours: number;
  graph: StatsGraph;
  now: number;
  current: number | null;
}) {
  const bins = tuning().statsGraphBins;
  // A stretch away still running reaches to now: a character off the realm
  // is drawn as off it, not as earning nothing.
  const spells = leftAt === null ? away : [...away, { from: leftAt, to: now }];
  const series = rateSeries(samples, now - hours * 3_600_000, now, bins, spells);
  const known = series.filter((value): value is number => value !== null);
  const head = (
    <div className="stats-graph-head">
      <span>{t('cards.stats.graphLabel', { hours })}</span>
      {current !== null && <span>{t('cards.stats.graphNow', { rate: rate(current) })}</span>}
    </div>
  );
  if (known.length === 0) {
    return (
      <div className="stats-graph">
        {head}
        <span className="hint">{t('cards.stats.graphEmpty')}</span>
      </div>
    );
  }
  const top = Math.max(...known, current ?? 0, 1);
  const height = 36;
  const width = 100;
  const step = width / series.length;
  const y = (value: number): number => height - 2 - (value / top) * (height - 4);
  const points = series
    .map((value, index) => (value === null ? null : `${index * step + step / 2},${y(value)}`))
    .filter((point): point is string => point !== null)
    .join(' ');
  return (
    <div className="stats-graph">
      {head}
      <svg aria-hidden="true" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
        {graph === 'bars' ? (
          series.map((value, index) =>
            value === null ? null : (
              <rect
                className="bar"
                height={height - y(value)}
                key={index}
                width={Math.max(0.2, step - 0.6)}
                x={index * step + 0.3}
                y={y(value)}
              />
            )
          )
        ) : (
          <polyline className="line" points={points} />
        )}
        {current !== null && (
          <line className="now" x1={0} x2={width} y1={y(current)} y2={y(current)} />
        )}
      </svg>
    </div>
  );
}

function StatsCard({ baseline, character, onReset, session, ...chrome }: StatsCardProps) {
  const { tally, progress } = character;
  const [face, chooseFace] = useRememberedChoice(session, 'stats-tab', FACE_IDS, FACE_IDS[0]);
  const hours = chrome.settings?.value.statsHours ?? DEFAULT_STATS_HOURS;
  const graph = chrome.settings?.value.statsGraph ?? DEFAULT_STATS_GRAPH;

  /**
   * The Reset control, as a *baseline* rather than a message to main.
   *
   * Main keeps one monotonic total; pressing Reset stores a copy of it and
   * every figure is read as the difference. That makes the press instant, keeps
   * main free of a second accumulator, and means the untouched totals are still
   * there — which is what makes Reset safe to press. A baseline from a session
   * that has since restarted is discarded below rather than producing negative
   * counts.
   *
   * **The baseline is `App`'s, not this card's** (todo 01, 2026-09-06). It was
   * remembered here, per character, and that could not answer *starting a loop
   * resets the statistics*: this card ships **put away**, so on most rails it
   * is not mounted when a lap begins, and a card that re-based on mount would
   * wipe however much of the lap had already happened. Whatever re-bases has to
   * be running whether or not anything is drawn, and that is `App`, which holds
   * every session's view and hears the loop push for all of them. There is
   * still exactly **one** baseline, written by the button and by the lap alike,
   * so neither has to be compared against the other.
   */
  /*
   * A baseline from another series cannot be subtracted from this one. The
   * totals are kept per character *and realm* and outlive the launch, while
   * the baseline is kept per character; `since` is set once per series, so a
   * baseline taken on another realm's record — or on one since thrown away —
   * carries a different one, and subtracting it would draw the totals
   * negative.
   */
  const stale =
    baseline !== null &&
    (tally.since === null || baseline.at === null || baseline.since !== tally.since);
  const shown = sinceBaseline(tally, stale ? null : baseline);

  // Read once per render rather than per figure, so every number on the card
  // is taken at the same instant — two clocks in one readout disagree.
  const now = Date.now();
  const total = swings(shown);
  const dealt = damageDealt(shown);
  const landed = hitsDealt(shown);
  const incoming = shown.taken.hits + turnedAside(shown);
  /*
   * Every rate is read over the **scope's own clock** — the time this
   * character has stood in the realm since the scope began, the same stretch
   * the duration badge at the top of this card draws. So `Exp. made 66` over
   * `0:00:40` is a rate the reader can check against the two rows above it,
   * and pressing Reset re-bases all three in one act. In the realm, not since
   * `since`: the tally outlives the socket and the launch, and a night spent
   * disconnected is not an hour the character earned nothing in.
   */
  const elapsed = onlineFor(shown, now);
  const expRate = ratePerHour(shown.experience, elapsed, tuning().rateFloorMs);
  /*
   * **What is still owed, from the table rather than from the realm's summary.**
   *
   * `progress.expNeeded` is the server's `Exp needed for next level`, which
   * reads 0 for a character that has not been to a guild in a while — and
   * `Will level in` under it then read `0:00:00`, which is a client telling
   * somebody they are already there when what they are actually earning is
   * three levels further up. The Vitals card makes the same correction from
   * the same place, so the two cannot disagree; see `src/shared/experience.ts`.
   */
  const standing = experienceStanding(progress.level, progress.exp, progress.expTable);
  const owed = experienceOwed(progress.expNeeded, standing);

  /*
   * **Which rows exist is read from the session, not from the reset.**
   *
   * Every figure on the card is `shown` — the difference since the button was
   * pressed — but the *shape* of the card comes from `tally`, the whole
   * session. Otherwise pressing Reset would empty the card and then have rows
   * reappear one at a time as each thing happened again, which is a card
   * changing height under the pointer for no reason the reader can see. A
   * character that has backstabbed once this session keeps its Backstab row,
   * reading zero, for as long as the session lasts.
   */
  const everHappened = (count: number): boolean => count > 0;

  const rows: Row[] = [
    ...BLOW_KINDS.filter((kind) => everHappened(tally.dealt[kind].hits)).map((kind) => ({
      key: kind,
      label: KIND_LABEL[kind],
      hits: shown.dealt[kind].hits,
      /*
       * A share of every swing, which is what MegaMUD's own window showed —
       * and it is only meaningful for the kinds a *swing* can become. A
       * spell that fails is refused in its own sentence, never counted as a
       * miss, so a spell's share of the swings would be a number over the
       * wrong denominator. A weapon's proc is the same objection from the
       * other side: it rides on a swing that is already in the denominator,
       * so its share of them would count one round twice.
       */
      accuracy: kind === 'spell' || kind === 'proc' ? null : share(shown.dealt[kind].hits, total),
      blows: shown.dealt[kind]
    })),
    ...(everHappened(tally.missed)
      ? [
          {
            key: 'missed',
            label: t('cards.stats.kind.miss'),
            hits: shown.missed,
            accuracy: share(shown.missed, total),
            blows: { hits: shown.missed, damage: 0, least: null, most: null }
          }
        ]
      : [])
  ];

  const columns: Column<Row>[] = [
    { id: 'kind', label: t('cards.stats.column.kind'), value: (row) => row.label },
    {
      id: 'count',
      label: t('cards.stats.column.count'),
      numeric: true,
      value: (row) => row.hits
    },
    {
      id: 'accuracy',
      label: t('cards.stats.column.share'),
      numeric: true,
      value: (row) => row.accuracy ?? -1,
      cell: (row) => percent(row.accuracy)
    },
    {
      id: 'span',
      label: t('cards.stats.column.span'),
      numeric: true,
      value: (row) => row.blows.most ?? -1,
      cell: (row) => span(row.blows)
    },
    {
      id: 'mean',
      label: t('cards.stats.column.mean'),
      numeric: true,
      value: (row) => mean(row.blows.damage, row.blows.hits) ?? -1,
      cell: (row) => figure(mean(row.blows.damage, row.blows.hits), 1)
    }
  ];

  /*
   * The readout, as data.
   *
   * Every row is a label, a figure and — where there is one — a **second
   * figure in its own column**. It used to be a label and a value with the
   * second figure appended inside it, so `133 avg 10.2` and `9 69.2%` were two
   * numbers running into each other and nothing on the card lined up but the
   * labels. A grid can only align what it is given as separate cells, so the
   * rows are declared here and drawn as three columns below.
   *
   * `when` is the visibility rule above: a row whose subject has never
   * happened this session is not drawn. The five that are always drawn are the
   * session's own facts — how much experience, how fast, how many kills, how
   * fast, and how much of the time was spent fighting — and a zero is a real
   * answer to every one of them.
   */
  const readout: { key: string; label: string; value: string; second?: string; when?: boolean }[] =
    [
      { key: 'exp', label: t('cards.stats.expMadeLabel'), value: figure(shown.experience) },
      {
        key: 'need',
        // Which level, where the table can say: `Exp needed` on its own could
        // only ever mean the next one, and the next one is often already paid.
        label:
          standing?.next == null
            ? t('cards.stats.expNeededLabel')
            : t('cards.stats.expNeededToLevel', { level: standing.next }),
        value: figure(owed.value),
        // Marked where the figure is this client's arithmetic rather than the
        // realm's, in the column the readout already has for a second figure.
        second: owed.derived ? t('cards.vitals.workedOut') : undefined
      },
      { key: 'exp-rate', label: t('cards.stats.expRateLabel'), value: rate(expRate) },
      {
        key: 'level-in',
        label: t('cards.stats.willLevelLabel'),
        value: (() => {
          const ms = levelIn(owed.value, expRate);
          return ms === null ? '—' : clock(ms);
        })()
      },
      { key: 'killed', label: t('cards.stats.killedLabel'), value: figure(shown.kills) },
      {
        key: 'kill-rate',
        label: t('cards.stats.killRateLabel'),
        value: rate(ratePerHour(shown.kills, elapsed, tuning().rateFloorMs))
      },
      {
        key: 'dealt',
        label: t('cards.stats.dealtLabel'),
        value: figure(dealt),
        second: average(dealt, landed) ?? undefined,
        when: everHappened(hitsDealt(tally))
      },
      {
        key: 'per-round',
        label: t('cards.stats.perRoundLabel'),
        value: figure(perRound(shown, now, tuning().combatRoundMs), 1),
        when: everHappened(hitsDealt(tally))
      },
      {
        key: 'taken',
        label: t('cards.stats.takenLabel'),
        value: figure(shown.taken.damage),
        second: average(shown.taken.damage, shown.taken.hits) ?? undefined,
        when: everHappened(tally.taken.hits)
      },
      {
        key: 'deflected',
        label: t('cards.stats.deflectedLabel'),
        value: figure(shown.turned),
        second: percent(share(shown.turned, incoming)),
        when: everHappened(tally.turned)
      },
      {
        key: 'dodged',
        label: t('cards.stats.dodgedLabel'),
        value: figure(shown.dodged),
        second: percent(share(shown.dodged, incoming)),
        when: everHappened(tally.dodged)
      },
      {
        key: 'sneak',
        label: t('cards.stats.sneakLabel'),
        value: figure(shown.sneakTried),
        // The share that worked, not the share that failed: MegaMUD's own row
        // reads as a skill, and a skill is stated by how often it holds.
        second: percent(share(shown.sneakTried - shown.sneakFailed, shown.sneakTried)),
        when: everHappened(tally.sneakTried)
      },
      {
        key: 'coins',
        label: t('cards.stats.coinsLabel'),
        value: figure(shown.coins),
        when: everHappened(tally.coins)
      },
      {
        key: 'income',
        label: t('cards.stats.incomeRateLabel'),
        value: rate(ratePerHour(shown.coins, elapsed, tuning().rateFloorMs)),
        when: everHappened(tally.coins)
      },
      {
        key: 'attacking',
        label: t('cards.stats.attackingLabel'),
        value: clock(engagedFor(shown, now)),
        second: percent(engagedShare(shown, now))
      }
    ].filter((row) => row.when !== false);

  const level = levelReading(progress, shown.experience);
  const mainRows = readout.filter((row) => !MORE_ROWS.has(row.key));
  const moreRows = readout.filter((row) => MORE_ROWS.has(row.key));
  const exchange = share(dealt, dealt + shown.taken.damage);

  const rowLines = (list: typeof readout): string[] =>
    list.map((row) =>
      row.second === undefined
        ? `${row.label}: ${row.value}`
        : `${row.label}: ${row.value} · ${row.second}`
    );
  const copyMain = useCallback((): string => {
    return [
      ...(level === null
        ? []
        : [
            t('cards.stats.levelFigure', {
              percent: Math.round((level.into / level.span) * 100),
              next: level.next
            })
          ]),
      ...rowLines(mainRows),
      ...rows.map(
        (row) => `${row.label}: ${row.hits} · ${percent(row.accuracy)} · ${span(row.blows)}`
      )
    ].join('\n');
  }, [level, mainRows, rows]);
  const copyMore = useCallback((): string => {
    return [
      ...rowLines(moreRows),
      ...(exchange === null
        ? []
        : [
            `${t('cards.stats.exchangeLabel')}: ${t('cards.stats.exchangeFigure', {
              dealt: figure(dealt),
              taken: figure(shown.taken.damage)
            })}`
          ])
    ].join('\n');
  }, [moreRows, exchange, dealt, shown.taken.damage]);

  const empty = shown.since === null ? <div className="empty">{t('cards.stats.empty')}</div> : null;
  const pairs = (list: typeof readout): React.JSX.Element[] =>
    list.map((row) => (
      <Pair id={row.key} key={row.key} label={row.label} second={row.second} value={row.value} />
    ));

  const tabs: CardTab[] = [
    {
      id: 'stats',
      label: t('cards.stats.title'),
      paned: true,
      copyText: copyMain,
      content: (
        <div className="scroller">
          {empty ?? (
            <>
              {level !== null && <LevelMeter reading={level} />}
              {/*
                One `<dl>` for the face, and the table under it rather than
                between two of them: a `.readout` sizes its label column from
                its own children. Three columns: an average, a share or a rate
                is a *second figure* with a track of its own (`.readout.paired`),
                and `dt` is pinned to column one so a row with no second figure
                still starts a new row.
              */}
              <dl className="readout paired">{pairs(mainRows)}</dl>
              <RateGraph
                away={shown.away}
                current={expRate}
                graph={graph}
                hours={hours}
                leftAt={shown.leftAt}
                now={now}
                samples={shown.samples}
              />
              <CardTable
                caption={t('cards.stats.tableCaption')}
                className="stats-table"
                columns={columns}
                empty={t('cards.stats.noSwings')}
                keyOf={(row) => row.key}
                name="stats"
                rows={rows}
                session={session}
              />
            </>
          )}
        </div>
      )
    },
    {
      id: 'more',
      label: t('cards.stats.faceMore'),
      paned: true,
      copyText: copyMore,
      content: (
        <div className="scroller">
          {empty ?? (
            <>
              <dl className="readout paired">{pairs(moreRows)}</dl>
              {exchange !== null && (
                <div className="stats-level">
                  <div className="meter exchange">
                    <div className="fill" style={{ width: `${exchange * 100}%` }} />
                    <span className="meter-label">
                      {t('cards.stats.percent', { value: (exchange * 100).toFixed(0) })}
                    </span>
                  </div>
                  <span className="hint">
                    {t('cards.stats.exchangeLabel')}
                    {': '}
                    {t('cards.stats.exchangeFigure', {
                      dealt: figure(dealt),
                      taken: figure(shown.taken.damage)
                    })}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )
    }
  ];

  return (
    <BentoCard
      {...chrome}
      actions={[
        {
          id: 'reset',
          label: t('cards.stats.resetAction'),
          icon: 'reset',
          // Nothing is lost by it — main's totals are untouched — so it is not
          // toned as danger. What it costs is the reading, and that comes back
          // by resetting again on a fresh baseline.
          run: onReset
        }
      ]}
      active={face}
      badge={
        shown.since === null ? (
          <span className="chip off">{t('cards.stats.badge.nothingYet')}</span>
        ) : (
          <span className="chip off">{clock(elapsed)}</span>
        )
      }
      className="stats-card"
      onActive={chooseFace}
      paned
      tabs={tabs}
      title={t('cards.stats.title')}
    />
  );
}

function Pair({
  id,
  label,
  value,
  second
}: {
  /**
   * The row's key, on the figure cell.
   *
   * So a harness can read one row without matching an English label — the
   * `data-action="more"` rule, applied to a readout. Every geometry check on
   * this card passed for the whole time its three rates read `—`, which is
   * what a check keyed on a row's *value* is for.
   */
  id: string;
  label: string;
  value: ReactNode;
  second?: string;
}): React.JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd data-row={id}>{value}</dd>
      {second !== undefined && <dd className="second">{second}</dd>}
    </>
  );
}

export default memo(StatsCard);
