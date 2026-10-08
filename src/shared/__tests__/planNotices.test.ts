import { describe, expect, it } from 'vitest';

import type { GearTripProgress } from '../gearTrip';
import { gearTripNotices, questRunNotices } from '../planNotices';
import { IDLE_QUEST_RUN, type QuestRunProgress } from '../quests';

const running: QuestRunProgress = { ...IDLE_QUEST_RUN, status: 'running', name: 'Dao Lord' };
const done: QuestRunProgress = { ...running, status: 'done', reason: 'Dao Lord reached rank 2' };

const trip = (over: Partial<GearTripProgress>): GearTripProgress => ({
  plan: { from: '1/1', stops: [], moves: 0, owed: 0, unpriced: 0, purse: null, short: 0, left: [] },
  stop: 0,
  stage: 'walking',
  run: false,
  bought: [],
  missed: [],
  ended: null,
  done: false,
  ...over
});

/* The legs of a plan are walks nobody asked for; its end is the arrival. */
describe('a plan the player started, finishing', () => {
  it('raises an arrival when a quest run is done, once', () => {
    const raised = questRunNotices(running, done, 5);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.event).toBe('arrived');
    expect(raised[0]!.desktop).toBe('arrived');
    expect(raised[0]!.text).toBe(done.reason);
    expect(questRunNotices(done, done, 6)).toHaveLength(0);
  });

  it('says nothing for a quest run stopped on the way', () => {
    const stopped = { ...running, status: 'stopped' as const, reason: 'a shut door' };
    expect(questRunNotices(running, stopped, 7)).toHaveLength(0);
  });

  it('raises an arrival when a gear trip serves every stop, once', () => {
    const ended = trip({ stage: 'ended', ended: 'Bought 2 of 2', done: true });
    const raised = gearTripNotices(trip({}), ended, 8);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.event).toBe('arrived');
    expect(raised[0]!.text).toBe('Bought 2 of 2');
    expect(gearTripNotices(ended, ended, 9)).toHaveLength(0);
  });

  it('says nothing for a gear trip stopped on the way', () => {
    const stopped = trip({ stage: 'ended', ended: 'Stopped' });
    expect(gearTripNotices(trip({}), stopped, 10)).toHaveLength(0);
  });
});
