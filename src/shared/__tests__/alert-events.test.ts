import { describe, expect, it } from 'vitest';

import {
  ALERT_EVENTS,
  ALERT_EVENT_NAMES,
  ALERT_WATCHES,
  NOTABLE,
  alertEvent,
  eventOfBlock,
  eventOfWatch,
  isAlertEvent
} from '../notifications';
import type { BlockType } from '../blocks';

/*
 * The events the player reads and the table that decides what a notice costs
 * are two halves of one fact, and they are written in two places. This is the
 * pairing that stops them drifting: an event naming a type nothing ranks could
 * never fire, and a ranked type no event names is a happening the settings
 * screen cannot ask about at all -- which is exactly the complaint the channel
 * picker was (todo 03).
 */
describe('the alert events, against the table that ranks them', () => {
  const ranked = Object.keys(NOTABLE) as BlockType[];
  const named = ALERT_EVENT_NAMES.flatMap((name) => alertEvent(name).types);

  it('names every block type the client ranks', () => {
    const missing = ranked.filter((type) => !named.includes(type));
    expect(missing).toEqual([]);
  });

  it('names no block type the client does not rank', () => {
    const unranked = named.filter((type) => NOTABLE[type] === undefined);
    expect(unranked).toEqual([]);
  });

  /* A type in two events would make *which row claims it* depend on table order. */
  it('names each block type exactly once', () => {
    const seen = new Set<BlockType>();
    const twice = named.filter((type) => (seen.has(type) ? true : (seen.add(type), false)));
    expect(twice).toEqual([]);
  });

  /* The channel is what the card's chips filter on, so an event's channel has
     to be the one its own blocks carry, or a row and a chip disagree. */
  it('gives each event the channel its own blocks carry', () => {
    const wrong = ALERT_EVENT_NAMES.filter((name) => {
      const spec = alertEvent(name);
      return spec.types.some((type) => NOTABLE[type]?.channel !== spec.channel);
    });
    expect(wrong).toEqual([]);
  });

  it('covers every watch, so nothing the client watches is unaskable', () => {
    const uncovered = ALERT_WATCHES.filter((watch) => eventOfWatch(watch) === null);
    expect(uncovered).toEqual([]);
  });

  /* A watched event reads off a hook rather than a block, so it must not claim
     block types as well: the notice would then be claimed twice. */
  it('gives a watched event no block types of its own', () => {
    const both = ALERT_EVENT_NAMES.filter((name) => {
      const spec = alertEvent(name);
      return spec.watch !== undefined && spec.types.length > 0;
    });
    expect(both).toEqual([]);
  });

  it('finds the event a block is', () => {
    expect(eventOfBlock('user-dies')).toBe('died');
    expect(eventOfBlock('player-arrives-room')).toBe('player-arrives');
    // A type the client parses but does not rank is no event.
    expect(eventOfBlock('command-no-effect')).toBeNull();
  });

  it('knows its own names and nothing else', () => {
    expect(isAlertEvent('died')).toBe(true);
    expect(isAlertEvent('combat')).toBe(false);
    expect(isAlertEvent('')).toBe(false);
  });

  /* Only a numeric event may be one-sided or a percentage: both describe a
     figure, and on a row with no figure they would be settings nothing reads. */
  it('states a measure only where there is a figure to measure', () => {
    const wrong = ALERT_EVENT_NAMES.filter((name) => {
      const spec = alertEvent(name);
      const numeric = spec.metric === 'figure';
      return (!numeric && (spec.percent === true || spec.oneSided === true)) || false;
    });
    expect(wrong).toEqual([]);
  });

  it('has a spec for every name and no name without one', () => {
    expect(ALERT_EVENT_NAMES.length).toBe(Object.keys(ALERT_EVENTS).length);
  });
});
