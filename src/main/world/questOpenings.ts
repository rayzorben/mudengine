/**
 * Which room commands and exits each quest counter lets through, and at what
 * rank and level (realm format 71, todo 155). An exit's gates are read by
 * `navigation/exitGates.ts` and a room command's are the ones `roomScript.ts`
 * read through `navigation/textblock.ts`, so the engine's one reading of a
 * gate decides what is indexed. What counts as a quest's reward is
 * `questOpens` in `src/shared/quests.ts`. See `mudengine-world` ›
 * `parts/quests.md`.
 */
import { parseInstruction } from './instructions';
import { exitGates } from './navigation/exitGates';
import type { BuiltItemFrom } from './indexQuests';
import type { Gate } from '../../shared/gates';
import { routesOf, type Quest } from '../../shared/quests';
import type { QuestOpening } from '../../shared/questOpenings';
import type { RoomCommand } from '../../shared/world';

/** One way a counter lets through, before it is told which quest is whose. */
export interface CounterOpening {
  counter: number;
  opening: QuestOpening;
}

/** A room as the converter holds it: its address, its commands and its exits. */
export interface OpeningRoom {
  here: string;
  commands: readonly RoomCommand[];
  exits: Readonly<Record<string, { m: number; r: number; i?: string }>>;
}

/**
 * Every way out of one room, command or exit, whose gate wants a counter at
 * some rank. A gate that wants the counter absent or below a rank shuts the
 * way as the quest goes on, so it opens nothing and is left out.
 */
export function openingsIn({ here, commands, exits }: OpeningRoom): CounterOpening[] {
  const found: CounterOpening[] = [];
  for (const command of commands) {
    const to = command.to === undefined ? {} : { to: command.to };
    for (const { counter, bounds } of ranked(command.gates ?? []))
      found.push({
        counter,
        opening: {
          kind: 'command',
          say: command.say,
          room: here,
          ...to,
          ...bounds,
          ...levelOf(command.gates ?? [])
        }
      });
  }
  for (const [direction, exit] of Object.entries(exits)) {
    const requirement = parseInstruction(exit.i);
    if (requirement === null) continue;
    const gates = exitGates(requirement) ?? [];
    for (const { counter, bounds } of ranked(gates))
      found.push({
        counter,
        opening: {
          kind: 'exit',
          direction,
          room: here,
          to: `${exit.m}/${exit.r}`,
          ...bounds,
          ...levelOf(gates)
        }
      });
  }
  return found;
}

/** The counter gates of one line that want a rank, with their bounds. */
function ranked(
  gates: readonly Gate[]
): Array<{ counter: number; bounds: { atLeast: number; atMost?: number } }> {
  return gates.flatMap((gate) =>
    gate.kind === 'ability' && gate.absent !== true && (gate.atLeast ?? 0) >= 1
      ? [
          {
            counter: gate.id,
            bounds: {
              atLeast: gate.atLeast ?? 0,
              ...(gate.atMost === undefined ? {} : { atMost: gate.atMost })
            }
          }
        ]
      : []
  );
}

/** The line's own lowest level: the highest `minlevel`, as the server runs each. */
function levelOf(gates: readonly Gate[]): { minLevel?: number } {
  const levels = gates.flatMap((gate) => (gate.kind === 'level' ? [gate] : []));
  const mins = levels.flatMap((gate) => (gate.min === undefined ? [] : [gate.min]));
  return {
    ...(mins.length === 0 ? {} : { minLevel: Math.max(...mins) })
  };
}

/**
 * The quests with the ways their counters let through, less the ones on the
 * quest's own way: a command that is one of its steps, one that gives an item
 * a step takes back (MerchantCaptain's `pull crate`, at rank 1, gives the
 * crate rank 2 takes), and a way into a room one of its steps is in.
 */
export function withOpenings(
  quests: readonly Quest[],
  found: readonly CounterOpening[],
  handovers: ReadonlyMap<number, readonly BuiltItemFrom[]>
): Quest[] {
  const byCounter = new Map<number, QuestOpening[]>();
  const seen = new Set<string>();
  for (const { counter, opening } of found) {
    const key = JSON.stringify([counter, opening]);
    if (seen.has(key)) continue;
    seen.add(key);
    const held = byCounter.get(counter);
    if (held === undefined) byCounter.set(counter, [opening]);
    else held.push(opening);
  }
  return quests.map((quest) => {
    const opens = (byCounter.get(quest.id) ?? []).filter((way) => !onOwnWay(quest, way, handovers));
    return opens.length === 0 ? quest : { ...quest, opens };
  });
}

/** Whether a way is one the quest's own steps go on to use. */
function onOwnWay(
  quest: Quest,
  way: QuestOpening,
  handovers: ReadonlyMap<number, readonly BuiltItemFrom[]>
): boolean {
  if (way.to !== undefined && quest.steps.some((step) => step.room === way.to)) return true;
  if (way.kind === 'exit') return false;
  const { room, say } = way;
  const said = (phrases: readonly string[] | undefined): boolean =>
    (phrases ?? []).some((phrase) => say.includes(phrase));
  if (quest.steps.some((step) => step.room === room && said(step.say))) return true;
  const taken = quest.steps.flatMap(routesOf).flatMap((way) => way.takes);
  return taken.some(({ id }) =>
    (handovers.get(id) ?? []).some(
      (from) => from.k === 'room' && from.at === room && said(from.say)
    )
  );
}
