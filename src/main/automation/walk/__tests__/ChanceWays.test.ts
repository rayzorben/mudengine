import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { t } from '../../../app/i18n';
import type { CharacterState } from '../../../../shared/character';
import type { Route, RouteStep } from '../../../../shared/world';
import { at, configWith, moves, routeOf, stepOf, useRigs } from './walking';

/*
 * A way that lands only some of the time (todo 20261024-0804-01): said again
 * while it does not, given up for another way past `movement.chanceTries`
 * times the expected tries, never given up where it is the only way, the
 * pack listed where a try can break what the way wants, and a ship's passage
 * waited out. Each test is red under the mutation named beside it.
 */

const walkerOn = useRigs();

/** `dig grave` out of 1/1 into 1/2 on half the tries, wanting the shovel. */
function dig(over: Partial<NonNullable<RouteStep['requirement']>> = {}): Route {
  return routeOf(
    stepOf(1, 2, 'e', {
      direction: 'portal',
      command: 'dig grave',
      requirement: {
        kind: 'text',
        raw: 'dig grave',
        gates: [{ kind: 'carry', item: 1415, name: 'shovel' }],
        tries: 2,
        ...over
      }
    })
  );
}

/** Each try that moved nobody: the step's deadline, with the character where it began. */
function tries(count: number): void {
  for (let index = 0; index < count; index += 1) vi.advanceTimersByTime(12_000);
}

const standing = at(1, 1);

const listed = (rows: number[]): CharacterState =>
  at(1, 1, {
    inventory: { ...standing.inventory, listedAt: Date.now() + 60_000, rows, wealth: 0 }
  });

describe('a way that lands only some of the time', () => {
  // Mutant: the deadline read as the check refusing, given up at the second try.
  it('is said again, and given up past the tries where there is another way', () => {
    const replans: unknown[] = [];
    const { walker, sent, notices } = walkerOn(
      {
        stateNow: () => standing,
        replan: (_to, _kind, without) => {
          replans.push(without ?? null);
          return routeOf(stepOf(1, 2, 'n'));
        }
      },
      configWith({ movement: { chanceTries: 2 } })
    );
    walker.start(dig(), standing);
    vi.advanceTimersByTime(50);
    walker.onCharacter(standing);
    tries(3);
    // Two times the two expected: four digs, the way round asked for at the fourth.
    expect(moves(sent).filter((command) => command === 'dig grave')).toHaveLength(4);
    expect(replans[0]).toEqual({ from: '1/1', direction: 'portal' });
    expect(notices).toContain(
      t('automation.walk.chanceTry', { command: 'dig grave', expected: 2 })
    );
    expect(notices).toContain(
      t('automation.walk.chanceGaveUp', { command: 'dig grave', count: 4 })
    );
    // And the way round is what is walked, not a plan that takes the dig again.
    vi.advanceTimersByTime(2_000);
    expect(moves(sent).at(-1)).toBe('n');
  });

  // Mutant: the limit applied whatever the replan answers.
  it('is never given up where it is the only way', () => {
    const { walker, sent, notices } = walkerOn(
      { stateNow: () => standing, replan: () => 'no other way' },
      configWith({ movement: { chanceTries: 1 } })
    );
    walker.start(dig(), standing);
    vi.advanceTimersByTime(50);
    walker.onCharacter(standing);
    tries(6);
    expect(moves(sent).filter((command) => command === 'dig grave').length).toBeGreaterThan(4);
    expect(notices.some((line) => line.includes('taking another way'))).toBe(false);
  });

  // Mutant: the pack never listed, so a broken shovel is dug with forever.
  it('lists the pack where a try can break the item, and fetches another when it has', () => {
    const fetched: Array<[readonly number[], string]> = [];
    let now = standing;
    const { walker, sent } = walkerOn({
      stateNow: () => now,
      replan: () => 'no other way',
      fetchAgain: (items, to) => {
        fetched.push([items, to]);
        return true;
      }
    });
    walker.start(dig({ breaks: [{ item: 1415, chance: 0.02 }] }), standing);
    vi.advanceTimersByTime(50);
    walker.onCharacter(standing);
    tries(1);
    expect(sent).toContain('i');
    // Positive control: the listing still holds the shovel, so the dig goes again.
    now = listed([1415]);
    vi.advanceTimersByTime(4_000);
    expect(fetched).toEqual([]);
    expect(moves(sent).filter((command) => command === 'dig grave')).toHaveLength(2);
    // Then a try takes it, and the next listing lacks it.
    now = standing;
    tries(1);
    now = listed([]);
    vi.advanceTimersByTime(4_000);
    expect(fetched).toEqual([[[1415], '1/2']]);
  });
});

