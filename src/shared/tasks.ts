/**
 * The automations a player switches on for one character from the
 * Automations card, and what each one says about itself. A task runs until
 * it finishes or is switched off, and the switch lasts only as long as the
 * session: a task that ends itself (the last spade gone) has nothing to come
 * back on to. See `mudengine-automation` › `parts/errands.md` › *A task is
 * switched on from the Automations card*.
 */

/** Every task, in the order the card lists them. */
export const TASK_IDS = ['treasure-dig'] as const;
export type TaskId = (typeof TASK_IDS)[number];

/** The id, or null for anything else (the IPC boundary). */
export function asTaskId(value: unknown): TaskId | null {
  return TASK_IDS.find((id) => id === value) ?? null;
}

/**
 * Where the treasure dig stands. `counting` is an `i` owed before the next
 * dig; `fighting` is auto-combat clearing the room; `unfought` is a monster
 * here that nothing will attack, so the dig waits; `unswitched` is the master
 * switch or auto-combat off; `no-ground` is a room without the disturbed
 * ground; `done` is no spade left; `refused` is the server refusing a dig
 * with spades in the pack.
 */
export type DigStatus =
  | 'off'
  | 'counting'
  | 'digging'
  | 'fighting'
  | 'unfought'
  | 'resting'
  | 'climbing'
  | 'unswitched'
  | 'no-ground'
  | 'done'
  | 'refused';

/** The treasure dig as the card draws it. */
export interface DigView {
  id: 'treasure-dig';
  on: boolean;
  status: DigStatus;
  /** Spades the last listing held; null before one. */
  spades: number | null;
  /** Digs the server answered this run. */
  dug: number;
  /** What the digs turned up, newest last, as the server named each. */
  finds: string[];
  /** Falls into a pit this run. */
  falls: number;
  /** The monsters an `unfought` wait is on, or the line a `refused` stop read. */
  detail: string | null;
}

export type TaskView = DigView;

/** No task has run: the card's first draw, and a reset. */
export const NO_TASKS: readonly TaskView[] = [];
