import { describe, expect, it } from 'vitest';

import { edgeBlock, edgePenalty } from '../Router';
import { parseInstruction } from '../instructions';
import { familyOpens, searchCost } from '../navigation/exitFamily';
import { DEFAULT_INTERNAL } from '../../../shared/internal';

const WALL = DEFAULT_INTERNAL.tuning.world.wallCost;
const RECHECK = DEFAULT_INTERNAL.tuning.walk.searchRecheckEvery;

describe('a hidden exit found by searching, priced by Perception (todo 62)', () => {
  it('costs the searches the roll takes, and the reprints between them', () => {
    expect(searchCost(100, 3)).toBe(2);
    expect(searchCost(250, 3)).toBe(2);
    expect(searchCost(20, 3)).toBe(7);
    expect(searchCost(5, 3)).toBe(27);
    expect(searchCost(null, 3)).toBe('unknown');
    expect(searchCost(0, 3)).toBeNull();
  });

  it('prices the router by it, the old flat figure while the sheet is unread', () => {
    const searchable = parseInstruction('Hidden/Searchable');
    expect(edgePenalty(searchable, {})).toBe(25);
    expect(edgePenalty(searchable, { perception: 50 })).toBe(searchCost(50, RECHECK));
    expect(edgePenalty(searchable, { perception: 0 })).toBe(WALL);
  });

  it('walks a passable hidden exit as a corridor', () => {
    const passable = parseInstruction('Hidden/Passable');
    expect(passable?.passable).toBe(true);
    expect(edgePenalty(passable, {})).toBe(0);
    // Positive control: a lever exit with no lever read keeps its discouragement.
    expect(edgePenalty(parseInstruction('Hidden/Needs 2 Actions, any order'), {})).toBe(200);
  });
});

describe('the exit types a GreaterMUD server loads as plain exits (todo 62)', () => {
  const timed = parseInstruction('Timed: 2*5 minutes')!;
  const ticket = parseInstruction('Ticket/Item: 1234')!;

  it('opens timed and ticket exits only once the wire says GreaterMUD', () => {
    expect(ticket.ticket).toBe(true);
    expect(familyOpens(timed, 'greatermud')).toBe(true);
    expect(familyOpens(ticket, 'greatermud')).toBe(true);
    expect(familyOpens(timed, 'majormud')).toBe(false);
    expect(familyOpens(timed, null)).toBe(false);
  });

  it('prices and blocks by the same answer', () => {
    const lacking = { packKnown: true, keys: [] };
    expect(edgePenalty(timed, { family: 'greatermud' })).toBe(0);
    expect(edgePenalty(timed, {})).toBeGreaterThan(0);
    expect(edgeBlock(ticket, { ...lacking, family: 'greatermud' })).toBeNull();
    expect(edgePenalty(ticket, { ...lacking, family: 'greatermud' })).toBe(0);
    // Positive control: on an unread family the listed pack without the ticket is the wall.
    expect(edgeBlock(ticket, lacking)).not.toBeNull();
  });
});
