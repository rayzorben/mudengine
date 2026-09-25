import { describe, expect, it, vi } from 'vitest';

import { t } from '../i18n';
import { paletteFind, realmRows, roomRows, type PaletteFindDeps } from '../paletteFind';
import type { PopoverAnchor } from '../popover';
import { tuning } from '../tuning';
import type { Visited } from '@shared/destinations';
import type { SessionId } from '@shared/ipc';
import type { WalkStart } from '@shared/movement';
import { roomId, type Route, type WorldLookup, type WorldRoom } from '@shared/world';

const HERO = 'hero' as SessionId;

const room = (map: number, number: number, name: string, visitedAt: number | null = null) => ({
  map,
  room: number,
  name,
  exits: [],
  visitedAt
});

/** A plan of one step, or none, and whether it is blocked. */
const route = (steps: number, blocked = false): Route => ({
  steps: Array.from({ length: steps }, () => ({
    from: roomId(1, 1),
    to: roomId(1, 2),
    direction: 'n' as const,
    command: 'n',
    name: 'Somewhere',
    requirement: null,
    dark: false
  })),
  cost: steps,
  blocked
});

const NOTHING: WorldLookup = {
  mobs: [],
  items: [],
  spells: [],
  races: [],
  classes: [],
  classNames: {}
};

/** The four bridge calls the rows make, each answering as main does. */
function deps(
  answers: {
    rooms?: Array<WorldRoom & Visited>;
    lookup?: WorldLookup;
    plan?: Route | Error;
    walk?: WalkStart;
  } = {}
) {
  const openRouteOn = vi.fn<PaletteFindDeps['openRouteOn']>();
  const inspect = vi.fn<PaletteFindDeps['inspect']>();
  const walkRoute = vi.fn(async () => answers.walk ?? { started: true as const });
  const handed: PaletteFindDeps = {
    api: {
      searchRooms: async () => answers.rooms ?? [],
      lookup: async () => answers.lookup ?? NOTHING,
      routeTo: async () => {
        const plan = answers.plan ?? route(1);
        if (plan instanceof Error) throw plan;
        return plan;
      },
      walkRoute
    },
    session: HERO,
    openRouteOn,
    inspect
  };
  return { handed, openRouteOn, inspect, walkRoute };
}

describe('the palette query, as found blocks', () => {
  it('answers rooms first, then the realm, each under its own heading', async () => {
    const { handed } = deps({
      rooms: [room(1, 297, 'Bank of God')],
      lookup: { ...NOTHING, spells: [{ id: 52, name: 'magic armour' }] }
    });
    const found = await paletteFind('bank', handed);
    expect(found.map((block) => [block.key, block.label])).toEqual([
      ['rooms', t('palette.groups.found')],
      ['realm', t('palette.groups.realm')]
    ]);
    expect(found[0]?.items.map((row) => row.id)).toEqual(['goto:1/297']);
    expect(found[1]?.items.map((row) => row.id)).toEqual(['lookup:spell:0']);
    // Every row lasts only as long as the query: none can be pinned to the shelf.
    expect(found.flatMap((block) => block.items).every((row) => row.transient === true)).toBe(true);
  });
});

describe('a room the query names', () => {
  it('is hinted with its reference, and with when it was walked to', async () => {
    const { handed } = deps({
      rooms: [room(1, 297, 'Bank of God'), room(1, 1, 'Town Gates', Date.now() - 60_000)]
    });
    const [fresh, visited] = await roomRows('b', handed);
    expect(fresh?.label).toBe(t('palette.navigate.gotoLabel', { roomName: 'Bank of God' }));
    expect(fresh?.hint).toBe('1/297');
    expect(visited?.hint).not.toBe('1/1');
    expect(visited?.hint).toContain('1/1');
  });

  it('walks there without opening the panel when the plan starts', async () => {
    const { handed, openRouteOn, walkRoute } = deps({ rooms: [room(1, 297, 'Bank of God')] });
    const [row] = await roomRows('bank', handed);
    row?.run();
    // The walk was asked for, so the panel's absence is the answer, not a race.
    await vi.waitFor(() => expect(walkRoute).toHaveBeenCalledTimes(1));
    await new Promise((settle) => setTimeout(settle, 0));
    expect(openRouteOn).not.toHaveBeenCalled();
  });

  it.each([
    ['a blocked plan', { plan: route(1, true) }],
    ['a plan with nothing to walk', { plan: route(0) }],
    ['a walk main refused', { walk: { refused: 'no' } as WalkStart }],
    ['a plan that could not be drawn', { plan: new Error('unplanned') }]
  ])('opens the panel on the room for %s', async (_, answer) => {
    const bank = room(1, 297, 'Bank of God');
    const { handed, openRouteOn } = deps({ rooms: [bank], ...answer });
    const [row] = await roomRows('bank', handed);
    row?.run();
    await vi.waitFor(() => expect(openRouteOn).toHaveBeenCalledWith(bank, null));
  });
});

describe('what the realm knows by the query', () => {
  it('keys rows by position, so a repeated name keeps two rows', async () => {
    const { handed } = deps({
      lookup: {
        ...NOTHING,
        spells: [
          { id: 292, name: 'maelstrom' },
          { id: 1374, name: 'maelstrom' }
        ]
      }
    });
    const rows = await realmRows('mael', handed);
    expect(rows.map((row) => row.id)).toEqual(['lookup:spell:0', 'lookup:spell:1']);
    expect(rows.map((row) => row.icon)).toEqual(['bolt', 'bolt']);
  });

  it('stops at the tuned number of rows', async () => {
    const many = Array.from({ length: tuning().paletteFoundRows + 3 }, (_, at) => ({
      id: at,
      name: `ring ${at}`
    }));
    const { handed } = deps({ lookup: { ...NOTHING, items: many } });
    expect(await realmRows('ring', handed)).toHaveLength(tuning().paletteFoundRows);
  });

  it('opens the quick view where the palette stood', async () => {
    const { handed, inspect } = deps({ lookup: { ...NOTHING, items: [{ id: 7, name: 'torch' }] } });
    const [row] = await realmRows('torch', handed);
    // A stand-in for the palette's body: the suite runs with no DOM, and the
    // row only hands the anchor on.
    const from: PopoverAnchor = {
      box: { top: 1, right: 2, bottom: 3, left: 4 },
      within: {} as HTMLElement
    };
    row?.run(from);
    expect(inspect).toHaveBeenCalledWith('torch', from);
  });
});
