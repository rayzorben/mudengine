/**
 * The level wall on the way to each quest's next reward, asked of main
 * (`Invoke.questReach`, todo 132) when the level, the marks or the counters
 * change, never on a move: a wall is a property of the realm and the level,
 * and the room the character stands in only picks which way is cheapest. A
 * re-ask keeps the last answer on screen until the new one lands. See
 * `mudengine-ui` › `parts/quests.md`.
 */
import { useEffect, useMemo, useState } from 'react';
import type { AbilitySums } from '@shared/character';
import type { LoadQuestReach, QuestReachAnswer, QuestWatched } from '@shared/quests';
import { errorMessage } from '@shared/values';

/** What the book's ask reads: the marks, and the facts a wall depends on. */
export interface QuestReachAsk {
  load: LoadQuestReach | null | undefined;
  ids: readonly string[];
  marked(id: string): number | null;
  level: number | null;
  counters: AbilitySums | null;
  said: QuestWatched | null;
  /**
   * Whether the character is placed, and when the realm loaded: main answers
   * unknown before either, so each change asks again. Placement changes once,
   * so a move still asks nothing.
   */
  placed: boolean;
  realmAt: number;
}

export function useQuestReach({
  load,
  ids,
  marked,
  level,
  counters,
  said,
  placed,
  realmAt
}: QuestReachAsk): Readonly<QuestReachAnswer> {
  const [reach, setReach] = useState<Readonly<QuestReachAnswer>>({});
  // By value: the marks are read through a getter rebuilt on every render.
  const marks = ids.flatMap((id) => {
    const rank = marked(id);
    return rank === null ? [] : [[Number(id), rank] as const];
  });
  const key = JSON.stringify(marks);
  // And the counters by value: `abilities` is a new object on every character
  // push, every prompt included, and each re-ask restarts main's routes.
  const facts = JSON.stringify([counters, said]);
  const asked = useMemo(
    () => Object.fromEntries(JSON.parse(key) as Array<[number, number]>),
    [key]
  );
  useEffect(() => {
    if (!load) return;
    let live = true;
    void load(asked)
      .then((answer) => {
        // Null is unknown (no realm, nowhere placed): no wall is claimed.
        if (live) setReach(answer ?? {});
      })
      .catch((error) => {
        // The script's own gates still shelve the book; the way's walls go missing.
        console.error(`[quests] the level walls on the way: ${errorMessage(error)}`);
      });
    return () => {
      live = false;
    };
  }, [load, asked, level, facts, placed, realmAt]);
  return reach;
}
