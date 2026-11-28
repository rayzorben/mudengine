/**
 * The route panel's Line view: every way main planned as a line on one
 * scale, so their lengths compare at a glance and the stretch they share
 * lines up. The way on screen is drawn open, with its lairs, gates and room
 * spells; the others thin, with their worst lair. A line pressed puts its way
 * on screen; a room pressed on the open one is picked, for *Walk here*. See
 * `mudengine-ui` › `parts/map.md`, *The route panel has three views*.
 */
import { useMemo } from 'react';
import RouteSteps, { type RouteStepsProps } from './RouteSteps';
import { t } from '../lib/i18n';
import { gateWord, lairGrade, stepDanger, type LairGrade } from '../lib/route';
import { areasOf, factsOf, wayName, waysOf, type Way } from '../lib/routeViews';
import type { Route, RouteStep } from '@shared/world';

interface RouteLinesProps {
  plan: Route;
  shown: Route;
  chosen: Way;
  onChoose(way: Way): void;
  /** What a picked room's row is drawn with, less the stretch. */
  steps: Omit<RouteStepsProps, 'steps' | 'from' | 'to'>;
}

/** The drawing's own units; the box scales it to the panel's width. */
const WIDTH = 536;
const LEFT = 8;
const RIGHT = WIDTH - 8;
const OPEN_LANE = 76;
const THIN_LANE = 34;
/** A lair's mark, by its grade; one nobody weighed is its own, never a light one. */
function lairClass(grade: LairGrade | null): string {
  return grade === null ? 'route-lair unweighed' : `route-lair ${grade}`;
}

/** Heavy and deadly lairs wear their figure on the open line, and keep their mark on a thin one. */
const marked = (grade: LairGrade | null) => grade === 'heavy' || grade === 'deadly';

function title(step: RouteStep): string {
  const danger = stepDanger(step);
  return [
    step.name,
    danger === null
      ? null
      : danger.kind === 'deadly'
        ? t('cards.route.stepDeadly')
        : t('cards.route.stepLair', { percent: danger.percent }),
    gateWord(step)
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

export default function RouteLines({ plan, shown, chosen, onChoose, steps }: RouteLinesProps) {
  const lanes = useMemo(() => {
    const ways = waysOf(plan);
    // A way picked through a kept-out choice is on screen without being one of the plan's.
    return ways.some(({ route }) => route === shown)
      ? ways
      : [{ way: chosen, route: shown }, ...ways];
  }, [plan, shown, chosen]);
  const longest = Math.max(...lanes.map(({ route }) => route.steps.length), 1);
  const xOf = (index: number) => LEFT + (RIGHT - LEFT) * ((index + 1) / longest);
  let y = 0;
  const drawn = lanes.map(({ way, route }) => {
    const isShown = route === shown;
    const top = y;
    y += isShown ? OPEN_LANE : THIN_LANE;
    const line = top + 22;
    const facts = factsOf(route.steps);
    const areas = areasOf(route.steps);
    const rows: number[] = [-Infinity, -Infinity, -Infinity];
    return (
      <g
        className="route-lane"
        data-shown={isShown ? 'true' : 'false'}
        data-way={way}
        key={way}
        onClick={isShown ? undefined : () => onChoose(way)}
      >
        <rect
          className="route-lane-hit"
          height={isShown ? OPEN_LANE : THIN_LANE}
          width={WIDTH}
          x={0}
          y={top}
        />
        <text className="route-lane-name" x={LEFT} y={top + 11}>
          {wayName(way)}
        </text>
        <text className="route-lane-figures" textAnchor="end" x={RIGHT} y={top + 11}>
          {[
            t('cards.route.routeSummary', { stepCount: route.steps.length }),
            facts.deadly
              ? t('cards.route.stepDeadly')
              : facts.worst === null
                ? null
                : t('cards.route.legs.worst', { percent: Math.round(facts.worst * 100) }),
            facts.unweighed === 0
              ? null
              : facts.unweighed === 1
                ? t('cards.route.keptOut.unweighed.one')
                : t('cards.route.keptOut.unweighed.many', { count: facts.unweighed })
          ]
            .filter((part) => part !== null)
            .join(' · ')}
        </text>
        {areas.map((area, index) => (
          <line
            className={`route-lane-area area-${index % 4}`}
            key={area.from}
            x1={xOf(area.from - 1)}
            x2={xOf(area.to)}
            y1={line}
            y2={line}
          />
        ))}
        {route.steps.map((step, index) => {
          const x = xOf(index);
          const grade = lairGrade(step);
          if (!isShown) {
            // The thin line keeps its heavy and deadly lairs, enough to compare.
            if (step.lair === true && marked(grade))
              return <circle className={lairClass(grade)} cx={x} cy={line} key={index} r={3} />;
            return null;
          }
          const marks = [];
          if (step.hazard !== undefined)
            marks.push(
              <rect className="route-spell" height={3} key="s" width={2} x={x - 1} y={line + 5} />
            );
          if (step.lair === true) {
            const share = Math.min(step.danger ?? 0, 1.8);
            marks.push(
              <circle className={lairClass(grade)} cx={x} cy={line} key="l" r={2.5 + share * 3} />
            );
            if (marked(grade)) {
              const text = grade === 'deadly' ? '✕' : `${Math.round((step.danger ?? 0) * 100)}%`;
              const wide = text.length * 5.5;
              const row = Math.max(
                0,
                rows.findIndex((end) => x - wide / 2 > end + 2)
              );
              rows[row] = x + wide / 2;
              marks.push(
                <text
                  className={`${lairClass(grade)} route-lair-figure`}
                  key="f"
                  textAnchor="middle"
                  x={x}
                  y={line + 19 + row * 10}
                >
                  {text}
                </text>
              );
            }
          }
          if (gateWord(step) !== null)
            marks.push(
              <rect
                className={step.requirement?.kind === 'trap' ? 'route-gate trap' : 'route-gate'}
                height={6}
                key="g"
                transform={`rotate(45 ${x} ${line})`}
                width={6}
                x={x - 3}
                y={line - 3}
              />
            );
          const span = (RIGHT - LEFT) / longest;
          marks.push(
            <rect
              className="route-step-hit"
              height={16}
              key="h"
              onClick={() => steps.onPick(steps.picked === index ? null : index)}
              width={Math.max(span, 2)}
              x={x - span / 2}
              y={line - 8}
            >
              <title>{title(step)}</title>
            </rect>
          );
          return <g key={index}>{marks}</g>;
        })}
        <circle
          className="route-lane-end"
          cx={xOf(route.steps.length - 1)}
          cy={line}
          r={isShown ? 4.5 : 3}
        />
        {isShown && steps.picked !== null && steps.picked < route.steps.length && (
          <circle className="route-lane-picked" cx={xOf(steps.picked)} cy={line} r={5} />
        )}
      </g>
    );
  });
  const picked = steps.picked;
  return (
    <div className="route-lines">
      <svg role="img" aria-label={t('cards.route.view.lineAria')} viewBox={`0 0 ${WIDTH} ${y}`}>
        {drawn}
      </svg>
      {picked !== null && picked < shown.steps.length && (
        <RouteSteps {...steps} from={picked} steps={shown.steps} to={picked} />
      )}
    </div>
  );
}
