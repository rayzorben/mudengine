/**
 * Where a realm row comes from, as places to walk to: the shops that sell an
 * item and the scripts that hand one over or teach a spell. Shared by an
 * item's detail and a spell's (`SpellLearning`), so the two draw one way.
 */
import { Fragment } from 'react';
import { t } from '../lib/i18n';
import { coinText } from '../lib/coins';
import { copperSpread } from '@shared/coins';
import { asRoomReference } from '@shared/world';
import type { ItemHandover, ShopPlace } from '@shared/world';

/**
 * The shops that sell this, each one a **place** rather than a word.
 *
 * `Sold by: General Store, Newhaven General Store, …` was the client printing
 * an entity as its string representation: a shop is a room, the realm knows
 * which room, and the only thing anybody wants to do with the answer is go
 * there. Each name whose shop sits in exactly one room is a `button.lookup`
 * opening the route panel — the same control, the same callback and the same
 * panel a room clicked on the map opens, because there is one surface for
 * *how do I get to that place* and this is it.
 *
 * A shop in several rooms says so and stays text. Picking one would send a
 * character to whichever of six trainers the realm file listed first, a
 * wrong place shown as certain.
 * A shop the realm places nowhere is text too, with nothing added: the name is
 * still what the realm said sells the thing.
 */
export function SoldBy({
  shops,
  places,
  onRoom
}: {
  shops: readonly string[];
  places: Record<string, ShopPlace>;
  onRoom: ((map: number, room: number) => void) | null;
}) {
  return (
    <dd>
      {shops.map((shop, index) => {
        const place = places[shop.trim().toLowerCase()];
        return (
          <Fragment key={`${shop}-${index}`}>
            {index > 0 && ', '}
            {place?.at === 'one' && onRoom !== null ? (
              <button
                className="lookup"
                onClick={() => onRoom(place.map, place.room)}
                title={t('cards.reference.item.shopRouteTitle', { room: place.roomName })}
                type="button"
              >
                {shop}
              </button>
            ) : (
              <>
                {shop}
                {place?.at === 'several' && (
                  <span className="quiet">
                    {' '}
                    {t('cards.reference.item.shopPlaces', { count: place.count })}
                  </span>
                )}
              </>
            )}
          </Fragment>
        );
      })}
    </dd>
  );
}

/**
 * Where the realm's own scripts hand this over — format 39.
 *
 * The third answer beside `Sold by` and `Dropped by`, and the one the realm
 * states as an **act** rather than as a list: a monster to kill, a word to say
 * in a room, a word to ask somebody for. Each one is drawn as the two controls
 * the act is made of — the monster opens beside the name like every other
 * realm name here, and the room opens the route panel like a shop's does — so
 * *what is this* and *how do I get one* are one panel and two clicks.
 *
 * The words are monospace, because they are the line that goes in the console:
 * the same register `.quest-ask` uses, and for the same reason. A monster's
 * death has none — nothing is typed to make it happen.
 *
 * Where the realm places nobody, the name and words are plain text with
 * nothing to click.
 */
export function GivenBy({
  from,
  onRoom,
  onName
}: {
  from: readonly ItemHandover[];
  onRoom: ((map: number, room: number) => void) | null;
  onName: ((name: string, anchor: HTMLElement) => void) | null;
}) {
  return (
    <dd className="item-given">
      {from.map((handover, index) => {
        const at = handover.room === undefined ? null : asRoomReference(handover.room);
        const place = handover.place ?? handover.room;
        const who =
          handover.who === undefined ? null : onName === null ? (
            <span>{handover.who}</span>
          ) : (
            <button
              className="lookup"
              onClick={(event) => onName(handover.who ?? '', event.currentTarget)}
              type="button"
            >
              {handover.who}
            </button>
          );
        return (
          <span className="handover" key={`${handover.kind}-${handover.who ?? ''}-${index}`}>
            {handover.kind === 'killed' && <>{t('cards.reference.item.givenKilling')} </>}
            {handover.kind === 'asked' && <>{t('cards.reference.item.givenAsking')} </>}
            {handover.kind === 'said' && <>{t('cards.reference.item.givenSaying')} </>}
            {who}
            {handover.say !== undefined && handover.say.length > 0 && (
              <>
                {handover.kind === 'asked' && <> {t('cards.reference.item.givenAskingFor')}</>}{' '}
                <code className="handover-say">{handover.say[0]}</code>
                {handover.say.length > 1 && (
                  <span
                    className="quiet"
                    title={handover.say.slice(1).join(', ')}
                  >{` ${t('cards.reference.item.givenMoreWords', { count: handover.say.length - 1 })}`}</span>
                )}
              </>
            )}
            {handover.price !== undefined && (
              <>
                {' '}
                {t('cards.reference.item.givenFor', {
                  price: coinText(copperSpread(handover.price), 1)
                })}
              </>
            )}
            {place !== undefined && (
              <>
                {' '}
                {t('cards.reference.item.givenIn')}{' '}
                {at !== null && onRoom !== null ? (
                  <button
                    className="lookup"
                    onClick={() => onRoom(at.map, at.room)}
                    title={t('cards.reference.item.shopRouteTitle', { room: place })}
                    type="button"
                  >
                    {place}
                  </button>
                ) : (
                  place
                )}
              </>
            )}
          </span>
        );
      })}
    </dd>
  );
}