describe("a ship's passage", () => {
  /** Paying at 14/759, waiting in 14/715–716, landing on the beach at 14/1812. */
  const passage: Route = routeOf({
    from: '14/759',
    to: '14/1812',
    direction: 'portal',
    command: 'secure passage to terra fuego',
    name: 'Shoreline, Sandy Beach',
    dark: false,
    requirement: {
      kind: 'text',
      raw: 'secure passage to terra fuego',
      gates: [{ kind: 'copper', copper: 2_000_000 }],
      waits: { in: ['14/715', '14/716'], ticks: 100 }
    }
  });

  // Mutant: the crew quarters read as a draw, and the walk planned from there.
  it('is waited out in the rooms it is waited in, and arrives on the beach', () => {
    let replans = 0;
    const wharf = at(14, 759);
    const { walker, ends, notices } = walkerOn({
      stateNow: () => wharf,
      replan: () => {
        replans += 1;
        return 'no other way';
      }
    });
    walker.start(passage, wharf);
    vi.advanceTimersByTime(50);
    walker.onCharacter(at(14, 715));
    expect(notices).toContain(
      t('automation.walk.passageWaiting', { command: 'secure passage to terra fuego' })
    );
    walker.onCharacter(at(14, 716));
    expect(replans).toBe(0);
    walker.onCharacter(at(14, 1812));
    expect(ends.at(-1)?.[0]).toBe(true);
  });
});

describe("a room's own spell as a way", () => {
  /** Standing in the Grand Chamber (17/3247) until its spell puts a Warrior in the Crimson Passage. */
  const chamber: Route = routeOf({
    from: '17/3247',
    to: '17/3250',
    direction: 'portal',
    command: '',
    name: 'Crimson Passage',
    dark: false,
    requirement: {
      kind: 'room-spell',
      raw: 'Spell: 1375',
      waits: { in: ['17/3247'], ticks: 1 },
      gates: [{ kind: 'class', id: 1, is: true, name: 'Warrior' }]
    }
  });

  // Mutant: the step sent as a command, a blank line each try.
  it('is waited out where the character stands, nothing sent, and arrives in the passage', () => {
    const here = at(17, 3247);
    const { walker, sent, ends, notices } = walkerOn({ stateNow: () => here });
    walker.start(chamber, here);
    vi.advanceTimersByTime(50);
    expect(moves(sent)).toEqual([]);
    expect(notices).toContain(
      t('automation.walk.roomSpellWaiting', { room: 'Crimson Passage', ticks: 1 })
    );
    walker.onCharacter(at(17, 3250));
    expect(ends.at(-1)?.[0]).toBe(true);
  });

  // Mutant: the waits never counted, so a gate read wrong leaves the character standing for good.
  it('takes another way past the tries where there is one, and waits on where there is none', () => {
    const here = at(17, 3247);
    const run = (another: boolean) => {
      const asked: unknown[] = [];
      const rig = walkerOn(
        {
          stateNow: () => here,
          replan: (_to, _kind, without) => {
            asked.push(without ?? null);
            if (without === undefined) return chamber;
            return another ? routeOf(stepOf(17, 3247, 'n')) : 'no other way';
          }
        },
        configWith({ movement: { chanceTries: 1 } })
      );
      rig.walker.start(chamber, here);
      // Two waits, each its hold, the second past the one try allowed.
      vi.advanceTimersByTime(60_000);
      vi.advanceTimersByTime(60_000);
      return { ...rig, asked };
    };
    const round = run(true);
    expect(round.asked).toContainEqual({ from: '17/3247', direction: 'portal' });
    expect(round.notices).toContain(
      t('automation.walk.roomSpellGaveUp', { room: 'Crimson Passage', count: 2 })
    );
    vi.advanceTimersByTime(2_000);
    expect(moves(round.sent).at(-1)).toBe('n');
    // Positive control: the only way is waited on, nothing sent.
    const only = run(false);
    expect(moves(only.sent)).toEqual([]);
    expect(only.notices).not.toContain(
      t('automation.walk.roomSpellGaveUp', { room: 'Crimson Passage', count: 2 })
    );
  });
});
