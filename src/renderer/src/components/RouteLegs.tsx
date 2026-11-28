/**
 * The route panel's Legs view: the way on screen split by area (`areasOf`),
 * one line each of what it holds, its worst lair on the right, and under the
 * leg another way leaves from, one line saying what that way walks instead.
 * A leg opens to its rooms, drawn by `RouteSteps`. See `mudengine-ui` ›
 * `parts/map.md`, *The route panel has three views*.
 */
import { useEffect, useMemo, useState } from 'react';
import RouteSteps, { type RouteStepsProps } from './RouteSteps';
import { keepFocus } from '../lib/focus';
import { shareGrade, type LairGrade } from '../lib/route';
import { t } from '../lib/i18n';
import {
  areasOf,
  factsOf,
  forksOf,
  wayName,
  waysOf,
  type Fork,
  type StretchFacts,
  type Way
} from '../lib/routeViews';
import { DIRECTION_NAME, type Route } from '@shared/world';

interface RouteLegsProps {
  /** The plan, whose ways the forks are read from. */
  plan: Route;
  /** The way on screen. */
  shown: Route;
  onChoose(way: Way): void;
  /** What a leg's rooms are drawn with, less the stretch. */
  steps: Omit<RouteStepsProps, 'steps' | 'from' | 'to'>;
}

/** `worst 49%` coloured by its grade: red only where main expects it to kill, amber when heavy. */
const TONE: Record<LairGrade, 'bad' | 'warn' | undefined> = {
  deadly: 'bad',
  heavy: 'warn',
  light: undefined
};

/** The leg's one line: lairs, those nobody weighed, room spells, then each gate by its chip's word. */
function factLine(facts: StretchFacts): string {
  const parts = [
    facts.lairs === 0
      ? null
      : facts.lairs === 1
        ? t('cards.route.legs.lairOne')
        : t('cards.route.legs.lairMany', { count: facts.lairs }),
    facts.unweighed === 0
      ? null
      : facts.unweighed === 1
        ? t('cards.route.keptOut.unweighed.one')
        : t('cards.route.keptOut.unweighed.many', { count: facts.unweighed }),
    facts.spells === 0
      ? null
      : facts.spells === 1
        ? t('cards.route.legs.spellOne')
        : t('cards.route.legs.spellMany', { count: facts.spells }),
    ...facts.gates
  ];
  const said = parts.filter((part) => part !== null);
  return said.length === 0 ? t('cards.route.legs.nothing') : said.join(' · ');
}

function ForkLine({
  fork,
  shown,
  onChoose
}: {
  fork: Fork;
  shown: Route;
  onChoose(way: Way): void;
}) {
  const ours = factsOf(shown.steps.slice(fork.from, fork.to + 1));
  const theirs = factsOf(fork.theirs);
  const rooms = fork.theirs.length - (fork.to - fork.from + 1);
  // Compared only where both sides were weighed whole: an unknown is never the better way.
  const known =
    theirs.unweighed === 0 && ours.unweighed === 0 && theirs.worst !== null && ours.worst !== null;
  const tone = !known
    ? undefined
    : theirs.worst! < ours.worst!
      ? 'better'
      : theirs.worst! > ours.worst!
        ? 'worse'
        : undefined;
  const lairs =
    theirs.unweighed > 0
      ? theirs.unweighed === 1
        ? t('cards.route.keptOut.unweighed.one')
        : t('cards.route.keptOut.unweighed.many', { count: theirs.unweighed })
      : theirs.worst !== null
        ? t('cards.route.legs.forkWorst', { percent: Math.round(theirs.worst * 100) })
        : theirs.lairs === 0 && (ours.worst !== null || ours.unweighed > 0)
          ? t('cards.route.legs.forkNoLairs')
          : null;
  return (
    <div className="route-fork" data-way={fork.way}>
      <span>
        {t('cards.route.legs.forkOr', { wayName: wayName(fork.way) })}{' '}
        <span data-tone={rooms > 0 ? 'worse' : 'better'}>
          {rooms > 0
            ? t('cards.route.legs.forkMore', { count: rooms })
            : rooms < 0
              ? t('cards.route.legs.forkFewer', { count: -rooms })
              : t('cards.route.legs.forkSame')}
        </span>
        {lairs !== null && (
          <>
            {', '}
            <span data-tone={tone}>{lairs}</span>
          </>
        )}
        {theirs.gates.length > 0 && `, ${theirs.gates.join(', ')}`}
      </span>
      <button
        className="quiet"
        onClick={() => onChoose(fork.way)}
        onMouseDown={keepFocus}
        title={t('cards.route.otherWayTooltip')}
        type="button"
      >
        {t('cards.route.otherWayButton')}
      </button>
    </div>
  );
}

export default function RouteLegs({ plan, shown, onChoose, steps }: RouteLegsProps) {
  const areas = useMemo(() => areasOf(shown.steps), [shown]);
  const forks = useMemo(
    () =>
      waysOf(plan)
        .filter(({ route }) => route !== shown)
        .flatMap(({ way, route }) => forksOf(shown, way, route)),
    [plan, shown]
  );
  /** Legs opened to their rooms, by first step; a new way on screen closes them. */
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  useEffect(() => setOpen(new Set()), [shown]);
  return (
    <ol className="route-legs">
      {areas.map((area) => {
        const legSteps = shown.steps.slice(area.from, area.to + 1);
        const facts = factsOf(legSteps);
        const opened = open.has(area.from);
        const grade = shareGrade(facts.worst, facts.deadly);
        const risk = grade === null ? undefined : TONE[grade];
        return (
          <li className="route-leg" data-open={opened ? 'true' : 'false'} key={area.from}>
            <button
              aria-expanded={opened}
              className="lookup route-leg-head"
              onClick={() =>
                setOpen((current) => {
                  const next = new Set(current);
                  if (next.has(area.from)) next.delete(area.from);
                  else next.add(area.from);
                  return next;
                })
              }
              onMouseDown={keepFocus}
              type="button"
            >
              <span className="route-leg-name">{area.name}</span>
              <span className="route-leg-size">
                {legSteps.length === 1
                  ? t('cards.route.legs.roomOne')
                  : t('cards.route.legs.roomMany', { count: legSteps.length })}
                {facts.heading !== null && ` · ${DIRECTION_NAME[facts.heading]}`}
              </span>
              <span className="route-leg-risk" data-tone={risk}>
                {facts.deadly
                  ? t('cards.route.stepDeadly')
                  : facts.worst === null
                    ? ''
                    : t('cards.route.legs.worst', { percent: Math.round(facts.worst * 100) })}
              </span>
              <span className="route-leg-facts">{factLine(facts)}</span>
            </button>
            {opened && <RouteSteps {...steps} from={area.from} steps={shown.steps} to={area.to} />}
            {forks
              .filter((fork) => fork.from >= area.from && fork.from <= area.to)
              .map((fork) => (
                <ForkLine
                  fork={fork}
                  key={`${fork.way}-${fork.from}`}
                  onChoose={onChoose}
                  shown={shown}
                />
              ))}
          </li>
        );
      })}
    </ol>
  );
}
