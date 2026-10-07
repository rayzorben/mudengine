import PlanFights from './PlanFights';
import { copperWords, unpricedWords } from '../lib/gearPicks';
import { t } from '../lib/i18n';
import type { GearLeg, GearStop, GearTripPlan, GearTripProgress } from '@shared/gearTrip';
import { describeBlock } from '@shared/world';

/**
 * The Gear card's trip: the vaults and counters in walking order, each leg
 * with what it meets (fights with this character's odds, what the rooms
 * cast, doors it cannot pass, keys a way wants fetched), shown and never a
 * reason to refuse; then *Run it* or *Walk it*, the route panel's two
 * presses, and *Stop* while it goes. The stops wear the progression grammar.
 */
export interface GearTripFaceProps {
  plan: GearTripPlan;
  trip: GearTripProgress | null;
  onGo(run: boolean): void;
  onStop(): void;
  onReplan(): void;
}

const copper = copperWords;

function stopTitle(stop: GearStop): string {
  switch (stop.kind) {
    case 'bank':
      return t('cards.gear.stopBank', { bank: stop.bank, amount: copper(stop.withdraw) });
    case 'shop':
      return t('cards.gear.stopShop', {
        shop: stop.shop,
        items: stop.items
          .map((item) =>
            item.charged === null ? item.name : `${item.name} (${copper(item.charged)})`
          )
          .join(', ')
      });
    default: {
      const never: never = stop;
      return never;
    }
  }
}

function Leg({ leg }: { leg: GearLeg }) {
  return (
    <div className="gear-leg">
      <span className="aside">
        {leg.steps === null
          ? t('cards.gear.legNoWay')
          : leg.steps === 1
            ? t('cards.gear.legSteps.one')
            : t('cards.gear.legSteps.many', { steps: leg.steps })}
      </span>
      {leg.blocked === null ? null : <span className="chip bad">{leg.blocked}</span>}
      {leg.needs.length === 0 ? null : (
        <span className="chip warn">
          {t('cards.gear.legNeeds', { items: leg.needs.map((item) => item.name).join(', ') })}
        </span>
      )}
      {leg.walls.map((wall, index) => (
        <span className="chip bad" key={`wall-${index}`}>
          {describeBlock(wall)}
        </span>
      ))}
      {leg.hazards.map((hazard) => (
        <span className="chip warn" key={`hazard-${hazard.id}`}>
          {t('cards.gear.legHazard', { spell: hazard.spell, rooms: hazard.rooms })}
        </span>
      ))}
      <PlanFights fights={leg.fights} />
    </div>
  );
}

export default function GearTripFace({ plan, trip, onGo, onStop, onReplan }: GearTripFaceProps) {
  const running = trip !== null && trip.stage !== 'ended' && trip.plan === plan;
  const progressOf = (index: number): 'done' | 'now' | 'left' =>
    !running ? 'left' : index < trip.stop ? 'done' : index === trip.stop ? 'now' : 'left';
  return (
    <>
      <div className="gear-head">
        <span className="hunt-note">
          {plan.refusal ??
            [
              plan.stops.length === 1
                ? t('cards.gear.tripSummary.one', { moves: plan.moves, owed: copper(plan.owed) })
                : t('cards.gear.tripSummary.many', {
                    stops: plan.stops.length,
                    moves: plan.moves,
                    owed: copper(plan.owed)
                  }),
              unpricedWords(plan.unpriced),
              plan.purse === null ? t('cards.gear.tripPurseUnread') : '',
              plan.stops.some((stop) => stop.leg.blocked !== null)
                ? t('cards.gear.tripBlocked')
                : '',
              plan.short > 0 ? t('cards.gear.tripShort', { short: copper(plan.short) }) : '',
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
                  })
            ]
              .filter((part) => part !== '')
              .join(' ')}
        </span>
        {trip?.ended === null || trip === null ? null : (
          <span className="hunt-note">{trip.ended}</span>
        )}
      </div>
      <div className="scroller progression-scroller">
        <ol className="progression gear-stops">
          {plan.stops.map((stop, index) => (
            <li data-progress={progressOf(index)} key={`${stop.room}-${index}`}>
              <div>
                <b>{stopTitle(stop)}</b> <span className="aside">{stop.place}</span>
              </div>
              <Leg leg={stop.leg} />
            </li>
          ))}
        </ol>
      </div>
      <div className="loop-controls gear-actions">
        {running ? (
          <button className="danger" onClick={onStop} type="button">
            {t('cards.gear.stop')}
          </button>
        ) : (
          <>
            <button onClick={onReplan} type="button">
              {t('cards.gear.replan')}
            </button>
            <button
              className="route-run"
              disabled={plan.stops.length === 0}
              onClick={() => onGo(true)}
              title={t('cards.gear.runTooltip')}
              type="button"
            >
              {t('cards.route.runButton')}
            </button>
            <button
              className="primary"
              disabled={plan.stops.length === 0}
              onClick={() => onGo(false)}
              title={t('cards.gear.walkTooltip')}
              type="button"
            >
              {t('cards.route.walkButton')}
            </button>
          </>
        )}
      </div>
    </>
  );
}
