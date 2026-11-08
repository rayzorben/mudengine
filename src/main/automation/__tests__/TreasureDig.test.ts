import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TreasureDig, type DigEvents } from '../TreasureDig';
import type { Intent, Offered } from '../CommandQueue';
import { Classifier } from '../../parse/Classifier';
import { tuning } from '../../app/tuning';
import {
  EMPTY_CHARACTER,
  NO_FIGHT_SIGNS,
  type CharacterState,
  type RoomOccupant
} from '../../../shared/character';
import type { Block } from '../../../shared/blocks';

/*
 * The lines are the user's wire from the Lagoon on Paradigm (2026-11-08), run
 * through the classifier, so the patterns and the run are tested together.
 */
let seq = 0;
const classifier = new Classifier({ present: () => [], mob: () => undefined });
function wire(plain: string): Block {
  seq += 1;
  const at = 1_700_000_000_000 + seq;
  return classifier.classify({ seq, at, text: plain, plain, terminator: 'newline' }).block;
}
const PROMPT = '[HP=662/684,MA=94/161]: ';

const spade = {
  name: 'spade',
  source: 'wire',
  slot: null,
  equipped: false,
  charges: null
} as const;
const ground = { ...spade, name: 'disturbed ground' };
const monster = (name: string): RoomOccupant => ({
  name,
  kind: 'mob',
  disposition: null,
  uncertain: false,
  costly: 'never',
  charmed: false,
  hidden: false,
  free: false
});

/** In the Lagoon's dig room, or in a pit, with `spades` in the last listing (`null`: never listed). */
function standing(
  spades: number | null,
  more: { pit?: boolean; monsters?: string[]; listedAt?: number; combat?: boolean } = {}
): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    inCombat: more.combat ?? false,
    room: {
      ...base.room,
      name: more.pit === true ? 'Dark Pit' : 'Jungle Trail, Lagoon',
      items: more.pit === true ? [] : [{ ...ground }],
      occupants: (more.monsters ?? []).map(monster)
    },
    inventory: {
      ...base.inventory,
      items: Array.from({ length: spades ?? 0 }, () => ({ ...spade })),
      listedAt: spades === null ? null : (more.listedAt ?? Date.now())
    }
  };
}

let offered: Intent[];
let said: string[];
let now: CharacterState;
let fights: boolean;
let dig: TreasureDig;

/** The command the queue was last offered, sent: its `onSent` runs as the queue's would. */
function send(): string {
  const intent = offered.shift();
  if (intent === undefined) throw new Error('nothing offered');
  expect(intent.stillWanted?.() ?? true).toBe(true);
  intent.onSent?.();
  return intent.command;
}

function lines(...text: string[]): void {
  for (const one of text) dig.onBlock(wire(one));
}

function at(state: CharacterState): void {
  now = state;
  dig.onCharacter(state);
}

beforeEach(() => {
  vi.useFakeTimers();
  offered = [];
  said = [];
  fights = true;
  now = standing(null);
  const events: DigEvents = {
    stateNow: () => now,
    signs: NO_FIGHT_SIGNS,
    combatOn: () => fights,
    moveInFlight: () => false,
    wantsRest: () => false,
    busy: () => false,
    notice: (message) => said.push(message),
    changed: () => {}
  };
  const queue = {
    offer: (intent: Intent): Offered => {
      const waiting = offered.findIndex((one) => one.coalesceKey === intent.coalesceKey);
      if (waiting >= 0) {
        offered[waiting] = intent;
        return 'joined';
      }
      offered.push(intent);
      return 'queued';
    }
  };
  dig = new TreasureDig(true, queue, events);
});

afterEach(() => {
  dig.dispose();
  vi.useRealTimers();
});

/** Switched on, the spades counted, and the first dig offered. */
function startDigging(spades = 7): void {
  dig.set(true);
  expect(send()).toBe('i');
  lines(PROMPT);
  at(standing(spades));
  expect(dig.view.status).toBe('digging');
}

