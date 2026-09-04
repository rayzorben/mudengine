import { memo, useCallback, type ReactNode } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import CardTable, { type Column } from './CardTable';
import type { CharacterState } from '@shared/character';
import { experienceOwed, experienceStanding } from '@shared/experience';
import {
  BLOW_KINDS,
  damageDealt,
  engagedFor,
  engagedShare,
  hitsDealt,
  mean,
  perRound,
  ratePerHour,
  share,
  readTally,
  sinceBaseline,
  swings,
  turnedAside,
  type BlowKind,
  type BlowTally,
  type CombatTally
} from '@shared/tally';
import type { SessionId } from '@shared/ipc';
import { useRememberedValue } from '../hooks/useRemembered';
import { t } from '../lib/i18n';
import { tuning } from '../lib/tuning';

export interface StatsCardProps extends CardChrome {
  character: CharacterState;
  /** Which character's card this is, for the baseline to be remembered against. */
  session: SessionId;
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
  spell: t('cards.stats.kind.cast')
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
function StatsCard({ character, session, ...chrome }: StatsCardProps) {
  const { tally, progress } = character;

  /**
   * The Reset control, as a *baseline* rather than a message to main.
   *
   * Main keeps one monotonic total; pressing Reset stores a copy of it here and
   * every figure is read as the difference. That makes the press instant, keeps
   * main free of a second accumulator, and means the untouched totals are still
   * there — which is what makes Reset safe to press. Remembered per character
   * like every other card preference; a baseline from a session that has since
   * restarted is discarded below rather than producing negative counts.
   */
  const [baseline, setBaseline] = useRememberedValue<CombatTally>(session, 'stats-base', readTally);
  const stale =
    baseline !== null &&
    (tally.since === null || baseline.at === null || baseline.at < tally.since);
  const shown = sinceBaseline(tally, stale ? null : baseline);

  // Read once per render rather than per figure, so every number on the card
  // is taken at the same instant — two clocks in one readout disagree.
  const now = Date.now();
  const total = swings(shown);
  const dealt = damageDealt(shown);
  const landed = hitsDealt(shown);
  const incoming = shown.taken.hits + turnedAside(shown);
  /*
   * Every rate is read over the **scope**, which is `since` to now — the same
   * stretch the duration badge at the top of this card draws. So `Exp. made
   * 66` over `0:00:40` is a rate the reader can check against the two rows
   * above it, and pressing Reset re-bases all three in one act.
   */
  const expRate = ratePerHour(shown.experience, shown.since, now, tuning().rateFloorMs);
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
       * wrong denominator.
       */
      accuracy: kind === 'spell' ? null : share(shown.dealt[kind].hits, total),
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

  const reset = useCallback(() => setBaseline(tally), [setBaseline, tally]);

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
        value: rate(ratePerHour(shown.kills, shown.since, now, tuning().rateFloorMs))
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
        value: rate(ratePerHour(shown.coins, shown.since, now, tuning().rateFloorMs)),
        when: everHappened(tally.coins)
      },
      {
        key: 'attacking',
        label: t('cards.stats.attackingLabel'),
        value: clock(engagedFor(shown, now)),
        second: percent(engagedShare(shown, now))
      }
    ].filter((row) => row.when !== false);

  const copyText = useCallback((): string => {
    return [
      ...readout.map((row) =>
        row.second === undefined
          ? `${row.label}: ${row.value}`
          : `${row.label}: ${row.value} · ${row.second}`
      ),
      ...rows.map(
        (row) => `${row.label}: ${row.hits} · ${percent(row.accuracy)} · ${span(row.blows)}`
      )
    ].join('\n');
  }, [readout, rows]);

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
          run: reset
        }
      ]}
      badge={
        shown.since === null ? (
          <span className="chip off">{t('cards.stats.badge.nothingYet')}</span>
        ) : (
          <span className="chip off">{clock(now - shown.since)}</span>
        )
      }
      className="stats-card"
      copyText={copyText}
      paned
      title={t('cards.stats.title')}
    >
      <div className="scroller">
        {shown.since === null ? (
          <div className="empty">{t('cards.stats.empty')}</div>
        ) : (
          <>
            {/*
              One `<dl>` for the whole card, and the table under it rather than
              between two of them: a `.readout` sizes its label column from its
              own children, so the two it had gave one card two label columns of
              different widths with nothing in the text to say why.

              Three columns rather than two, and the third is what the todo
              asked for: an average, a share or a rate is a *second figure*, and
              appending it inside the value cell put it at whatever x the first
              figure happened to end at — a different one on every row.
              `.readout.paired` gives it a track of its own, and `dt` is pinned
              to column one so a row with no second figure still starts a new
              row rather than letting the next label auto-place into the gap.
            */}
            <dl className="readout paired">
              {readout.map((row) => (
                <Pair
                  id={row.key}
                  key={row.key}
                  label={row.label}
                  second={row.second}
                  value={row.value}
                />
              ))}
            </dl>

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
    </BentoCard>
  );
}

/**
 * One row of the readout: the label, the figure, and the second figure.
 *
 * A fragment rather than a wrapper, because the three cells are laid out by
 * the `<dl>`'s own grid — an element around them would take one cell and put
 * the alignment back where it was.
 */
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
