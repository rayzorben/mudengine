import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AreaSearch, type AreaSearchPlanner } from '../AreaSearch';
import { CommandQueue } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { domainOf, type Block, type BlockType } from '../../../shared/blocks';
import type { AreaPlan } from '../../../shared/areaSearch';
import { wireItem } from '../../../shared/entities';
import type { SafetyDecision } from '../../../shared/automation';
import type { RoomId, Route } from '../../../shared/world';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

let seq = 0;
function block(type: BlockType, groups: Record<string, string> = {}): Block {
  seq += 1;
  return {
    seq,
    at: 1_700_000_000_000 + seq,
    type,
    domain: domainOf(type),
    groups,
    text: '',
    terminator: 'newline',
    confidence: 0.8
  };
}

const state = (): CharacterState => ({ ...structuredClone(EMPTY_CHARACTER), phase: 'in-game' });

/** A corridor a - b - c, the character in a. */
const PLAN: AreaPlan = {
  origin: '1/1',
  radius: 2,
  tour: ['1/1', '1/2', '1/3'],
  steps: 2,
  lose: [],
  unread: [],
  behind: [],
  walled: [],
  stranded: []
};

/** A route of single steps along the corridor, from where the character stands. */
function routeTo(from: RoomId, to: RoomId): Route {
  const at = (room: RoomId): number => Number(room.split('/')[1]);
  const steps = [];
  for (let room = at(from); room !== at(to); room += Math.sign(at(to) - at(from))) {
    const next = room + Math.sign(at(to) - at(from));
    steps.push({ from: `1/${room}`, to: `1/${next}` });
  }
  return { steps, cost: steps.length, blocked: false } as unknown as Route;
}

let sent: string[];
let notices: string[];
let decisions: SafetyDecision[];
let queue: CommandQueue;
let here: RoomId;
let walks: RoomId[];
let fighting: boolean;
let taking: boolean;

const planner = (over: Partial<AreaSearchPlanner> = {}): AreaSearchPlanner => ({
  here: () => here,
  routeAround: (room) => routeTo(here, room),
  fightsBack: () => true,
  walk: (route) => {
    walks.push(route.steps.at(-1)?.to ?? here);
    return null;
  },
  plan: () => PLAN,
  nameOf: (room) => `room ${room}`,
  moveInFlight: () => false,
  walking: () => false,
  looping: () => false,
  busy: () => false,
  escaping: () => false,
  taking: () => taking,
  fighting: () => fighting,
  ...over
});

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  decisions = [];
  here = '1/1';
  walks = [];
  fighting = false;
  taking = false;
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (over: Partial<AreaSearchPlanner> = {}): AreaSearch =>
  new AreaSearch(true, queue, planner(over), {
    notice: (m) => notices.push(m),
    decided: (d) => decisions.push(d)
  });
const drain = (): void => void vi.advanceTimersByTime(500);
/** The server's answer to a bare search that found nothing, and the status line after it. */
const nothing = (area: AreaSearch): void => {
  area.onBlock(block('user-search-failed'));
  area.onCharacter(state());
};

