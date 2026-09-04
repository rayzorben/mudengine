import { memo, useMemo } from 'react';

import BentoCard, { type CardChrome, type CardTab } from './BentoCard';
import CardTable, { type Column } from './CardTable';
import {
  EXP_RATE_SETTLE_MS,
  ratio,
  vitalLevel,
  type CharacterState,
  type SessionPhase,
  type VitalThresholds
} from '@shared/character';
import { experienceOwed, experienceStanding, type ExperienceLevel } from '@shared/experience';
import type { SessionId } from '@shared/ipc';
import { useRememberedChoice } from '../hooks/useRemembered';
import { t } from '../lib/i18n';
import { levelWord } from '../lib/vitals';

export interface VitalsCardProps extends CardChrome {
  character: CharacterState;
  /** Which character's card this is, for the chosen face to be remembered against. */
  session: SessionId;
  /** Where each meter turns yellow and red, from `ui.vitals`. */
  thresholds: { hp: VitalThresholds; mana: VitalThresholds };
  /**
   * Sends a command on this character's behalf — `exp`, and nothing else.
   *
   * Asked for, never polled: the table changes only when the race or the class
   * does, which is never, so a client that re-read it would be spending from
   * the budget walking and fighting spend from for a fact it already has.
   */
  ask?(command: string): void;
}

/** The card's faces: the instrument, then what the levels above cost. */
const FACES = ['vitals', 'exp'] as const;
const FACE_IDS: readonly string[] = FACES;

/**
 * What the badge says short of the realm — a table between the `SessionPhase`
 * spelling and the copy, so the words can change without the type moving.
 */
const PHASE_WORD: Record<Exclude<SessionPhase, 'in-game'>, string> = {
  unknown: t('cards.realm.facet.unknown'),
  authenticating: t('cards.vitals.badge.phaseAuthenticating')
};

/**
 * A tonal fill against a track. Flat, no gradient — a meter is data, and per
 * docs/ui-design.md §3.3 data does not get decorated.
 *
 * A null fraction renders as an empty track rather than a full or zero bar: not
 * knowing a maximum is a different state from being at zero, and only one of
 * them means you are about to die.
 *
 * Hue carries the level, and a word carries it too: §6 says state is never
 * colour-only, and the one meter that decides whether you run is the last
 * place to make an exception for a colour-blind player.
 *
 * `tag` says *which resource* the bar is, in the realm's own word — `HP`, and
 * `MA` or `KAI` exactly as the status line spells it. Two stacked bars with two
 * bare fractions on them is a readout you have to know the order of, and the
 * order is not the same for every class: a warrior has one bar, and a mystic's
 * second one is `KAI` rather than mana. Nothing is invented where the word is
 * not known — the tag is simply absent — and that cannot happen while a status
 * line is being read, since the line stating the figure states the word beside
 * it.
 */
function Meter({
  value,
  max,
  tag,
  tone,
  thresholds
}: {
  value: number | null;
  max: number | null;
  tag: string | null;
  tone: 'hp' | 'mana';
  thresholds: VitalThresholds;
}) {
  const fraction = ratio(value, max);
  const level = vitalLevel(value, max, thresholds);
  const word = levelWord(level);
  return (
    <div className={`meter ${tone}${fraction === null ? ' unknown' : ''}`} data-level={level}>
      <div
        className="fill"
        style={fraction === null ? undefined : { width: `${fraction * 100}%` }}
      />
      {tag !== null && <span className="meter-tag">{tag}</span>}
      <span className="meter-label">
        {value === null ? '—' : max === null ? value : `${value}/${max}`}
        {word !== null && <span className="meter-state">{word}</span>}
      </span>
    </div>
  );
}

/** A figure the realm has not stated reads as a dash, never as zero. */
function figure(value: number | null): string {
  return value === null ? '—' : value.toLocaleString();
}

/**
 * Health, mana and progress.
 *
 * Everything here is nullable on purpose. A freshly connected client knows
 * nothing, the status line carries no maxima until the stat sheet has been
 * seen, and a warrior has no mana at all. Rendering an unknown as `0` is how a
 * HUD lies about the one number that decides whether you run.
 *
 * ## Two faces, and the second exists because the first was answering wrongly
 *
 * `To level` drew `progress.expNeeded` — the realm's own `Exp needed for next
 * level` — which reads **0** for a character that has not been to a guild in a
 * while, because the next level is already paid for. That is true and it is not
 * the question: what a player wants is *what am I earning towards now*, and on
 * a character three levels behind its experience the answer is four levels up.
 *
 * So the readout is worked out from the **table** instead (`ExperienceStanding`)
 * and names the level it is counting to, and the second face draws the table it
 * came from. The realm's figure is still what is drawn when no table has been
 * read — it is the server's own arithmetic, and it is right about the next
 * level every time.
 */
