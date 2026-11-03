import { Fragment, type ReactNode } from 'react';

import Icon from './Icon';
import PlanFights from './PlanFights';
import EntityName, { RoomName, type Inspect } from './EntityName';
import { copperWords, unpricedWords } from '../lib/gearPicks';
import { t } from '../lib/i18n';
import Sentence, { NameList } from './Sentence';
import { progressAt, type Progress } from '../lib/progression';
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
  /** An item's or spell's name clicked: the realm's answer, beside it. */
  inspect: Inspect | undefined;
  /** Opens the route panel at a stop's room. Null on a pinned float, which cannot. */
  goToRoom: ((room: string) => void) | null;
}

/** What a stop's names open: the realm's answer for a thing, the route panel for its room. */
type Openers = Pick<GearTripFaceProps, 'inspect' | 'goToRoom'>;

function Stop({ stop, inspect, goToRoom }: { stop: GearStop } & Openers) {
  switch (stop.kind) {
    case 'bank':
      return (
        <div className="gear-stop-what">
          <RoomName className="gear-item-name" open={goToRoom} room={stop.room}>
            {stop.bank}
          </RoomName>
          <span className="chip info cased">
            {t('cards.gear.withdraw', { amount: copperWords(stop.withdraw) })}
          </span>
        </div>
      );
    case 'shop':
      return (
        <div className="gear-stop-what">
          <RoomName className="gear-item-name" open={goToRoom} room={stop.room}>
            {stop.shop}
          </RoomName>
          <span className="gear-stop-items">
            {stop.items.map((item) => {
              const name = <EntityName inspect={inspect} key="item" name={item.name} />;
              return (
                <span className="chip cased" key={item.item}>
                  {item.charged === null ? (
                    name
                  ) : (
                    <Sentence
                      parts={{ item: name, price: copperWords(item.charged) }}
                      text={t('cards.gear.itemPrice')}
                    />
                  )}
                </span>
              );
            })}
          </span>
        </div>
      );
    default: {
      const never: never = stop;
      return never;
    }
  }
}

function Leg({ leg, inspect }: { leg: GearLeg; inspect: Inspect | undefined }) {
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
          <Sentence
            parts={{
              items: (
                <NameList
                  draw={(item) => <EntityName inspect={inspect} name={item.name} />}
                  items={leg.needs}
                />
              )
            }}
            text={t('cards.gear.legNeeds')}
          />
        </span>
      )}
      {leg.walls.map((wall, index) => (
        <span className="chip bad cased" key={`wall-${index}`}>
          {describeBlock(wall)}
        </span>
      ))}
      {leg.hazards.map((hazard) => (
        <span className="chip warn cased" key={`hazard-${hazard.id}`}>
          <Sentence
            parts={{
              spell: <EntityName inspect={inspect} name={hazard.spell} />,
              rooms: hazard.rooms
            }}
            text={t('cards.gear.legHazard')}
          />
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

export default function GearTripFace({
  plan,
  trip,
  onGo,
  onStop,
  onReplan,
  inspect,
  goToRoom
}: GearTripFaceProps) {
  const running = trip !== null && trip.stage !== 'ended' && trip.plan === plan;
  const progressOf = (index: number): Progress => (running ? progressAt(index, trip.stop) : 'left');
  const notes: ReactNode[] = [
    unpricedWords(plan.unpriced),
    plan.purse === null ? t('cards.gear.tripPurseUnread') : '',
    plan.stops.some((stop) => stop.leg.blocked !== null) ? t('cards.gear.tripBlocked') : '',
    plan.left.length === 0 ? (
      ''
    ) : (
      <Sentence
        parts={{
          items: (
            <NameList
              draw={(left) => (
                <Sentence
                  parts={{ item: <EntityName inspect={inspect} name={left.name} /> }}
                  text={
                    left.why === 'not-sold'
                      ? t('cards.gear.leftNotSold')
                      : t('cards.gear.leftUnreachable')
                  }
                />
              )}
              items={plan.left}
            />
          )
        }}
        text={t('cards.gear.tripLeft')}
      />
    ),
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
      {notes.length === 0 ? null : (
        <p className="gear-reach">
          {notes.map((note, at) => (
            <Fragment key={at}>
              {at === 0 ? null : ' '}
              {note}
            </Fragment>
          ))}
        </p>
      )}
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
                  <Stop goToRoom={goToRoom} inspect={inspect} stop={stop} />
                  {stop.place === (stop.kind === 'bank' ? stop.bank : stop.shop) ? null : (
                    <RoomName className="gear-meta" open={goToRoom} room={stop.room}>
                      {stop.place}
                    </RoomName>
                  )}
                </div>
                <Leg inspect={inspect} leg={stop.leg} />
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
