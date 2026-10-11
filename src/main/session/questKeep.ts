/**
 * The realm's quests and the character's counters bound into the `QuestKeep`
 * the paths that drop or sell an item are handed (todo 52): the items each
 * quest the character can still do needs, rebuilt only when the book, the
 * `abil` listing, what was watched since, or the sheet's class, race or level
 * changes. The rule is `src/shared/questKeep.ts`.
 */
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { WorldGraph } from '../world/WorldGraph';
import type { QuestWatch } from './QuestWatch';
import type { AbilitySums } from '../../shared/character';
import {
  countersNow,
  questReading,
  type Quest,
  type QuestDoer,
  type QuestWatched
} from '../../shared/quests';
import { itemsQuestsWant, keptFor, type QuestKeep } from '../../shared/questKeep';

export interface QuestKeepModules {
  world: Pick<WorldGraph, 'quests'> | undefined;
  tracker: Pick<CharacterTracker, 'current'>;
  questWatch: Pick<QuestWatch, 'watched'>;
}

interface Built {
  quests: readonly Quest[];
  abilities: AbilitySums | null;
  watched: QuestWatched;
  className: string | null;
  race: string | null;
  level: number | null;
  wanted: Map<number, string>;
}

export function questKeep(modules: () => QuestKeepModules): QuestKeep {
  let built: Built | null = null;
  const wanted = (): Map<number, string> => {
    const { world, tracker, questWatch } = modules();
    const quests = world?.quests() ?? [];
    const state = tracker.current;
    const abilities = state.abilities ?? null;
    const watched = questWatch.watched;
    const { className, race } = state;
    const level = state.progress.level ?? null;
    // The book, the listing and what was watched are replaced, never edited,
    // so a changed one is a new reference; the sheet's three are values.
    if (
      built?.quests === quests &&
      built.abilities === abilities &&
      built.watched === watched &&
      built.className === className &&
      built.race === race &&
      built.level === level
    ) {
      return built.wanted;
    }
    const counters = countersNow(abilities, watched);
    const standing = (quest: Quest) => questReading(quest.id, counters, watched);
    const who: QuestDoer = { className, race, level, counters };
    const wanted = itemsQuestsWant(quests, standing, who);
    built = { quests, abilities, watched, className, race, level, wanted };
    return built.wanted;
  };
  return { wantedBy: (item) => keptFor(wanted(), item) };
}
