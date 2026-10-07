import Icon from './Icon';
import PlanFights from './PlanFights';
import { copperWords, unpricedWords } from '../lib/gearPicks';
import { t } from '../lib/i18n';
import type { GearLeg, GearStop, GearTripPlan, GearTripProgress } from '@shared/gearTrip';
import { describeBlock } from '@shared/world';

/**
 * The Gear card's trip: its figures at the head (stops, steps, cost, what
 * the banks are short), then the banks and shops in walking order as a
 * stepper, each stop a tile with what it buys or draws and what the walk
 * there meets (fights with this character's odds, what the rooms cast, doors
 * it cannot pass, keys a way wants fetched), shown and never a reason to
 * refuse; then *Run it* or *Walk it*, the route panel's two presses, and
 * *Stop* while it goes. The stops wear the progression grammar.
 */
export interface GearTripFaceProps {
  plan: GearTripPlan;
  trip: GearTripProgress | null;
  onGo(run: boolean): void;
  onStop(): void;
  onReplan(): void;
}

function Stop({ stop }: { stop: GearStop }) {
  switch (stop.kind) {
    case 'bank':
      return (
        <div className="gear-stop-what">
          <span className="gear-item-name">{stop.bank}</span>
          <span className="chip info cased">
            {t('cards.gear.withdraw', { amount: copperWords(stop.withdraw) })}
          </span>
        </div>
      );
    case 'shop':
      return (
        <div className="gear-stop-what">
          <span className="gear-item-name">{stop.shop}</span>
          <span className="gear-stop-items">
            {stop.items.map((item) => (
              <span className="chip cased" key={item.item}>
                {item.charged === null
                  ? item.name
                  : t('cards.gear.itemPrice', {
                      item: item.name,
                      price: copperWords(item.charged)
                    })}
              </span>
            ))}
          </span>
        </div>
      );
    default: {
      const never: never = stop;
      return never;
    }
  }
}

function Leg({ leg }: { leg: GearLeg }) {
  return (
    <div className="gear-leg">
      <span className="chip quiet cased">
        {leg.steps === null
          ? t('cards.gear.legNoWay')
          : leg.steps === 1
            ? t('cards.gear.legSteps.one')
            : t('cards.gear.legSteps.many', { steps: leg.steps })}
      </span>
      {leg.blocked === null ? null : <span className="chip bad cased">{leg.blocked}</span>}
      {leg.needs.length === 0 ? null : (
        <span className="chip warn cased">
          {t('cards.gear.legNeeds', { items: leg.needs.map((item) => item.name).join(', ') })}
        </span>
      )}
      {leg.walls.map((wall, index) => (
        <span className="chip bad cased" key={`wall-${index}`}>
          {describeBlock(wall)}
        </span>
      ))}
      {leg.hazards.map((hazard) => (
        <span className="chip warn cased" key={`hazard-${hazard.id}`}>
          {t('cards.gear.legHazard', { spell: hazard.spell, rooms: hazard.rooms })}
        </span>
      ))}
      <PlanFights compact fights={leg.fights} />
    </div>
  );
}

/** One figure at the head of the trip: a small label over a large value. */
function Figure({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="gear-figure" data-tone={tone}>
      <span className="gear-figure-label">{label}</span>
      <span className="gear-figure-value">{value}</span>
    </div>
  );
}

export default function GearTripFace({ plan, trip, onGo, onStop, onReplan }: GearTripFaceProps) {
  const running = trip !== null && trip.stage !== 'ended' && trip.plan === plan;
  const progressOf = (index: number): 'done' | 'now' | 'left' =>
    !running ? 'left' : index < trip.stop ? 'done' : index === trip.stop ? 'now' : 'left';
  const notes = [
    unpricedWords(plan.unpriced),
    plan.purse === null ? t('cards.gear.tripPurseUnread') : '',
    plan.stops.some((stop) => stop.leg.blocked !== null) ? t('cards.gear.tripBlocked') : '',
    plan.left.length === 0
      ? ''
      : t('cards.gear.tripLeft', {
          items: plan.left
            .map((left) =>
              left.why === 'not-sold'
                ? t('cards.gear.leftNotSold', { item: left.name })
                : t('cards.gear.leftUnreachable', { item: left.name })
            )
            .join(', ')
        }),
    trip?.ended ?? ''
  ].filter((note) => note !== '');
  return (
    <>
      {plan.refusal === undefined ? (
        <div className="gear-figures">
          <Figure label={t('cards.gear.figureStops')} value={String(plan.stops.length)} />
          <Figure label={t('cards.gear.figureSteps')} value={plan.moves.toLocaleString()} />
          <Figure label={t('cards.gear.figureCost')} value={copperWords(plan.owed)} />
          {plan.short > 0 ? (
            <Figure
              label={t('cards.gear.figureShort')}
              tone="warn"
              value={copperWords(plan.short)}
            />
          ) : null}
        </div>
      ) : (
        <p className="gear-reach">{plan.refusal}</p>
      )}
      {notes.length === 0 ? null : <p className="gear-reach">{notes.join(' ')}</p>}
      <div className="scroller gear-scroller">
        <ol className="progression gear-stops">
          {plan.stops.map((stop, index) => (
            <li
              data-kind={stop.kind}
              data-progress={progressOf(index)}
              key={`${stop.room}-${index}`}
            >
              <span className="gear-stop-mark" aria-hidden="true">
                <Icon
                  name={
                    progressOf(index) === 'done' ? 'check' : stop.kind === 'bank' ? 'coins' : 'bag'
                  }
                />
              </span>
              <div className="gear-stop">
                <div className="gear-stop-head">
                  <Stop stop={stop} />
                  {stop.place === (stop.kind === 'bank' ? stop.bank : stop.shop) ? null : (
                    <span className="gear-meta">{stop.place}</span>
                  )}
                </div>
                <Leg leg={stop.leg} />
              </div>
            </li>
          ))}
        </ol>
      </div>
      <footer className="gear-bar">
        {running ? (
          <>
            <span className="gear-bar-words">{t('cards.gear.going')}</span>
            <button className="primary destructive" onClick={onStop} type="button">
              <Icon name="stop" /> {t('cards.gear.stop')}
            </button>
          </>
        ) : (
          <>
            <button onClick={onReplan} type="button">
              <Icon name="reset" /> {t('cards.gear.replan')}
            </button>
            <span className="gear-bar-spacer" />
            <button
              disabled={plan.stops.length === 0}
              onClick={() => onGo(true)}
              title={t('cards.gear.runTooltip')}
              type="button"
            >
              <Icon name="run" /> {t('cards.route.runButton')}
            </button>
            <button
              className="primary"
              disabled={plan.stops.length === 0}
              onClick={() => onGo(false)}
              title={t('cards.gear.walkTooltip')}
              type="button"
            >
              <Icon name="route" /> {t('cards.route.walkButton')}
            </button>
          </>
        )}
      </footer>
    </>
  );
}
