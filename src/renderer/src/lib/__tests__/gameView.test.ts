import { describe, expect, it } from 'vitest';

import type { Block } from '@shared/blocks';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '@shared/character';
import type { ExitEntity } from '@shared/entities';
import { arenaTokensOf } from '../gameArena';
import { blowOf, SELF } from '../gameBlows';
import {
  commandFor,
  diagonalOf,
  diagonalWaits,
  gameCommands,
  type GameCommands
} from '../gameCommands';
import { dockGeometry, DOCK_MIN_COLUMNS, DOCK_PADDING } from '../gameDock';
import { anchorOf, intoRound, RESYNC_MS } from '../gameRounds';
import { feedOf, forYou, unreadFor } from '../gameTalk';

const mob = (name: string, hostile = false): RoomOccupant =>
  ({ name, kind: 'mob', disposition: hostile ? 'hostile' : null }) as RoomOccupant;
const player = (name: string): RoomOccupant => ({ name, kind: 'player' }) as RoomOccupant;
const exit = (direction: string): ExitEntity =>
  ({ direction, targetName: null, requirement: null, note: null }) as unknown as ExitEntity;

function state(over: {
  occupants?: RoomOccupant[];
  engaged?: boolean;
  target?: string | null;
  sneaking?: boolean;
  wealth?: number | null;
  coins?: boolean;
  hurt?: boolean;
  exits?: string[];
}): CharacterState {
  return {
    ...EMPTY_CHARACTER,
    name: 'Rayzor',
    stealth: over.sneaking === true ? 'sneaking' : 'unknown',
    vitals: { ...EMPTY_CHARACTER.vitals, hp: over.hurt === true ? 50 : 100, hpMax: 100 },
    inventory: { ...EMPTY_CHARACTER.inventory, wealth: over.wealth ?? null },
    combat: {
      ...EMPTY_CHARACTER.combat,
      engaged: over.engaged ?? false,
      target: over.target ?? null
    },
    room: {
      ...EMPTY_CHARACTER.room,
      map: 1,
      number: 1,
      occupants: over.occupants ?? [],
      exits: (over.exits ?? ['n', 's']).map(exit),
      cash:
        over.coins === true
          ? { runic: 0, platinum: 0, gold: 3, silver: 0, copper: 0, totalCopper: 300 }
          : null
    }
  };
}

const keys = (commands: GameCommands): string[] =>
  [...commands.fight, ...commands.here, ...commands.you].map((one) => one.key);

describe("the game view's command bar", () => {
  it('leads with attacking an aggressive monster, by name', () => {
    const commands = gameCommands({
      character: state({ occupants: [mob('kobold thief', true)] }),
      picked: null,
      place: null,
      unread: 0
    });
    expect(commandFor(commands, 'a')).toMatchObject({ line: 'a kobold thief', main: true });
    expect(keys(commands)).not.toContain('Tab');
    expect(keys(commands)).not.toContain('f');
  });

  it('offers the next target and running only in a fight with two monsters', () => {
    const commands = gameCommands({
      character: state({
        occupants: [mob('kobold thief'), mob('giant rat')],
        engaged: true,
        target: 'giant rat'
      }),
      picked: null,
      place: null,
      unread: 0
    });
    expect(commandFor(commands, 'a')?.line).toBe('a giant rat');
    expect(keys(commands)).toEqual(expect.arrayContaining(['Tab', 'f', 'l']));
    // Nothing that cannot be done in a fight.
    expect(keys(commands)).not.toEqual(expect.arrayContaining(['k']));
    expect(keys(commands)).not.toContain('h');
    expect(keys(commands)).not.toContain('x');
  });

  it("offers the bank's deposit only with coins carried, and a shop's list", () => {
    const rich = gameCommands({
      character: state({ wealth: 1500 }),
      picked: null,
      place: 'bank',
      unread: 0
    });
    expect(commandFor(rich, 'y')).toMatchObject({ line: 'deposit 1500', place: 'bank' });
    const broke = gameCommands({
      character: state({ wealth: 0 }),
      picked: null,
      place: 'bank',
      unread: 0
    });
    expect(commandFor(broke, 'y')).toBeNull();
    const shop = gameCommands({ character: state({}), picked: null, place: 'weapons', unread: 0 });
    expect(commandFor(shop, 'y')?.line).toBe('list');
    const trainer = gameCommands({
      character: state({}),
      picked: null,
      place: 'trainer',
      unread: 0
    });
    expect(commandFor(trainer, 'y')?.line).toBe('train');
  });

  it('gets the coins on the floor, and rests only when hurt', () => {
    const commands = gameCommands({
      character: state({ coins: true }),
      picked: null,
      place: null,
      unread: 0
    });
    expect(commandFor(commands, 'g')?.line).toBe('get coins');
    expect(commandFor(commands, 'r')).toBeNull();
    const hurt = gameCommands({
      character: state({ hurt: true }),
      picked: null,
      place: null,
      unread: 0
    });
    expect(commandFor(hurt, 'r')?.line).toBe('rest');
  });

  it('backstabs while sneaking and no longer offers to sneak', () => {
    const commands = gameCommands({
      character: state({ occupants: [mob('kobold thief')], sneaking: true }),
      picked: null,
      place: null,
      unread: 0
    });
    expect(commandFor(commands, 'b')?.line).toBe('bs kobold thief');
    expect(commandFor(commands, 'k')).toBeNull();
    // The realm's command table has `hide`, not `hi`.
    expect(commandFor(commands, 'h')?.line).toBe('hide');
  });

  it('marks Talk while lines wait for the character', () => {
    const commands = gameCommands({ character: state({}), picked: null, place: null, unread: 2 });
    expect(commandFor(commands, 't')).toMatchObject({ action: 'talk', badge: 2, main: true });
  });
});

