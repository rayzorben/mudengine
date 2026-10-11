/**
 * Which carried items a quest the character has not finished still needs
 * (todo 52), so the paths that part with an item (`AutoDrop`, `OutgrownGear`,
 * `SellTrip`) keep it and say why. Pure; `session/questKeep.ts` binds it to
 * the realm's quests and the character's counters. See `mudengine-automation`
 * › `parts/gear.md`.
 */
import type { Numbered } from './entities';
import {
  classKnown,
  ownWay,
  questBars,
  stepDone,
  type Quest,
  type QuestDoer,
  type QuestStanding,
  type QuestStep,
  type QuestWay
} from './quests';

/** What a path that parts with an item asks before it does. */
export interface QuestKeep {
  /** The name of a quest the character has not finished that needs this item, or null. */
  wantedBy(item: Numbered): string | null;
}

/** The items one route asks for: a `checkitem` and a `takeitem`. */
function routeItems(route: QuestStep | QuestWay): number[] {
  const carried = route.needs.flatMap((gate) => (gate.kind === 'carry' ? [gate.item] : []));
  return [...carried, ...route.takes.map((item) => item.id)];
}

/**
 * Whether a quest is shut to this character for good: a class, race or
 * counter bar on its next rank. A level bar is one the character walks out
 * of, so its items stay.
 */
function shutForGood(quest: Quest, who: QuestDoer, standing: QuestStanding): boolean {
  return questBars(quest, who, standing).some((bar) => bar.kind !== 'level');
}

/**
 * A step's own items and those of each route this character may take: once
 * the class is known, a route gated on another class is not theirs.
 */
function stepItems(step: QuestStep, className: string | null): number[] {
  const ways = (step.ways ?? []).filter(
    (way) =>
      !classKnown(className) ||
      !way.needs.some((gate) => gate.kind === 'class') ||
      ownWay(way, className)
  );
  return [step, ...ways].flatMap(routeItems);
}

/**
 * Each item a step not yet behind the character asks for, by row, with the
 * first quest that asks. A `floor` gate is left out: both shipped realms use
 * it for a fixture (an altar, a portal), never a thing carried there.
 *
 * A quest a class, race or counter bar shuts for good keeps nothing, and a
 * known class keeps only its own route (todo 52, open question 1). Unknown is
 * the unsafe case: an unknown class, race, listing or rank bars nothing and
 * leaves every step ahead, so it keeps every item.
 */
export function itemsQuestsWant(
  quests: readonly Quest[],
  standing: (quest: Quest) => QuestStanding,
  who: QuestDoer
): Map<number, string> {
  const wanted = new Map<number, string>();
  for (const quest of quests) {
    const where = standing(quest);
    if (shutForGood(quest, who, where)) continue;
    for (const step of quest.steps) {
      if (stepDone(step, where.rank, where.held)) continue;
      for (const id of stepItems(step, who.className)) {
        if (!wanted.has(id)) wanted.set(id, quest.name);
      }
    }
  }
  return wanted;
}

/**
 * The quest that keeps this item, by any row it may be: the row a room
 * settled, else every row its name belongs to. A name shared by a quest
 * item and another row is kept, since which one is carried is unknown.
 */
export function keptFor(wanted: ReadonlyMap<number, string>, item: Numbered): string | null {
  const rows =
    item.row !== undefined ? [item.row.id] : (item.ids ?? (item.id === undefined ? [] : [item.id]));
  for (const row of rows) {
    const quest = wanted.get(row);
    if (quest !== undefined) return quest;
  }
  return null;
}
