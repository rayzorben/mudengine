import { describe, expect, it } from 'vitest';

import { Rewriter, type RewriteWorld } from '../Rewriter';
import { EMPTY_CHARACTER, emptyRoom, type CharacterState } from '../../../shared/character';
import type { Block } from '../../../shared/blocks';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { wireItem } from '../../../shared/entities';
import { UNKNOWN_WEARER } from '../../../shared/gear';
import { roomId, type Direction, type WorldRoom } from '../../../shared/world';
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

const WORLD: RewriteWorld = {
  buildItemEntity: (name) => wireItem(name),
  namedClasses: () => ({}),
  referredNames: () => ({ item: {}, spell: {}, mob: {} }),
  byId: (id) => ROOMS.get(id)
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

  it('says ? where the room is not placed, or is not the one these exits were printed for', () => {
    expect(drawn(exitsBlock('north, east'), standing(null, ['n', 'e']))).toBe('north, east|?');
    // The tracker kept the hall: the line printed somewhere it did not place.
    expect(drawn(exitsBlock('west'), standing(HALL, ['n', 'e']))).toBe('west|?');
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
