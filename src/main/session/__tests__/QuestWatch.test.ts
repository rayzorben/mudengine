import { describe, expect, it } from 'vitest';

import { QuestWatch } from '../QuestWatch';
import type { CharacterTracker } from '../../parse/CharacterTracker';
import type { Quest, QuestStep, QuestWatched } from '../../../shared/quests';
import { NOTHING_WATCHED, type QuestWatchedSink } from '../../../shared/questWatched';

const step = (to: number, who: string, say: string): QuestStep => ({
  block: 100 + to,
  who,
  say: [say],
  from: to - 1,
  to,
  needs: [],
  takes: [],
  gives: []
});

const GOOD: Quest = {
  id: 126,
  name: 'GoodQuest',
  steps: [step(1, 'wounded messenger', 'mission'), step(2, 'Guildmaster', 'messenger')]
};

/** A record as `Belongings` keeps one: what was remembered is what is recalled. */
function record(kept: QuestWatched = NOTHING_WATCHED): QuestWatchedSink & { kept: QuestWatched } {
  return {
    kept,
    recallQuestWatched() {
      return this.kept;
    },
    rememberQuestWatched(watched) {
      this.kept = watched;
    }
  };
}

function watch(): { quests: QuestWatch; pushed: QuestWatched[] } {
  const pushed: QuestWatched[] = [];
  // No room and no listing: the client cannot place the character, so nothing narrows.
  const current = { room: { map: null, room: null }, abilities: null };
  const tracker = { current } as unknown as Pick<CharacterTracker, 'current'>;
  const quests = new QuestWatch(
    { tracker, world: { quests: () => [GOOD] } },
    { questSaid: (watched) => pushed.push(watched) }
  );
  return { quests, pushed };
}

describe('the quest ranks a character was watched reaching', () => {
  it('are kept in the record as each step is watched', () => {
    const { quests } = watch();
    const store = record();
    quests.useStore(store);

    quests.noteSaid('ask wounded messenger mission');

    expect(store.kept[126]?.to).toBe(1);
  });

  // Yang, 2026-11-18: four steps run, the daily disconnect, and 0 of 30 after it.
  it('come back from the record at a reconnect', () => {
    const { quests, pushed } = watch();
    quests.useStore(record());
    quests.noteSaid('ask wounded messenger mission');
    quests.noteSaid('ask Guildmaster messenger');
    expect(quests.watched[126]?.to).toBe(2);

    quests.reset();

    expect(quests.watched[126]?.to).toBe(2);
    expect(pushed.at(-1)?.[126]?.to).toBe(2);
  });

  it('are handed to the card when a record that kept some is taken up', () => {
    const { quests, pushed } = watch();

    quests.useStore(record({ 126: { to: 2, at: 5 } }));

    expect(quests.watched).toEqual({ 126: { to: 2, at: 5 } });
    expect(pushed).toEqual([{ 126: { to: 2, at: 5 } }]);
  });

  it('go when the record is forgotten, and the card is told', () => {
    const { quests, pushed } = watch();
    const store = record();
    quests.useStore(store);
    quests.noteSaid('ask wounded messenger mission');
    expect(quests.watched[126]?.to).toBe(1);

    store.kept = NOTHING_WATCHED;
    quests.reset();

    expect(quests.watched).toEqual({});
    expect(pushed.at(-1)).toEqual({});
  });

  it('say nothing to the card when an empty record replaces an empty one', () => {
    const { quests, pushed } = watch();

    quests.useStore(record({}));
    quests.reset();

    expect(pushed).toEqual([]);
  });
});