describe('the diagonal keys', () => {
  it('moves at once on s in a room with no se or sw', () => {
    // The positive control first: the same key waits where a diagonal starts with it.
    expect(diagonalWaits('s', ['n', 'se'])).toBe(true);
    expect(diagonalWaits('s', ['n', 's', 'e'])).toBe(false);
  });

  it('never waits on e, w, up or down', () => {
    for (const key of ['e', 'w', 'u', 'd'] as const)
      expect(diagonalWaits(key, ['ne', 'nw', 'se', 'sw'])).toBe(false);
  });

  it('reads n then e as ne, and nothing else as a diagonal', () => {
    expect(diagonalOf('n', 'e')).toBe('ne');
    expect(diagonalOf('s', 'w')).toBe('sw');
    expect(diagonalOf('e', 'n')).toBeNull();
    expect(diagonalOf('n', 's')).toBeNull();
  });
});

describe('the arena', () => {
  it('gives the target its wound band and every other monster an unknown one, never full', () => {
    const character = state({
      occupants: [mob('kobold thief'), mob('giant rat')],
      engaged: true,
      target: 'giant rat'
    });
    const fought = {
      ...character,
      combat: {
        ...character.combat,
        health: { observed: 'heavily wounded' } as CharacterState['combat']['health']
      }
    };
    const tokens = arenaTokensOf(fought, null);
    const rat = tokens.find((one) => one.name === 'giant rat')!;
    const thief = tokens.find((one) => one.name === 'kobold thief')!;
    expect(rat.band).not.toBeNull();
    expect(rat.target).toBe(true);
    expect(thief.band).toBeNull();
    expect(thief.health).toBeNull();
  });

  it('stands party members in the room beside the character, and other players apart', () => {
    const character = {
      ...state({ occupants: [player('Kael'), player('Grimjaw')] }),
      party: {
        ...EMPTY_CHARACTER.party,
        members: [
          { name: 'Kael', health: 0.8, mana: 0.5 },
          { name: 'Lysa', health: 1, mana: null }
        ] as CharacterState['party']['members']
      }
    };
    const tokens = arenaTokensOf(character, null);
    expect(tokens.map((one) => [one.name, one.side])).toEqual([
      ['Rayzor', 'party'],
      ['Kael', 'party'],
      ['Grimjaw', 'player']
    ]);
  });
});

const block = (
  type: string,
  text: string,
  groups: Record<string, string> = {},
  seq = 1,
  at = 10
): Block =>
  ({
    seq,
    at,
    type,
    domain: type.startsWith('conversation') ? 'conversation' : 'combat',
    groups,
    text
  }) as Block;

describe('a blow on the arena', () => {
  const names = [
    { key: 'm:kobold thief#0', name: 'kobold thief' },
    { key: 'p:kael#0', name: 'Kael' }
  ];

  it("reads a monster's hit on the character from the line", () => {
    expect(
      blowOf(
        block('mob-hits', 'The kobold thief slashes you for 5 damage!', { damage: '5' }),
        names
      )
    ).toEqual({ from: 'm:kobold thief#0', to: SELF, kind: 'hit', amount: 5 });
  });

  it("reads the character's own hit and miss", () => {
    expect(
      blowOf(
        block('user-hits', 'You slash the kobold thief for 12 damage!', {
          attacker: 'You',
          damage: '12'
        }),
        names
      )
    ).toMatchObject({ from: SELF, to: 'm:kobold thief#0', amount: 12 });
    expect(
      blowOf(
        block('user-misses', 'You swing at the kobold thief!', { target: 'kobold thief' }),
        names
      )
    ).toMatchObject({ kind: 'miss', amount: null });
  });

  it('reads a heal cast on a member', () => {
    expect(
      blowOf(
        block('spell-cast', 'Kael casts minor healing on you, healing 9 healing!', {
          caster: 'Kael',
          kind: 'healing',
          amount: '9'
        }),
        names
      )
    ).toEqual({ from: 'p:kael#0', to: SELF, kind: 'heal', amount: 9 });
  });

  it('draws nothing for a line naming nobody on the arena', () => {
    expect(
      blowOf(block('user-hits', 'Grimjaw slashes the orc for 3 damage!', { damage: '3' }), names)
    ).toBeNull();
  });
});