describe('searching the area', () => {
  it('searches each room as many times as asked, walking between them', () => {
    const area = make();
    expect(area.start(2, 2, state())).toBeNull();
    drain();
    expect(sent).toEqual(['search']);
    nothing(area);
    drain();
    expect(sent).toEqual(['search', 'search']);
    nothing(area);
    // Searched twice: the next status line walks on.
    area.onCharacter(state());
    expect(walks).toEqual(['1/2']);

    here = '1/2';
    area.onWalkEnded(true, null, state());
    drain();
    nothing(area);
    drain();
    nothing(area);
    area.onCharacter(state());
    expect(walks).toEqual(['1/2', '1/3']);

    here = '1/3';
    area.onWalkEnded(true, null, state());
    drain();
    nothing(area);
    drain();
    nothing(area);
    expect(sent.filter((command) => command === 'search')).toHaveLength(6);
    expect(area.busy).toBe(false);
    expect(decisions.at(-1)).toMatchObject({ action: 'search the area', acted: true });
  });

  it('stops in a room still to search that the way to the next one passes', () => {
    const area = make({ plan: () => ({ ...PLAN, tour: ['1/1', '1/3', '1/2'] }) });
    area.start(2, 1, state());
    drain();
    nothing(area);
    area.onCharacter(state());
    expect(walks).toEqual(['1/2']);
  });

  it('holds a search through a fight, and sends it once the fight is over', () => {
    const area = make();
    fighting = true;
    area.start(2, 1, state());
    // Refused while fighting: a search is never sent into a round.
    expect(area.busy).toBe(false);

    fighting = false;
    // Held behind a half-typed line, so the fight starts before it goes.
    queue.noteTyping(true);
    area.start(2, 1, state());
    fighting = true;
    queue.noteTyping(false);
    drain();
    expect(sent).toEqual([]);
    area.onCharacter(state());
    fighting = false;
    area.onCharacter(state());
    drain();
    expect(sent).toEqual(['search']);
  });

  it('waits for the loot to take what a search turned up before walking on', () => {
    const area = make();
    area.start(2, 1, state());
    drain();
    taking = true;
    nothing(area);
    area.onCharacter(state());
    expect(walks).toEqual([]);
    taking = false;
    area.onCharacter(state());
    expect(walks).toEqual(['1/2']);
  });

  it('keeps what each room searched still held once the loot had taken its share', () => {
    const area = make({ plan: () => ({ ...PLAN, tour: ['1/1', '1/2'] }) });
    const at = (room: number, hidden: string[], open: string[] = []): CharacterState => {
      const s = state();
      return {
        ...s,
        room: {
          ...s.room,
          map: 1,
          number: room,
          hidden: hidden.map((name) => wireItem(name)),
          items: open.map((name) => wireItem(name))
        }
      };
    };
    expect(area.last).toBeNull();
    area.start(2, 1, at(1, []));
    drain();
    area.onBlock(block('room-hidden-items'));
    taking = true;
    area.onCharacter(at(1, ['rusty key', 'scroll of minor healing']));
    // The loot took the key: the walk goes on once it has, and the floor is read then.
    taking = false;
    area.onCharacter(at(1, ['scroll of minor healing'], ['torch']));
    expect(walks).toEqual(['1/2']);
    expect(area.last).toBeNull();

    here = '1/2';
    area.onWalkEnded(true, null, at(2, []));
    drain();
    nothing(area);
    area.onCharacter(state());
    expect(area.busy).toBe(false);
    expect(area.last).toMatchObject({
      ending: 'searched',
      radius: 2,
      rooms: [
        {
          room: '1/1',
          name: 'room 1/1',
          floor: [
            { name: 'torch', count: 1, hidden: false },
            { name: 'scroll of minor healing', count: 1, hidden: true }
          ]
        },
        // Read while unplaced: not known, rather than empty.
        { room: '1/2', floor: null }
      ]
    });
  });

  it("keeps the last room as the loot left it when the player's stop ends the search there", () => {
    const area = make();
    const at = (hidden: string[]): CharacterState => {
      const s = state();
      return {
        ...s,
        room: { ...s.room, map: 1, number: 1, hidden: hidden.map((name) => wireItem(name)) }
      };
    };
    area.start(2, 1, at([]));
    drain();
    area.onBlock(block('room-hidden-items'));
    taking = true;
    area.onCharacter(at(['rusty key', 'scroll of minor healing']));
    area.onCharacter(at(['scroll of minor healing']));
    area.stop('you pressed stop');
    expect(area.last).toMatchObject({
      ending: 'stopped',
      rooms: [{ room: '1/1', floor: [{ name: 'scroll of minor healing', count: 1, hidden: true }] }]
    });
  });

  it("ends on the player's stop, and plans nothing after", () => {
    const area = make();
    area.start(2, 1, state());
    drain();
    nothing(area);
    area.onCharacter(state());
    area.stop('you pressed stop');
    area.onWalkEnded(false, 'you pressed stop', state());
    area.onCharacter(state());
    expect(walks).toEqual(['1/2']);
    expect(area.busy).toBe(false);
  });

  it('passes over a room with no way there, and goes on to the next', () => {
    const area = make({
      routeAround: (room) => (room === '1/2' ? 'no way' : (routeTo(here, room) as unknown as Route))
    });
    area.start(2, 1, state());
    drain();
    nothing(area);
    area.onCharacter(state());
    expect(walks).toEqual(['1/3']);
    expect(notices.some((line) => line.includes('room 1/2'))).toBe(true);
  });

  it('ends when the character runs away', () => {
    let running = false;
    const area = make({ escaping: () => running });
    area.start(2, 1, state());
    running = true;
    area.onCharacter(state());
    expect(area.busy).toBe(false);
  });

  it('routes every walk around the rooms left out for their fight', () => {
    const asked: Array<ReadonlySet<RoomId>> = [];
    const area = make({
      plan: () => ({ ...PLAN, tour: ['1/1', '1/2'], walled: ['1/9', '1/8'] }),
      routeAround: (room, walled) => {
        asked.push(walled);
        return routeTo(here, room);
      }
    });
    area.start(2, 1, state());
    drain();
    nothing(area);
    area.onCharacter(state());
    expect(walks).toEqual(['1/2']);
    expect(asked.length).toBeGreaterThan(0);
    for (const walled of asked) expect([...walled].sort()).toEqual(['1/8', '1/9']);
  });

  it('plans a leg a fight ended once more, then passes the room over', () => {
    const area = make();
    area.start(2, 1, state());
    drain();
    nothing(area);
    area.onCharacter(state());
    area.onWalkEnded(false, 'a fight', state());
    area.onCharacter(state());
    expect(walks).toEqual(['1/2', '1/2']);
    area.onWalkEnded(false, 'a fight', state());
    area.onCharacter(state());
    expect(walks).toEqual(['1/2', '1/2', '1/3']);
  });

  it('ends when attacked with auto-combat off, rather than walking on', () => {
    const area = make({ fightsBack: () => false });
    area.start(2, 1, state());
    fighting = true;
    area.onCharacter(state());
    expect(area.busy).toBe(false);
    expect(notices.some((line) => line.includes('auto-combat'))).toBe(true);
  });

  it('ends when the character leaves the realm', () => {
    const area = make();
    area.start(2, 1, state());
    area.onCharacter({ ...state(), phase: 'authenticating' });
    expect(area.busy).toBe(false);
  });

  it('says why it will not start', () => {
    const area = make({ looping: () => true });
    expect(area.start(2, 1, state())).not.toBeNull();
    expect(decisions.at(-1)).toMatchObject({ acted: false });
  });
});
