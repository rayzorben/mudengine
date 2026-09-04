import { describe, expect, it } from 'vitest';

import { exitsUnseen, lightNote } from '../room';

const room = (over: Partial<Parameters<typeof lightNote>[0] & { exits: never[] }>) => ({
  light: null,
  resolvedBy: null,
  name: 'Sewer Tunnel',
  exits: [],
  ...over
});

describe('what the Room card says about the light', () => {
  it('says nothing for a room the server printed no phrase about', () => {
    expect(lightNote(room({}))).toBeNull();
  });

  /* The two dim phrases annotate a room the client read in full. */
  it('shows a dim phrase as the phrase alone', () => {
    expect(lightNote(room({ light: 'dimly lit', resolvedBy: 'movement' }))).toEqual({
      phrase: 'dimly lit',
      blinding: false,
      placement: null
    });
  });

  /* The bug this exists for: a room placed by inference drawn as one read. */
  it('says a dark room was placed by dead reckoning', () => {
    expect(lightNote(room({ light: 'pitch black', resolvedBy: 'dead-reckoning' }))).toEqual({
      phrase: 'pitch black',
      blinding: true,
      placement: 'dead-reckoning'
    });
  });

  /*
   * A blinding phrase with no move pending -- the light ran out, or `look` was
   * typed -- leaves the room whole and only changes the phrase, so the name is
   * the last one read. Drawn as read, it carried the same authority as a room
   * the client had just seen; review caught the branch.
   */
  it('says a dark room with a name still on the card is remembered, not read', () => {
    expect(lightNote(room({ light: 'pitch black', resolvedBy: 'movement' }))).toEqual({
      phrase: 'pitch black',
      blinding: true,
      placement: 'remembered'
    });
  });

  /* Refuse rather than guess, said out loud. */
  it('says when a dark room could not be placed at all', () => {
    expect(lightNote(room({ light: 'very dark', resolvedBy: null, name: null }))).toEqual({
      phrase: 'very dark',
      blinding: true,
      placement: 'unplaced'
    });
  });
});

describe('an empty exit list', () => {
  it('means none in a room the client read', () => {
    expect(exitsUnseen(room({}))).toBe(false);
    expect(exitsUnseen(room({ light: 'dimly lit' }))).toBe(false);
  });

  it('means unseen in a room the server would not describe', () => {
    expect(exitsUnseen(room({ light: 'pitch black' }))).toBe(true);
  });
});
