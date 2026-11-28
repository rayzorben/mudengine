import { Fragment, type ReactNode } from 'react';

import EntityName, { RoomName, type Inspect } from './EntityName';
import { Figure, Leg } from './GearTripFace';
import Icon from './Icon';
import Sentence, { NameList } from './Sentence';
import { copperWords } from '../lib/gearPicks';
import { t } from '../lib/i18n';
import { progressAt, type Progress } from '../lib/progression';
import { compact } from '../lib/rates';
import { keptWords } from '../lib/sellWords';
import { countedLabel } from '@shared/items';
import type { SellLeft, SellRunPlan, SellRunProgress, SellStop } from '@shared/sellRun';

/**
 * A sell run's plan: its figures at the head (stops, steps, what the sales
 * pay, rounds), then every stop in walking order as a stepper. A floor stop
 * says what is picked up there, a counter what it buys and for how much, each
 * with what the walk there meets. *Sell* sets off and *Stop* ends it. The
 * stops wear the progression grammar, as the Gear card's trip does.
 */
export interface SellRunViewProps {
  plan: SellRunPlan;
  run: SellRunProgress | null;
  onGo(): void;
  onStop(): void;
  /** Back to the rows, to pick again. */
  onBack(): void;
  inspect: Inspect | undefined;
  /** Opens the route panel at a stop's room. Null on a pinned float, which cannot. */
  goToRoom: ((room: string) => void) | null;
}

/** Why a picked item has no stop, after its name. */
function leftWords(why: SellLeft): string {
  switch (why) {
    case 'unreachable':
      return t('cards.sell.left.unreachable');
    case 'too-many-rounds':
      return t('cards.sell.left.tooManyRounds');
    case 'too-heavy':
      return t('cards.sell.left.tooHeavy');
    case 'not-carried':
      return t('cards.sell.left.notCarried');
    case 'not-here':
      return t('cards.sell.left.notHere');
    default:
      return keptWords(why, undefined);
  }
}

function Stop({
  stop,
  inspect,
  goToRoom
}: { stop: SellStop } & Pick<SellRunViewProps, 'inspect' | 'goToRoom'>) {
  return (
    <div className="gear-stop-what">
      <RoomName className="gear-item-name" open={goToRoom} room={stop.room}>
        {stop.kind === 'shop' ? stop.shop : t('cards.sell.pickUp')}
      </RoomName>
      <span className="gear-stop-items">
        {stop.items.map((item) => {
          const name = (
            <EntityName inspect={inspect} key="item" name={item.name}>
              {countedLabel(item)}
            </EntityName>
          );
          return (
            <span className="chip cased" key={item.item}>
              {stop.kind === 'shop' ? (
                <Sentence
                  parts={{ item: name, price: copperWords(item.copper * item.count) }}
                  text={t('cards.gear.itemPrice')}
                />
              ) : (
                name
              )}
            </span>
          );
        })}
      </span>
    </div>
  );
}

export default function SellRunView({
  plan,
  run,
  onGo,
  onStop,
  onBack,
  inspect,
  goToRoom
}: SellRunViewProps) {
  const ours = run !== null && run.plan === plan;
  const running = ours && run.stage !== 'ended';
  const progressOf = (index: number): Progress => (running ? progressAt(index, run.stop) : 'left');
  const notes: ReactNode[] = [
    plan.stops.some((stop) => stop.leg.blocked !== null) ? t('cards.sell.blocked') : '',
    plan.left.length === 0 ? (
      ''
    ) : (
      <Sentence
        parts={{
          items: (
            <NameList
              draw={(left) => (
                <Sentence
                  parts={{
                    item: <EntityName inspect={inspect} name={left.name} />,
                    why: leftWords(left.why)
                  }}
                  text={t('cards.sell.leftItem')}
                />
              )}
              items={plan.left}
            />
          )
        }}
        text={t('cards.gear.tripLeft')}
      />
    ),
    ours ? (run.ended ?? '') : ''
  ].filter((note) => note !== '');
  return (
    <>
      {plan.refusal === undefined ? (
        <div className="gear-figures">
          <Figure label={t('cards.gear.figureStops')} value={String(plan.stops.length)} />
          <Figure label={t('cards.gear.figureSteps')} value={plan.moves.toLocaleString()} />
          <Figure label={t('cards.sell.figurePays')} value={compact(plan.copper)} />
          {plan.rounds > 1 ? (
            <Figure label={t('cards.sell.figureTrips')} value={String(plan.rounds)} />
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
                    progressOf(index) === 'done'
                      ? 'check'
                      : stop.kind === 'floor'
                        ? 'download'
                        : 'coins'
                  }
                />
              </span>
              <div className="gear-stop">
                <div className="gear-stop-head">
                  <Stop goToRoom={goToRoom} inspect={inspect} stop={stop} />
                  <RoomName className="gear-meta" open={goToRoom} room={stop.room}>
                    {stop.place}
                  </RoomName>
                </div>
                <Leg inspect={inspect} leg={stop.leg} />
              </div>
            </li>
          ))}
        </ol>
      </div>
      <footer className="sell-bar">
        {running ? (
          <>
            <span className="gear-bar-words">{t('cards.sell.going')}</span>
            <span className="gear-bar-spacer" />
            <button
              className="primary destructive"
              data-action="sell-stop"
              onClick={onStop}
              type="button"
            >
              <Icon name="stop" /> {t('cards.gear.stop')}
            </button>
          </>
        ) : (
          <>
            <button data-action="sell-back" onClick={onBack} type="button">
              <Icon name="reset" /> {t('cards.sell.back')}
            </button>
            <span className="gear-bar-spacer" />
            <button
              className="primary"
              data-action="sell-go"
              disabled={plan.stops.length === 0}
              onClick={onGo}
              type="button"
            >
              <Icon name="coins" /> {t('cards.sell.go')}
            </button>
          </>
        )}
      </footer>
    </>
  );
}
