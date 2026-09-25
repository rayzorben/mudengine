/**
 * The walk's test fixture, one definition each, for `Walker.test.ts` and the
 * units' tests (todo 740): the configuration, a character standing in a room,
 * a route built a step at a time, a walker on a real queue that records what
 * reached the wire, and the per-test harness that builds and disposes them.
 * Blocks are `blockOf`'s (`src/shared/__tests__/blocks.ts`).
 */
import { afterEach, beforeEach, vi } from 'vitest';

import { CommandQueue } from '../../CommandQueue';
import { Walker } from '../../Walker';
import type { WalkerEvents } from '../ports';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../../shared/character';
import type { Block, BlockType } from '../../../../shared/blocks';
import type { WalkProgress } from '../../../../shared/walk';
import type { Direction, Route, RouteStep } from '../../../../shared/world';
import { wireExit } from '../../../../shared/entities';
import { blockOf } from '../../../../shared/__tests__/blocks';

export const CONFIG: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 4, minGapMs: 0, ackTimeoutMs: 1000 },
  walk: { stepTimeoutMs: 5000, clearAfterSeconds: 15, minExpPerHour: 0 },
  /*
   * Every door switch **off** here, whatever ships (`openDoors` and `bashDoors`
   * became on by default 2026-09-07). These tests are about the barrier ladder
   * under stated switches — which rung answers, in what order, and what it says
   * when it declines — so each one turns on exactly what it is about and a test
   * that turns nothing on is asserting the refusal. Inheriting the shipped
   * defaults would make half of them assert the other branch by accident. What
   * the client *ships* with is asserted in `src/shared/__tests__/config.test.ts`.
   */
  movement: {
    ...DEFAULT_CONFIG.automation.movement,
    openDoors: false,
    bashDoors: false,
    pickLocks: false
  }
};

/** `CONFIG` with `over` merged into the sections it names. */
export function configWith(over: {
  movement?: Partial<AutomationConfig['movement']>;
  health?: Partial<AutomationConfig['health']>;
}): AutomationConfig {
  return {
    ...CONFIG,
    movement: { ...CONFIG.movement, ...over.movement },
    health: { ...CONFIG.health, ...over.health }
  };
}

/** A character standing in `map/number`, in the realm (null: not placed). */
export function at(
  map: number | null,
  number: number | null,
  over: Partial<CharacterState> = {}
): CharacterState {
  return {
    ...structuredClone(EMPTY_CHARACTER),
    phase: 'in-game',
    ...over,
    room: { ...structuredClone(EMPTY_CHARACTER.room), map, number, ...(over.room ?? {}) }
  };
}

/** The same on map 1, with the room's `Obvious exits:` line as given. */
export function printing(
  number: number,
  exits: Array<[string, string | null]>,
  over: Partial<CharacterState> = {}
): CharacterState {
  return at(1, number, {
    ...over,
    room: {
      ...structuredClone(EMPTY_CHARACTER.room),
      map: 1,
      number,
      exits: exits.map(([direction, note]) => wireExit(direction, note))
    }
  });
}

/** With `hp` of `hpMax` hit points. */
export function hurt(state: CharacterState, hp: number, hpMax = 100): CharacterState {
  return { ...state, vitals: { ...state.vitals, hp, hpMax } };
}

/** One step of a route on map 1, `from -direction-> to`. */
export function stepOf(
  from: number,
  to: number,
  direction: Direction,
  over: Partial<RouteStep> = {}
): RouteStep {
  return {
    from: `1/${from}`,
    to: `1/${to}`,
    direction,
    command: direction,
    name: `Room ${to}`,
    requirement: null,
    dark: false,
    ...over
  };
}

export function routeOf(...steps: RouteStep[]): Route {
  return { cost: steps.length, blocked: false, steps };
}

/** Three rooms in a line: 1/1 -e-> 1/2 -e-> 1/3. */
export const ROUTE: Route = routeOf(
  stepOf(1, 2, 'e', { name: 'Second Room' }),
  stepOf(2, 3, 'e', { name: 'Third Room' })
);

/** A line off the wire, classified, arriving now. */
export function wire(type: BlockType, groups: Record<string, string> = {}): Block {
  return blockOf(type, '', groups, Date.now());
}

/**
 * What went somewhere, minus the nudge — for an assertion about a route *not*
 * sending a step, where the nudge's presence or absence says nothing either
 * way.
 */
export const moves = (sent: readonly string[]): string[] =>
  sent.filter((command) => command.length > 0);

/** Past the queue's acknowledgement window, which these fixtures never answer. */
export const settle = (): void => {
  vi.advanceTimersByTime(CONFIG.pacing.ackTimeoutMs + 200);
};

export interface Rig {
  walker: Walker;
  queue: CommandQueue;
  /** Every command that reached the wire, in order, unless `send` was given. */
  sent: string[];
  notices: string[];
  progress: WalkProgress[];
  ends: Array<[boolean, string | null]>;
  dispose(): void;
}

/**
 * A walker as `SessionManager` builds one, on a queue that records what it
 * sends. `events` is laid over the recording ones; it may be a function of
 * the queue, for an event (a light, a ward) that proposes to it. `send`
 * replaces the recording, for a file that swaps its record mid-test
 * (`Walker.test.ts`).
 */
export function rig(
  events: WalkerEvents | ((queue: CommandQueue) => WalkerEvents) = {},
  config: AutomationConfig = CONFIG,
  send?: (command: string) => void
): Rig {
  const sent: string[] = [];
  const notices: string[] = [];
  const progress: WalkProgress[] = [];
  const ends: Array<[boolean, string | null]> = [];
  const queue = new CommandQueue(config, { send: send ?? ((command) => sent.push(command)) });
  const walker = new Walker(config, queue, {
    notice: (message) => notices.push(message),
    progress: (now) => progress.push(now),
    ended: (arrived, reason) => ends.push([arrived, reason]),
    // Standing, as the session answers for a character that is up (todo 764).
    onTheGround: () => false,
    ...(typeof events === 'function' ? events(queue) : events)
  });
  return {
    walker,
    queue,
    sent,
    notices,
    progress,
    ends,
    dispose: () => {
      walker.dispose();
      queue.dispose();
    }
  };
}

/**
 * The per-test harness, registered where it is called (a test file's top
 * level): fake timers before each test, and every rig the returned function
 * built disposed after it, then real timers again.
 */
export function useRigs(): (...args: Parameters<typeof rig>) => Rig {
  let rigs: Rig[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    rigs = [];
  });
  afterEach(() => {
    for (const each of rigs) each.dispose();
    vi.useRealTimers();
  });
  return (...args) => {
    const made = rig(...args);
    rigs.push(made);
    return made;
  };
}