describe('the treasure dig', () => {
  it('counts the spades, then digs again after each answer', () => {
    startDigging();
    expect(send()).toBe('dig treasure');
    lines('You use your spade and dig up the ground, to find...', 'Nothing.', PROMPT);
    at(standing(7));
    expect(send()).toBe('dig treasure');
    expect(dig.view.dug).toBe(1);
  });

  it('waits out the delay after a roll that prints nothing', () => {
    startDigging();
    send();
    lines('You use your spade and dig up the ground, to find...', PROMPT);
    at(standing(7));
    // The prompt is not the end: the roll runs after `adddelay 4`.
    expect(offered).toEqual([]);
    vi.advanceTimersByTime(tuning().dig.delayMs - 1);
    expect(offered).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(send()).toBe('dig treasure');
  });

  it('digs again as soon as the room reprints at the end of the delay', () => {
    startDigging();
    send();
    lines('You use your spade and dig up the ground, to find...', PROMPT);
    at(standing(7));
    expect(offered).toEqual([]);
    lines(
      'Jungle Trail, Lagoon',
      'You notice disturbed ground here.',
      'Obvious exits: north, east, west'
    );
    at(standing(7));
    expect(send()).toBe('dig treasure');
  });

  it('reads talk between the dig and its roll as nothing about the dig', () => {
    startDigging();
    send();
    lines(
      'You use your spade and dig up the ground, to find...',
      'Brakkle gossips: anyone selling spades?',
      'Nothing.',
      PROMPT
    );
    at(standing(7));
    expect(send()).toBe('dig treasure');
  });

  it('digs again on its own when no state follows the roll', async () => {
    startDigging();
    send();
    lines('You use your spade and dig up the ground, to find...', 'Nothing.');
    expect(offered).toEqual([]);
    await Promise.resolve();
    expect(send()).toBe('dig treasure');
  });

  it('keeps a find that lands after the delay ran out', () => {
    startDigging();
    send();
    lines('You use your spade and dig up the ground, to find...', PROMPT);
    vi.advanceTimersByTime(tuning().dig.delayMs);
    expect(send()).toBe('dig treasure');
    lines('You find a  treasure chest!', 'Nothing.');
    expect(dig.view.finds).toEqual(['treasure chest']);
    // The dig owed has not answered yet; the late `Nothing.` is not its refusal.
    lines('You use your spade and dig up the ground, to find...', 'Nothing.', PROMPT);
    at(standing(7));
    expect(send()).toBe('i');
  });

  it('keeps what a dig found', () => {
    startDigging();
    send();
    lines(
      'You use your spade and dig up the ground, to find...',
      'You find a  treasure chest!',
      PROMPT
    );
    at(standing(7));
    expect(dig.view.finds).toEqual(['treasure chest']);
    // The chest went into the inventory, which is read before the next dig.
    expect(send()).toBe('i');
    lines(PROMPT);
    at(standing(7));
    expect(send()).toBe('dig treasure');
  });

  it('reads a reprint and its prompt before the dig line as no answer yet', () => {
    startDigging();
    send();
    lines(
      'Jungle Trail, Lagoon',
      'You notice disturbed ground here.',
      'Obvious exits: north, east, west',
      PROMPT
    );
    at(standing(7));
    expect(offered).toEqual([]);
    lines('You use your spade and dig up the ground, to find...', 'Nothing.', PROMPT);
    at(standing(7));
    expect(send()).toBe('dig treasure');
    expect(dig.view.dug).toBe(1);
  });

  it('fights in the pit, climbs out once it is empty, and digs again', () => {
    startDigging();
    send();
    lines(
      'You use your spade and dig up the ground, to find...',
      'You dig too deep, and the ground beneath you begins to collapse inward.',
      PROMPT
    );
    at(standing(7, { pit: true, monsters: ['giant crab'], combat: true }));
    expect(dig.view.status).toBe('fighting');
    expect(offered).toEqual([]);
    at(standing(7, { pit: true }));
    expect(send()).toBe('climb out');
    lines('You slowly climb up the rough stone wall, out of the pit.', PROMPT);
    at(standing(7));
    expect(send()).toBe('dig treasure');
    expect(dig.view.falls).toBe(1);
  });

  it('tries the climb again after a refusal', () => {
    startDigging();
    send();
    lines('You dig too deep, and the ground beneath you begins to collapse inward.');
    at(standing(7, { pit: true }));
    expect(send()).toBe('climb out');
    lines('You cannot do that right now!', PROMPT);
    at(standing(7, { pit: true }));
    expect(offered).toEqual([]);
    vi.advanceTimersByTime(tuning().dig.climbRetryMs);
    expect(send()).toBe('climb out');
  });

  it('asks the inventory after a line it cannot read, and stops when no spade is left', () => {
    startDigging(1);
    send();
    lines(
      'You use your spade and dig up the ground, to find...',
      'Suddenly your shovel breaks in two, becoming useless!',
      PROMPT
    );
    at(standing(1));
    vi.advanceTimersByTime(tuning().dig.delayMs);
    expect(send()).toBe('i');
    lines(PROMPT);
    at(standing(0));
    expect(dig.view.on).toBe(false);
    expect(dig.view.status).toBe('done');
    expect(offered).toEqual([]);
  });

  it('stops when the server refuses the dig with a spade in the inventory', () => {
    startDigging();
    for (let refused = 0; refused < tuning().dig.refusals; refused += 1) {
      expect(send()).toBe('dig treasure');
      lines('Nothing happens.', PROMPT);
      vi.advanceTimersByTime(tuning().dig.answerMs);
      expect(send()).toBe('i');
      lines(PROMPT);
      at(standing(7));
    }
    expect(dig.view.status).toBe('refused');
    expect(dig.view.detail).toBe('Nothing happens.');
    expect(offered).toEqual([]);
  });

  it('waits on a monster auto-combat will not attack, and while auto-combat is off', () => {
    startDigging();
    send();
    lines('You use your spade and dig up the ground, to find...', 'Nothing.', PROMPT);
    at(standing(7, { monsters: ['tame parrot'] }));
    expect(dig.view.status).toBe('unfought');
    expect(offered).toEqual([]);
    fights = false;
    at(standing(7));
    expect(dig.view.status).toBe('unswitched');
    expect(offered).toEqual([]);
  });

  it('drops a dig a monster walked in ahead of', () => {
    startDigging();
    now = standing(7, { monsters: ['giant crab'] });
    expect(offered[0]?.stillWanted?.()).toBe(false);
  });

  it('sends nothing switched off', () => {
    startDigging();
    dig.set(false);
    offered = [];
    at(standing(7));
    expect(offered).toEqual([]);
    expect(dig.view.status).toBe('off');
  });
});
