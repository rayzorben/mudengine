/**
 * The route panel's Forecast view: the health the way on screen is expected
 * to leave after each step, walking and running (`healthAlong`), with the
 * other ways' walking lines faint behind it, and one sentence saying what the
 * chart means. A room pressed on the chart is picked, for *Walk here*. See
 * `mudengine-ui` › `parts/map.md`, *The route panel has three views*.
 */
import { useMemo } from 'react';
import RouteSteps, { type RouteStepsProps } from './RouteSteps';
import { t } from '../lib/i18n';
import { factsOf, healthAlong, runDeathAlong, waysOf, type HealthPoint } from '../lib/routeViews';
import { lairsAlong, type Route } from '@shared/world';

interface RouteForecastProps {
  plan: Route;
  shown: Route;
  steps: Omit<RouteStepsProps, 'steps' | 'from' | 'to'>;
}

const WIDTH = 536;
const HEIGHT = 150;
const LEFT = 30;
const RIGHT = WIDTH - 8;
const TOP = 8;
const BOTTOM = 128;
/** The chart reaches this far below an empty bar, so a fight that kills shows how far past. */
const FLOOR = -0.5;

export default function RouteForecast({ plan, shown, steps }: RouteForecastProps) {
  const others = useMemo(() => waysOf(plan).filter(({ route }) => route !== shown), [plan, shown]);
  const walking = useMemo(() => healthAlong(shown.steps, false), [shown]);
  const running = useMemo(() => healthAlong(shown.steps, true), [shown]);
  const dying = useMemo(() => runDeathAlong(shown.steps), [shown]);
  const longest = Math.max(shown.steps.length, ...others.map(({ route }) => route.steps.length), 1);
  const xOf = (index: number) => LEFT + (RIGHT - LEFT) * ((index + 1) / longest);
  const yOf = (share: number) =>
    TOP + ((BOTTOM - TOP) * (1 - Math.max(FLOOR, Math.min(1, share)))) / (1 - FLOOR);
  const pathOf = (points: readonly HealthPoint[]) =>
    [
      `M${xOf(-1)} ${yOf(1)}`,
      ...points.map((point, index) => `L${xOf(index).toFixed(1)} ${yOf(point.share).toFixed(1)}`)
    ].join(' ');
  const lowest = (points: readonly HealthPoint[]) =>
    points.reduce<{ share: number; index: number }>(
      (low, point, index) => (point.share < low.share ? { share: point.share, index } : low),
      { share: 1, index: -1 }
    );
  const walkLow = lowest(walking);
  const runLow = lowest(running);
  const rests = walking.filter((point) => point.rested).length;
  // Whether walking kills is main's verdict (`RouteStep.deadly`), never this chart's sum.
  const deadly = useMemo(() => lairsAlong(shown.steps).deadly, [shown]);
  const unweighed = factsOf(shown.steps).unweighed;
  const span = (RIGHT - LEFT) / longest;
  const picked = steps.picked;
  return (
    <div className="route-forecast">
      <svg
        aria-label={t('cards.route.view.forecastAria')}
        role="img"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      >
        <rect
          className="route-forecast-dead"
          height={BOTTOM - yOf(0)}
          width={RIGHT - LEFT}
          x={LEFT}
          y={yOf(0)}
        />
        <line className="route-forecast-zero" x1={LEFT} x2={RIGHT} y1={yOf(0)} y2={yOf(0)} />
        <line className="route-forecast-half" x1={LEFT} x2={RIGHT} y1={yOf(0.5)} y2={yOf(0.5)} />
        {[1, 0.5, 0].map((share) => (
          <text
            className="route-forecast-axis"
            key={share}
            textAnchor="end"
            x={LEFT - 4}
            y={yOf(share) + 3}
          >
            {`${share * 100}%`}
          </text>
        ))}
        {others.map(({ way, route }) => (
          <path
            className="route-forecast-other"
            d={pathOf(healthAlong(route.steps, false))}
            key={way}
          />
        ))}
        {shown.steps.map((step, index) =>
          step.deadly === true ? (
            <line
              className="route-forecast-deadly"
              key={index}
              x1={xOf(index)}
              x2={xOf(index)}
              y1={TOP}
              y2={BOTTOM}
            />
          ) : null
        )}
        <path className="route-forecast-run" d={pathOf(running)} />
        <path className="route-forecast-walk" d={pathOf(walking)} />
        {picked !== null && picked < shown.steps.length && (
          <line
            className="route-forecast-picked"
            x1={xOf(picked)}
            x2={xOf(picked)}
            y1={TOP}
            y2={BOTTOM}
          />
        )}
        {shown.steps.map((step, index) => (
          <rect
            className="route-step-hit"
            height={BOTTOM - TOP}
            key={index}
            onClick={() => steps.onPick(picked === index ? null : index)}
            width={Math.max(span, 2)}
            x={xOf(index) - span / 2}
            y={TOP}
          >
            <title>
              {t('cards.route.forecast.stepTitle', {
                roomName: step.name,
                walking: Math.round(walking[index]!.share * 100),
                running: Math.round(running[index]!.share * 100)
              })}
            </title>
          </rect>
        ))}
      </svg>
      <p className="route-forecast-says">
        <span data-line="walk">
          {deadly !== null
            ? t('cards.route.forecast.walkDies', { roomName: deadly.name })
            : walkLow.index < 0
              ? t('cards.route.forecast.walkUnhurt')
              : t('cards.route.forecast.walkLow', {
                  percent: Math.round(walkLow.share * 100),
                  roomName: shown.steps[walkLow.index]!.name
                })}
          {rests > 0 &&
            (rests === 1
              ? ` ${t('cards.route.forecast.restOne')}`
              : ` ${t('cards.route.forecast.restMany', { count: rests })}`)}
          {unweighed > 0 &&
            (unweighed === 1
              ? ` ${t('cards.route.forecast.unweighedOne')}`
              : ` ${t('cards.route.forecast.unweighedMany', { count: unweighed })}`)}
        </span>{' '}
        <span data-line="run">
          {runLow.index < 0
            ? t('cards.route.forecast.runUnhurt', { percent: Math.round(dying.chance * 100) })
            : t('cards.route.forecast.runLow', {
                percent: Math.round(runLow.share * 100),
                deathPercent: Math.round(dying.chance * 100)
              })}
          {dying.unweighed > 0 &&
            (dying.unweighed === 1
              ? ` ${t('cards.route.forecast.runUnweighedOne')}`
              : ` ${t('cards.route.forecast.runUnweighedMany', { count: dying.unweighed })}`)}
          {dying.wanderers > 0 &&
            (dying.wanderers === 1
              ? ` ${t('cards.route.forecast.runWanderersOne')}`
              : ` ${t('cards.route.forecast.runWanderersMany', { count: dying.wanderers })}`)}
        </span>
      </p>
      {picked !== null && picked < shown.steps.length && (
        <RouteSteps {...steps} from={picked} steps={shown.steps} to={picked} />
      )}
    </div>
  );
}