function VitalsCard({ character, session, thresholds, ask, ...chrome }: VitalsCardProps) {
  const { vitals, progress, phase, inCombat, stealth } = character;
  const [face, chooseFace] = useRememberedChoice(session, 'vitals-tab', FACE_IDS, FACE_IDS[0]!);
  const elapsed =
    progress.realmEnteredAt === null ? 0 : Math.max(0, Date.now() - progress.realmEnteredAt);
  const rate =
    elapsed < EXP_RATE_SETTLE_MS || progress.expThisSession === 0
      ? null
      : Math.round(progress.expThisSession / (elapsed / 3_600_000));

  const table = progress.expTable;
  const standing = useMemo(
    () => experienceStanding(progress.level, progress.exp, table),
    [progress.level, progress.exp, table]
  );
  // The realm's own figure wherever it answers, this client's arithmetic only
  // where it cannot — and marked when it is the second. See `experienceOwed`.
  const owed = experienceOwed(progress.expNeeded, standing);

  /*
   * One condition, most urgent first.
   *
   * Combat outranks everything; resting and meditating are what a character is
   * *doing*; sneaking is how it is moving, and it only ranks above idle because
   * it is a state somebody switched on and needs to know is still true — a
   * character that thinks it is sneaking and is not walks into the next lair in
   * plain sight.
   *
   * `unknown` shows nothing at all: nobody having tried to sneak is not a
   * condition, and a badge saying so would be chrome.
   */
  const badge = inCombat ? (
    <span className="chip bad">{t('cards.vitals.badge.combat')}</span>
  ) : vitals.resting ? (
    <span className="chip warn">{t('cards.vitals.badge.resting')}</span>
  ) : vitals.meditating ? (
    <span className="chip warn">{t('cards.vitals.badge.meditating')}</span>
  ) : stealth === 'sneaking' ? (
    <span className="chip on">{t('cards.vitals.badge.sneaking')}</span>
  ) : (
    <span className="chip off">
      {phase === 'in-game' ? t('cards.vitals.badge.idle') : PHASE_WORD[phase]}
    </span>
  );

  const vitalsFace =
    phase !== 'in-game' ? (
      <div className="empty">{t('cards.vitals.emptyNotInRealm')}</div>
    ) : (
      <>
        <Meter max={vitals.hpMax} tag="HP" thresholds={thresholds.hp} tone="hp" value={vitals.hp} />
        {/* No mana row at all for a class that has none — an empty bar would
            imply a resource that does not exist. */}
        {vitals.mana !== null && (
          <Meter
            max={vitals.manaMax}
            tag={vitals.manaType}
            thresholds={thresholds.mana}
            tone="mana"
            value={vitals.mana}
          />
        )}

        <dl className="readout">
          <dt>{t('cards.realm.column.name')}</dt>
          <dd className={character.name ? '' : 'inert'}>{character.name ?? '—'}</dd>
          <dt>{t('cards.vitals.labels.class')}</dt>
          <dd className={character.className ? '' : 'inert'}>
            {character.className ?? '—'}
            {character.race ? ` · ${character.race}` : ''}
          </dd>
          <dt>{t('cards.vitals.labels.level')}</dt>
          <dd className={progress.level === null ? 'inert' : ''}>{progress.level ?? '—'}</dd>
          {/*
            Only when it differs from the granted level, and accented when it
            does: a character standing on experience it has not trained for is
            the one case this whole face exists to state, and a row that said
            `Earned 3` beside `Level 3` on every other character would bury it.
          */}
          {standing !== null && standing.ahead && (
            <>
              <dt>{t('cards.vitals.labels.earned')}</dt>
              <dd className="ahead">
                {standing.earned}
                {/* Said out loud where the row that established it is this
                    client's arithmetic rather than the realm's. A level
                    somebody is told they have already earned is exactly the
                    figure that must not be taken on trust. */}
                {standing.earnedSource === 'database' && (
                  <span className="hint"> {t('cards.vitals.workedOut')}</span>
                )}
              </dd>
            </>
          )}
          <dt>
            {standing?.next == null
              ? t('cards.vitals.labels.toLevel')
              : t('cards.vitals.toLevelFormat', { level: standing.next })}
          </dt>
          <dd className={owed.value === null ? 'inert' : ''}>
            {figure(owed.value)}
            {owed.derived && <span className="hint"> {t('cards.vitals.workedOut')}</span>}
          </dd>
          <dt>{t('cards.session.title')}</dt>
          <dd>
            {t('cards.vitals.sessionExpFormat', {
              sessionExp: progress.expThisSession.toLocaleString()
            })}
          </dd>
          <dt>{t('cards.session.rate')}</dt>
          {/* Meaningless for the first couple of minutes: 40 exp in ten
              seconds extrapolates to a rate nobody is earning. */}
          <dd className={rate === null ? 'inert' : ''}>
            {rate === null ? '—' : t('cards.vitals.rateFormat', { rate: rate.toLocaleString() })}
          </dd>
        </dl>
      </>
    );

  const rows = table?.rows ?? [];
  const held = progress.exp;
  const columns: Column<ExperienceLevel>[] = [
    {
      id: 'level',
      label: t('cards.vitals.expColumn.level'),
      numeric: true,
      value: (row) => row.level
    },
    {
      id: 'experience',
      label: t('cards.vitals.expColumn.experience'),
      numeric: true,
      value: (row) => row.experience,
      cell: (row) => row.experience.toLocaleString()
    },
    {
      id: 'needed',
      label: t('cards.vitals.expColumn.needed'),
      numeric: true,
      /*
       * A level already paid for sorts **last**, not as a shortfall of nought:
       * nought owed and nothing owed are the same number and different facts,
       * and this column is read to find the first row that still costs. `null`
       * is what `sortRows` puts at the end whichever way the column points, and
       * `Math.max(0, …)` was the opposite — it made every reached level sort
       * above the one being earned towards, which is the row somebody came for.
       */
      value: (row) => (held === null || row.experience <= held ? null : row.experience - held),
      cell: (row) =>
        held === null ? (
          '—'
        ) : row.experience <= held ? (
          <span className="hint">{t('cards.vitals.expReached')}</span>
        ) : (
          (row.experience - held).toLocaleString()
        )
    }
  ];

  const derived = rows.filter((row) => row.source === 'database').length;
  const provenance =
    rows.length === 0
      ? null
      : derived === 0
        ? t('cards.vitals.expProvenance.realm')
        : derived === rows.length
          ? t('cards.vitals.expProvenance.database')
          : t('cards.vitals.expProvenance.mixed');

  const expFace = (
    <>
      <CardTable
        caption={t('cards.vitals.expCaption')}
        className="exp-chart"
        columns={columns}
        empty={
          phase === 'in-game' && ask
            ? t('cards.vitals.expEmpty')
            : t('cards.vitals.expEmptyOffline')
        }
        keyOf={(row) => String(row.level)}
        name="exp-chart"
        /*
           The row a decision gets made off is the one still being paid for, and
           the rows behind it are history: both are marked, so the eye lands on
           the boundary rather than counting down a column of numbers. Derived
           rows are marked too — a number this client worked out must not read
           like one the server sent.
        */
        rowAttrs={(row) => ({
          'data-reached': held !== null && row.experience <= held ? 'true' : undefined,
          'data-next': standing?.next === row.level ? 'true' : undefined,
          'data-derived': row.source === 'database' ? 'true' : undefined
        })}
        rows={rows}
        session={session}
      />
      {provenance !== null && <span className="hint">{provenance}</span>}
    </>
  );

  const tabs: CardTab[] = [
    {
      id: FACES[0],
      label: t('cards.vitals.title'),
      content: vitalsFace,
      copyText: () =>
        [
          `${t('cards.realm.column.name')}: ${character.name ?? '—'}`,
          `${t('cards.vitals.labels.level')}: ${progress.level ?? '—'}`,
          standing !== null && standing.ahead
            ? `${t('cards.vitals.labels.earned')}: ${standing.earned}`
            : null,
          `${
            standing?.next == null
              ? t('cards.vitals.labels.toLevel')
              : t('cards.vitals.toLevelFormat', { level: standing.next })
          }: ${figure(owed.value)}${owed.derived ? ` (${t('cards.vitals.workedOut')})` : ''}`
        ]
          .filter((line) => line !== null)
          .join('\n')
    },
    {
      id: FACES[1],
      label: t('cards.vitals.tabExp'),
      content: expFace,
      paned: true,
      /* Each face copies what it shows: the instrument, or the table. */
      copyText: () =>
        rows.length === 0 ? '—' : rows.map((row) => `${row.level}\t${row.experience}`).join('\n')
    }
  ];

  return (
    <BentoCard
      {...chrome}
      actions={
        /*
         * Only on the face it answers, and only in the realm: `exp` is a
         * question, and a button that sends one from a card showing something
         * else is a control whose effect is off screen.
         */
        ask && face === FACES[1] && phase === 'in-game'
          ? [
              {
                id: 'exp',
                label: t('cards.vitals.askExpTooltip'),
                icon: 'reset',
                run: () => ask('exp')
              }
            ]
          : undefined
      }
      active={face}
      badge={badge}
      className="vitals-card"
      onActive={chooseFace}
      tabs={tabs}
      title={t('cards.vitals.title')}
    />
  );
}

export default memo(VitalsCard);
