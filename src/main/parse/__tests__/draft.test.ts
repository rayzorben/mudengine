import { describe, expect, it } from 'vitest';

import { RoomDraft } from '../draft';
import { wireExit, wireItem } from '../../../shared/entities';
import { emptyRoom } from '../../../shared/character';

/*
 * The last cluster lifted out of `CharacterTracker` on 2026-08-29. The
 * tracker's tests feed whole room blocks over the wire; these ask the draft
 * the one thing it exists to guarantee — that nothing survives from one room
 * into the next — and what a completed room looks like before resolution.
 */
describe('a room draft', () => {
  it('completes into an unresolved room with its prose joined', () => {
    const draft = new RoomDraft();
    draft.begin('Newhaven, Bank');
    draft.items([wireItem('a coin'), wireItem('a sign')]);
    draft.describe('A quiet vault.');
    // A blank line is nothing, not a gap in the prose.
    draft.describe('   ');
    draft.describe('Coins everywhere.');
    const room = draft.complete([wireExit('n')]);
    expect(room.name).toBe('Newhaven, Bank');
    expect(room.items.map((item) => item.name)).toEqual(['a coin', 'a sign']);
    expect(room.description).toBe('A quiet vault. Coins everywhere.');
    expect(room.exits).toEqual([wireExit('n')]);
    // Locating it is the tracker's job: nothing here claims a place.
    expect(room.map).toBeNull();
    expect(room.number).toBeNull();
    expect(room.resolvedBy).toBeNull();
    expect(room.confidence).toBe(0);
    expect(room.candidates).toEqual([]);
  });

  it('a new name throws away everything half-collected', () => {
    const draft = new RoomDraft();
    draft.begin('Sewer Tunnel');
    draft.items([wireItem('a rat corpse')]);
    draft.describe('Damp.');
    draft.begin('Sewer Tunnel');
    const room = draft.complete([]);
    expect(room.items).toEqual([]);
    expect(room.description).toBeNull();
  });

  it('discarding leaves an empty room, not the last one', () => {
    const draft = new RoomDraft();
    draft.begin('Town Gates');
    draft.describe('Tall.');
    draft.discard();
    expect(draft.complete([])).toEqual({ ...emptyRoom(), exits: [] });
  });

  it('stops collecting prose at twenty lines', () => {
    const draft = new RoomDraft();
    draft.begin('Endless Hall');
    for (let i = 0; i < 21; i += 1) draft.describe(`line ${i}`);
    expect(draft.complete([]).description?.split(' ')).toHaveLength(40);
    expect(draft.complete([]).description?.endsWith('line 19')).toBe(true);
  });
});
