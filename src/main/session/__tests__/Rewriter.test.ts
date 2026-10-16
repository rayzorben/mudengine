import { describe, expect, it } from 'vitest';

import { Rewriter, type RewriteWorld } from '../Rewriter';
import type { BatchBlock } from '../../parse/Classifier';
import { LEARN_SPELL_ABILITY } from '../../../shared/abilities';
import { EMPTY_CHARACTER, emptyRoom, type CharacterState } from '../../../shared/character';
import type { Block } from '../../../shared/blocks';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { wireItem } from '../../../shared/entities';
import { UNKNOWN_WEARER } from '../../../shared/gear';
import {
  roomId,
  type Direction,
  type WorldClass,
  type WorldRoom,
  type WorldSpell
} from '../../../shared/world';
import { stripAnsi } from '../../net/LineTokenizer';
import { t } from '../../app/i18n';

/** A hall with a hidden way south and a plain one north, to a yard. */
const HALL: WorldRoom = {
  map: 1,
  room: 1,
  name: 'Hall',
  exits: [
    { direction: 'n', map: 1, room: 2, requirement: null },
    {
      direction: 's',
      map: 1,
      room: 3,
      requirement: { kind: 'hidden', raw: 'Hidden/Searchable', searchable: true }
    },
    { direction: 'e', map: 1, room: 4, requirement: null }
  ]
};
const YARD: WorldRoom = {
  map: 1,
  room: 2,
  name: 'Yard',
  exits: [
    { direction: 's', map: 1, room: 1, requirement: null },
    {
      direction: 'u',
      map: 1,
      room: 5,
      requirement: { kind: 'hidden', raw: 'Hidden/Searchable', searchable: true }
    }
  ]
};
const ROOMS = new Map([HALL, YARD].map((room) => [roomId(room.map, room.room), room]));

/** Two prayer scrolls: Priest 1 and Priest 3, the user's own example (todo 770). */
const SPELLS = new Map<number, WorldSpell>([
  [7, { id: 7, name: 'minor healing', mageryType: 2, mageryLevel: 1 }],
  [8, { id: 8, name: 'cure poison', mageryType: 2, mageryLevel: 3 }]
]);
const SCROLLS: Record<string, number> = { 'healing scroll': 7, 'cure scroll': 8 };
const CLERIC: WorldClass = { id: 3, name: 'Cleric', mageryType: 2, magery: 2 };

const WORLD: RewriteWorld = {
  buildItemEntity: (name) =>
    SCROLLS[name] === undefined
      ? wireItem(name)
      : { ...wireItem(name), abilities: [[LEARN_SPELL_ABILITY, SCROLLS[name]]] },
  namedClasses: () => ({}),
  referredNames: () => ({ item: {}, spell: {}, mob: {} }),
  byId: (id) => ROOMS.get(id),
  spellById: (id) => SPELLS.get(id) ?? null,
  classNamed: (name) => (name === CLERIC.name ? CLERIC : null)
};

const AT = 500;

function exitsBlock(exits: string): Block {
  return {
    seq: 1,
    at: AT,
    type: 'room-exits',
    domain: 'room',
    groups: { exits },
    text: `Obvious exits: ${exits}`,
    terminator: 'newline',
    confidence: 1
  };
}

/** The state the tracker leaves once it has read the line: standing in `room`. */
function standing(room: WorldRoom | null, printed: Direction[]): CharacterState {
  return {
    ...EMPTY_CHARACTER,
    room: {
      ...emptyRoom(),
      name: room?.name ?? 'Hall',
      map: room?.map ?? null,
      number: room?.room ?? null,
      exits: printed.map((direction) => ({
        direction,
        note: null,
        targetMap: null,
        targetRoom: null,
        targetName: null,
        requirement: null
      }))
    }
  };
}

function drawn(block: Block, state: CharacterState): string | null {
  const rewriter = new Rewriter();
  rewriter.configure({
    ...DEFAULT_CONFIG.ui.rewrites,
    designs: [
      { name: '', entity: 'room', enabled: true, template: '{room.exitsWithHidden}|{room.hidden}' }
    ]
  });
  const chunk = rewriter.render(block, { state, world: WORLD, wearer: UNKNOWN_WEARER });
  return chunk === null ? null : stripAnsi(chunk.text).trimEnd();
}