describe('talk in the game view', () => {
  const telepath = block(
    'conversation-telepath',
    'Kael telepaths: meet at the bank',
    { player: 'Kael', message: 'meet at the bank' },
    3,
    50
  );
  const gossip = block(
    'conversation-gossip',
    'Nusse gossips: hello',
    { player: 'Nusse', message: 'hello' },
    2,
    40
  );
  const receipt = block(
    'conversation-telepath',
    '--- Telepath Sent to Kael ---',
    { player: 'Kael' },
    4,
    60
  );

  it('holds a telepath to the character as for it, and its own receipt as not', () => {
    expect(forYou(telepath, 'Rayzor')).toBe(true);
    expect(forYou(gossip, 'Rayzor')).toBe(false);
    expect(forYou(receipt, 'Rayzor')).toBe(false);
  });

  it('feeds only what was said after the view came up and after the panel was last read', () => {
    const backlog = block(
      'conversation-gossip',
      'Old: news',
      { player: 'Old', message: 'news' },
      1,
      5
    );
    const talk = [backlog, gossip, telepath, receipt];
    expect(feedOf(talk, { seen: 0, since: 30 }).map((one) => one.seq)).toEqual([2, 3, 4]);
    expect(feedOf(talk, { seen: 3, since: 30 }).map((one) => one.seq)).toEqual([4]);
    expect(unreadFor(talk, { seen: 0, since: 30 }, 'Rayzor')).toBe(1);
    expect(unreadFor(talk, { seen: 3, since: 30 }, 'Rayzor')).toBe(0);
  });
});

describe("the game view's console", () => {
  const cell = 9;
  const least = DOCK_MIN_COLUMNS * cell + DOCK_PADDING;

  it('never docks narrower than 80 columns while the window has room for them', () => {
    for (const dock of ['bottom', 'float', 'left', 'right'] as const) {
      const { console } = dockGeometry(dock, 1920, 1080, cell);
      expect(console.width).toBeGreaterThanOrEqual(least);
    }
  });

  it('keeps the docked size when shut, scaled to about 80 columns across the thumbnail', () => {
    const shut = dockGeometry('bottom', 1920, 1080, cell);
    expect(shut.console.width).toBe(1920 - 32);
    expect(shut.scale).toBeCloseTo(400 / least, 5);
  });

  it('gives a window too narrow for 80 columns all it has', () => {
    expect(dockGeometry('left', 600, 800, cell).console.width).toBe(600 - 32);
  });
});

describe('the ring round the arena', () => {
  const timing = { periodMs: 5000, nextInMs: 1200, offRoundMs: 2022 };

  it('puts the round on this window clock', () => {
    expect(anchorOf(null, timing, 10_000)).toEqual({
      roundAt: 11_200,
      periodMs: 5000,
      offRoundMs: 2022
    });
  });

  it('keeps the beat it holds when a push restates it a little late', () => {
    const held = anchorOf(null, timing, 10_000);
    // The same beat, told 3 s later and delivered 40 ms late: a round on from 11,200 is 16,200.
    expect(anchorOf(held, { ...timing, nextInMs: 3200 - 40 }, 13_000)).toBe(held);
  });

  it('keeps the beat it holds when a refit moves the period by a few ms', () => {
    const held = anchorOf(null, timing, 10_000);
    expect(anchorOf(held, { ...timing, periodMs: 5004 }, 10_000)).toBe(held);
    expect(anchorOf(held, { ...timing, periodMs: 5000 + RESYNC_MS }, 10_000)).not.toBe(held);
  });

  it('takes a new beat when the round moved', () => {
    const held = anchorOf(null, timing, 10_000);
    expect(anchorOf(held, { ...timing, nextInMs: 600 }, 10_000)?.roundAt).toBe(10_600);
  });

  it('takes the new off-round when a step was timed', () => {
    const held = anchorOf(null, { ...timing, offRoundMs: null }, 10_000);
    expect(anchorOf(held, timing, 10_000)?.offRoundMs).toBe(2022);
  });

  it('is gone when the rounds are no longer known', () => {
    expect(anchorOf(anchorOf(null, timing, 0), null, 0)).toBeNull();
  });

  it('counts into the round from 0 at the round', () => {
    const anchor = anchorOf(null, timing, 10_000)!;
    expect(intoRound(anchor, 11_200)).toBe(0);
    expect(intoRound(anchor, 11_000)).toBe(4800);
    expect(intoRound(anchor, 17_700)).toBe(1500);
  });
});