const hidden = (exit: string): string => t('rewrites.room.hiddenExit', { exit });

describe('the exits line', () => {
  it("adds the room's hidden exits in the server's order", () => {
    expect(drawn(exitsBlock('north, east'), standing(HALL, ['n', 'e']))).toBe(
      `north, ${hidden('south')}, east|south`
    );
  });

  it('does not add an exit the server printed, found or not', () => {
    expect(drawn(exitsBlock('north, south, east'), standing(HALL, ['n', 's', 'e']))).toBe(
      'north, south, east|'
    );
  });

  it('lists only the hidden exits of a placed room the server printed None for', () => {
    const vault: WorldRoom = {
      ...HALL,
      room: 6,
      name: 'Vault',
      exits: HALL.exits.filter((exit) => exit.requirement !== null)
    };
    ROOMS.set(roomId(vault.map, vault.room), vault);
    expect(drawn(exitsBlock('None'), standing(vault, []))).toBe(`${hidden('south')}|south`);
  });

  it('leaves the line as printed where the room is not placed, or not the one printed for', () => {
    // Positive control: the same line in the placed hall is drawn.
    expect(drawn(exitsBlock('north, east'), standing(HALL, ['n', 'e']))).not.toBeNull();
    expect(drawn(exitsBlock('north, east'), standing(null, ['n', 'e']))).toBeNull();
    // The tracker kept the hall: the line printed somewhere it did not place.
    expect(drawn(exitsBlock('west'), standing(HALL, ['n', 'e']))).toBeNull();
  });

  it('reads a look as the room that way, and its hidden exits', () => {
    const state: CharacterState = {
      ...standing(HALL, ['n', 'e']),
      peeked: {
        direction: 'n',
        room: { ...emptyRoom(), name: 'Yard' },
        at: AT
      }
    };
    expect(drawn(exitsBlock('south'), state)).toBe(`south, ${hidden('up')}|up`);
  });
});

describe('a scroll on the shelf', () => {
  const shelf = (...items: string[]): BatchBlock => ({
    seq: 1,
    at: AT,
    type: 'shop-list',
    domain: 'items',
    groups: {},
    text: 'The following items are for sale here:',
    terminator: 'newline',
    confidence: 1,
    rows: items.map((item) => ({ item, quantity: '1', price: '30 silver nobles' }))
  });
  const draw = (block: BatchBlock, state: CharacterState): string[] => {
    const rewriter = new Rewriter();
    rewriter.configure({
      ...DEFAULT_CONFIG.ui.rewrites,
      designs: [
        {
          name: '',
          entity: 'shop',
          enabled: true,
          template: '{for item in items}{item}|{item.learned}|{item.usable}\n{/for}'
        }
      ]
    });
    const chunk = rewriter.render(block, { state, world: WORLD, wearer: UNKNOWN_WEARER });
    return chunk === null ? [] : stripAnsi(chunk.text).trimEnd().split(/\r?\n/);
  };
  const cleric: CharacterState = {
    ...EMPTY_CHARACTER,
    className: 'Cleric',
    progress: { ...EMPTY_CHARACTER.progress, level: 10 },
    spellbook: [{ name: 'minor healing', short: 'mihe', level: 1, cost: 2 }]
  };

  it('marks a scroll whose spell the book lists, and says why a Cleric cannot learn Priest 3', () => {
    expect(draw(shelf('healing scroll', 'cure scroll', 'torch'), cleric)).toEqual([
      'healing scroll|true|',
      `cure scroll|false|${t('rewrites.shop.learn.mageryLevel')}`,
      'torch|?|'
    ]);
  });

  it('leaves learned unknown while the spell list was never read', () => {
    expect(draw(shelf('healing scroll'), { ...cleric, spellbook: null })).toEqual([
      'healing scroll|?|'
    ]);
  });
});
