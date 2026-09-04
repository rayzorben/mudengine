import { describe, expect, it } from 'vitest';

import { noteRemoteCall, trackPlayers } from '../players';
import { CharacterTracker } from '../CharacterTracker';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { NO_PLAYERS, knownPlayers, type PlayerRegistry } from '../../../shared/players';
import type { Block } from '../../../shared/blocks';

const block = (type: string, groups: Record<string, string> = {}, at = 1_000): Block =>
  ({
    type,
    domain: 'system',
    raw: '',
    plain: '',
    text: '',
    groups,
    confidence: 1,
    at,
    seq: 1
  }) as unknown as Block;

const state = (over: Partial<CharacterState> = {}): CharacterState => ({
  ...structuredClone(EMPTY_CHARACTER),
  phase: 'in-game',
  name: 'Vaelor',
  ...over
});

/**
 * One block from nothing: the prior state is the empty one, so every occupant
 * and attacker in `current` is new and is stamped. The tests that care about
 * the difference between two states pass their own `previous`.
 */
const fold = (
  registry: PlayerRegistry,
  current: Block,
  now: CharacterState,
  previous: CharacterState = state()
): PlayerRegistry => trackPlayers(registry, current, now, previous);

const roster = (...entries: Array<Partial<{ name: string; alignment: string; gang: string }>>) =>
  entries.map((entry) => ({
    name: entry.name ?? 'Soul',
    alignment: (entry.alignment ?? null) as never,
    title: null,
    flags: null,
    gang: entry.gang ?? null,
    provisional: false
  }));

describe('what a sighting records', () => {
  it('keeps the gang a who row named', () => {
    const players = fold(
      NO_PLAYERS,
      block('who-list'),
      state({ online: roster({ name: 'Nester', gang: 'Old Guard' }) })
    );
    expect(players['nester']?.gang).toBe('Old Guard');
  });

  it('files somebody from the roster with what the listing said', () => {
    const players = fold(
      NO_PLAYERS,
      block('who-list'),
      state({ online: roster({ name: 'Soul', alignment: 'Good' }) })
    );
    expect(players['soul']).toMatchObject({
      name: 'Soul',
      alignment: 'Good',
      online: true,
      lastRoomAt: null
    });
  });

  it('never files this character as one of the other players', () => {
    const players = fold(
      NO_PLAYERS,
      block('who-list'),
      state({ name: 'Vaelor', online: roster({ name: 'Vaelor' }, { name: 'Soul' }) })
    );
    expect(Object.keys(players)).toEqual(['soul']);
  });

  it('records where somebody was seen, from the room and only from the room', () => {
    const room = {
      ...EMPTY_CHARACTER.room,
      number: 187,
      name: 'A Dusty Track',
      occupants: [{ name: 'Yang', kind: 'player' as const }] as never
    };
    const players = fold(NO_PLAYERS, block('room-exits'), state({ room }));
    expect(players['yang']).toMatchObject({
      lastRoom: 187,
      lastRoomName: 'A Dusty Track',
      lastRoomAt: 1_000
    });
  });

  /*
   * The two clocks answer different questions. A telepath proves somebody is
   * logged in now and says nothing about where they are, so it leaves the room,
   * and the time the room was true, exactly where the last placed sighting put
   * them. (`lastSeen` itself is not asserted: a sighting that changes nothing
   * but the clock returns the same registry by design — see `same()`.)
   */
  it('leaves the room and its time alone when somebody merely speaks', () => {
    const room = {
      ...EMPTY_CHARACTER.room,
      number: 187,
      name: 'A Dusty Track',
      occupants: [{ name: 'Yang', kind: 'player' as const }] as never
    };
    let players = fold(NO_PLAYERS, block('room-exits', {}, 1_000), state({ room }));
    players = fold(
      players,
      block('conversation-telepath', { player: 'Yang', message: 'brb' }, 5_000),
      state()
    );
    expect(players['yang']).toMatchObject({
      online: true,
      lastRoom: 187,
      lastRoomName: 'A Dusty Track',
      lastRoomAt: 1_000
    });
  });

  /*
   * `room.occupants` outlives the block that listed it, and the fold runs on
   * every block. Stamping the room time from it on each pass moved the
   * timestamp — and so republished the registry — on every line printed while
   * somebody shared the room. The positive control is the listing itself,
   * which must stamp; the assertion is that an unrelated line afterwards
   * returns the identical registry.
   */
  it('does not re-stamp the room on a block that did not change who is in it', () => {
    const room = {
      ...EMPTY_CHARACTER.room,
      number: 187,
      name: 'A Dusty Track',
      occupants: [{ name: 'Yang', kind: 'player' as const }] as never
    };
    const listed = state({ room });
    const players = fold(NO_PLAYERS, block('room-exits', {}, 1_000), listed);
    expect(players['yang']?.lastRoomAt).toBe(1_000);

    const later = fold(players, block('mob-misses', {}, 9_000), listed, listed);
    expect(later).toBe(players);
  });

  it('stamps the room again when the occupant list is replaced', () => {
    const room = {
      ...EMPTY_CHARACTER.room,
      number: 187,
      name: 'A Dusty Track',
      occupants: [{ name: 'Yang', kind: 'player' as const }] as never
    };
    const listed = state({ room });
    const players = fold(NO_PLAYERS, block('room-exits', {}, 1_000), listed);
    // A fresh listing of the same room: a new array, the same names.
    const relisted = state({ room: { ...room, occupants: [...room.occupants] } });
    const later = fold(players, block('room-exits', {}, 9_000), relisted, listed);
    expect(later['yang']?.lastRoomAt).toBe(9_000);
  });

  /*
   * A pitch-black room lists who is there and resolves to nothing. The sighting
   * is real and is stamped; the place is honestly absent. The card's phrasing
   * of that pair is tested where the phrasing lives, in the renderer.
   */
  it('stamps a sighting in a room it could not place, and leaves the place null', () => {
    const room = {
      ...EMPTY_CHARACTER.room,
      occupants: [{ name: 'Yang', kind: 'player' as const }] as never
    };
    const players = fold(NO_PLAYERS, block('room-exits', {}, 1_000), state({ room }));
    expect(players['yang']).toMatchObject({
      lastRoom: null,
      lastRoomName: null,
      lastRoomAt: 1_000
    });
  });

  it('does not place a monster in the registry', () => {
    const room = {
      ...EMPTY_CHARACTER.room,
      number: 5,
      occupants: [{ name: 'a large rat', kind: 'mob' as const }] as never
    };
    const players = fold(NO_PLAYERS, block('room-exits'), state({ room }));
    expect(players).toEqual({});
  });

  it('counts somebody speaking as a sighting and nothing more', () => {
    const players = fold(
      NO_PLAYERS,
      block('conversation-telepath', { player: 'Rend', message: 'hello' }),
      state()
    );
    expect(players['rend']).toMatchObject({ online: true, lastRoom: null, lastRoomAt: null });
  });

  it('ignores a telepath receipt, which is this character talking', () => {
    // `--- Telepath Sent to Soul ---` names a player and carries no message.
    const players = fold(NO_PLAYERS, block('conversation-telepath', { player: 'Soul' }), state());
    expect(players).toEqual({});
  });
});

describe('a later sighting never erases an earlier fact', () => {
  /*
   * The rule the whole module turns on. Without it, walking through a room
   * blanks the roster's knowledge of everybody in it, one name at a time.
   */
  const withAlignment = (): PlayerRegistry =>
    fold(
      NO_PLAYERS,
      block('who-list'),
      state({ online: roster({ name: 'Soul', alignment: 'Criminal' }) })
    );

  it('keeps an alignment through a room sighting that does not mention one', () => {
    const room = {
      ...EMPTY_CHARACTER.room,
      number: 12,
      occupants: [{ name: 'Soul', kind: 'player' as const }] as never
    };
    const players = fold(withAlignment(), block('room-exits'), state({ room }));
    expect(players['soul']).toMatchObject({ alignment: 'Criminal', lastRoom: 12 });
  });

  it('keeps an alignment through an arrival broadcast, which carries none', () => {
    // A provisional entry is one an arrival added; it has no alignment to state.
    const provisional = [
      { name: 'Soul', alignment: null, title: null, flags: null, gang: null, provisional: true }
    ];
    const players = fold(
      withAlignment(),
      block('player-enters', { player: 'Soul' }),
      state({ online: provisional as never })
    );
    expect(players['soul']!.alignment).toBe('Criminal');
  });

  it('lets a later listing state a different alignment', () => {
    const players = fold(
      withAlignment(),
      block('who-list'),
      state({ online: roster({ name: 'Soul', alignment: 'Good' }) })
    );
    expect(players['soul']!.alignment).toBe('Good');
  });
});

describe('leaving is remembered, not forgotten', () => {
  const seen = (): PlayerRegistry =>
    fold(NO_PLAYERS, block('who-list'), state({ online: roster({ name: 'Soul' }) }));

  it('marks somebody offline and keeps everything known about them', () => {
    const players = fold(
      seen(),
      block('player-exits', { player: 'Soul' }, 2_000),
      state({ online: [] })
    );
    expect(players['soul']).toMatchObject({ name: 'Soul', online: false });
  });

  it('keeps a disconnect the same way', () => {
    const players = fold(
      seen(),
      block('player-disconnects', { player: 'Soul' }, 2_000),
      state({ online: [] })
    );
    expect(players['soul']!.online).toBe(false);
  });

  /*
   * The other half of *a listing is authoritative*. The roster on the state has
   * always been replaced outright by a `who` — somebody absent from it has left
   * — and the registry was the one place that never heard it: a record went
   * offline only from the two broadcasts, so anybody who logged off while this
   * character was at a menu stayed online for ever.
   */
  it('marks somebody the next listing does not name offline', () => {
    const players = fold(
      seen(),
      block('who-list', {}, 2_000),
      state({ online: roster({ name: 'Soul' }) })
    );
    expect(players['soul']!.online).toBe(true);
    const gone = fold(
      players,
      block('who-list', {}, 3_000),
      state({ online: roster({ name: 'Yang' }) })
    );
    expect(gone['soul']!.online).toBe(false);
    expect(gone['yang']!.online).toBe(true);
  });

  /*
   * And it leaves the sighting clock alone, which is `allOffline`'s rule: a
   * listing that does not name somebody is not a sighting of them, and
   * stamping it now would answer "when did I last see them" with the moment
   * the client noticed they were gone.
   */
  it('does not move `lastSeen` when it does', () => {
    const players = seen();
    const before = players['soul']!.lastSeen;
    const gone = fold(
      players,
      block('who-list', {}, 90_000),
      state({ online: roster({ name: 'Yang' }) })
    );
    expect(gone['soul']!.lastSeen).toBe(before);
  });

  /*
   * Only on the listing. `state.online` is stale by design between `who`s —
   * that is what the arrival and departure broadcasts are for — so a sweep on
   * every block would mark somebody offline for not having been in the last
   * one.
   */
  it('does not sweep on an ordinary block', () => {
    const gone = fold(
      seen(),
      block('conversation-gossip', { player: 'Yang', message: 'hi' }, 2_000),
      state({ online: roster({ name: 'Yang' }) })
    );
    expect(gone['soul']!.online).toBe(true);
  });

  /*
   * Present-tense evidence outranks a listing that may not show it: the room
   * and party folds run after the sweep in the same pass, on purpose.
   */
  it('leaves somebody standing in this room online', () => {
    const room = {
      ...EMPTY_CHARACTER.room,
      number: 187,
      name: 'A Dusty Track',
      occupants: [{ name: 'Soul', kind: 'player' as const }] as never
    };
    const gone = fold(
      seen(),
      block('who-list', {}, 2_000),
      state({ online: roster({ name: 'Yang' }), room })
    );
    expect(gone['soul']!.online).toBe(true);
  });
});

describe('the party half', () => {
  const member = (name: string, vitals: unknown = null) =>
    ({
      name,
      className: null,
      health: null,
      mana: null,
      rank: null,
      activity: null,
      invited: false,
      vitals
    }) as never;

  it('records the absolute figures a member answered @health with', () => {
    const players = fold(
      NO_PLAYERS,
      block('party-list', {}, 5_000),
      state({
        party: {
          engaged: {},
          threatened: {},
          following: null,
          members: [member('Yang', { hp: 40, hpMax: 101, mana: 2, manaMax: 5 })]
        }
      })
    );
    expect(players['yang']).toMatchObject({
      inParty: true,
      vitals: { hp: 40, hpMax: 101 },
      vitalsAt: 5_000
    });
  });

  it('does not erase those figures when a later listing lacks them', () => {
    /*
     * A party listing gives a percentage and no numbers, and it arrives far
     * more often than an `@health` answer. Blanking on it would mean the
     * figures were gone a second after they arrived.
     */
    const first = fold(
      NO_PLAYERS,
      block('party-list', {}, 5_000),
      state({
        party: {
          engaged: {},
          threatened: {},
          following: null,
          members: [member('Yang', { hp: 40, hpMax: 101 })]
        }
      })
    );
    const second = fold(
      first,
      block('party-list', {}, 6_000),
      state({ party: { engaged: {}, threatened: {}, following: null, members: [member('Yang')] } })
    );
    expect(second['yang']!.vitals).toMatchObject({ hp: 40 });
  });

  it('clears the party flag for somebody who has left it, keeping the record', () => {
    const first = fold(
      NO_PLAYERS,
      block('party-list'),
      state({ party: { engaged: {}, threatened: {}, following: null, members: [member('Yang')] } })
    );
    const second = fold(first, block('party-list'), state());
    expect(second['yang']).toMatchObject({ name: 'Yang', inParty: false });
  });
});

describe('republishing only when something changed', () => {
  /*
   * The registry rides on every state push. A new object per line of somebody
   * else's chat would redraw every card in the client on their conversation.
   */
  it('returns the same registry when a sighting says nothing new', () => {
    const first = fold(
      NO_PLAYERS,
      block('conversation-local', { player: 'Rend', message: 'hi' }, 1_000),
      state()
    );
    const second = fold(
      first,
      block('conversation-local', { player: 'Rend', message: 'hi again' }, 2_000),
      state()
    );
    expect(second).toBe(first);
  });

  it('returns a new registry when a fact actually changed', () => {
    const first = fold(NO_PLAYERS, block('who-list'), state({ online: roster() }));
    const second = fold(
      first,
      block('who-list'),
      state({ online: roster({ alignment: 'Villain' }) })
    );
    expect(second).not.toBe(first);
  });
});

describe('an @ command is recorded against its sender', () => {
  it('counts refused attempts as well as answered ones', () => {
    let players = noteRemoteCall(NO_PLAYERS, 'Rend', 'do', 1_000);
    players = noteRemoteCall(players, 'Rend', 'health', 2_000);
    expect(players['rend']).toMatchObject({
      commandsSent: 2,
      lastCommand: 'health',
      lastCommandAt: 2_000
    });
  });

  it('files under one key however the name is capitalised', () => {
    let players = noteRemoteCall(NO_PLAYERS, 'Rend', 'do', 1_000);
    players = noteRemoteCall(players, 'rend', 'health', 2_000);
    expect(Object.keys(players)).toEqual(['rend']);
    expect(players['rend']!.commandsSent).toBe(2);
  });
});

describe('the listing the card reads', () => {
  it('puts who is here above who has gone, and orders each by recency', () => {
    let players = fold(
      NO_PLAYERS,
      block('who-list', {}, 1_000),
      state({ online: roster({ name: 'Soul' }, { name: 'Yang' }) })
    );
    players = fold(
      players,
      block('conversation-local', { player: 'Yang', message: 'hi' }, 3_000),
      state()
    );
    players = fold(players, block('player-exits', { player: 'Soul' }, 4_000), state());
    expect(knownPlayers(players).map((record) => record.name)).toEqual(['Yang', 'Soul']);
  });
});

describe('an @health answer is kept for anybody, not only the party', () => {
  /*
   * This used to be dropped for a stranger, because the only place to put it
   * was the party roster. The registry is not the roster, and telepathing
   * `@health` to somebody across the realm is exactly the case the absolute
   * numbers are worth having for.
   */
  const tracker = () => new CharacterTracker();

  const reply = (from: string, body: string, at = 9_000): Block =>
    ({
      type: 'conversation-telepath',
      domain: 'conversation',
      raw: '',
      plain: '',
      text: '',
      groups: { player: from, message: body },
      confidence: 1,
      at,
      seq: 1
    }) as unknown as Block;

  it('keeps the figures for somebody outside the party', () => {
    const track = tracker();
    track.apply(reply('Rend', '{HP=600/600}'));
    const record = track.current.players['rend'];
    expect(record?.vitals).toMatchObject({ hp: 600, hpMax: 600 });
    expect(record?.vitalsAt).toBe(9_000);
    // And does not invent a party member out of a chat message.
    expect(track.current.party.members).toEqual([]);
  });

  it('records the mana half only when the answer carried it', () => {
    const track = tracker();
    track.apply(reply('Rend', '{HP=600/600}'));
    expect(track.current.players['rend']?.vitals?.mana).toBeNull();
  });

  it('does not file this character answering itself', () => {
    const track = tracker();
    track.apply(reply('Rend', '{HP=1/1}'));
    expect(Object.keys(track.current.players)).toEqual(['rend']);
  });
});

describe('the party sweep does not walk the registry on every block', () => {
  /*
   * The sweep is O(registry) and the registry grows all session, so running it
   * per block made every line of somebody else's chat cost a walk of every name
   * ever seen. It runs only when the party has actually changed shape.
   */
  const member = (name: string) =>
    ({
      name,
      className: null,
      health: null,
      mana: null,
      rank: null,
      activity: null,
      invited: false,
      vitals: null
    }) as never;

  it('still clears the flag when somebody leaves', () => {
    const party = { engaged: {}, threatened: {}, following: null, members: [member('Yang')] };
    const first = fold(NO_PLAYERS, block('party-list'), state({ party }));
    expect(first['yang']!.inParty).toBe(true);
    const second = fold(first, block('party-list'), state());
    expect(second['yang']!.inParty).toBe(false);
  });

  it('does nothing at all when the party repeats itself', () => {
    const party = { engaged: {}, threatened: {}, following: null, members: [member('Yang')] };
    const first = fold(NO_PLAYERS, block('party-list'), state({ party }));
    const second = fold(first, block('party-list', {}, 2_000), state({ party }));
    expect(second).toBe(first);
  });

  it('handles a swap of one member for another', () => {
    const before = { engaged: {}, threatened: {}, following: null, members: [member('Yang')] };
    const after = { engaged: {}, threatened: {}, following: null, members: [member('Soul')] };
    const first = fold(NO_PLAYERS, block('party-list'), state({ party: before }));
    const second = fold(first, block('party-list'), state({ party: after }));
    expect(second['yang']!.inParty).toBe(false);
    expect(second['soul']!.inParty).toBe(true);
  });
});

describe('the quotation does not age backwards', () => {
  /*
   * A party listing arrives far more often than an `@health` answer. Stamping
   * `vitalsAt` on every one would age a five-minute-old quotation back to "just
   * now", which is the exact lie the field exists to prevent.
   */
  const member = (name: string, vitals: unknown) =>
    ({
      name,
      className: null,
      health: null,
      mana: null,
      rank: null,
      activity: null,
      invited: false,
      vitals
    }) as never;

  it('keeps the time the figures arrived across repeated listings', () => {
    const vitals = { hp: 40, hpMax: 101, mana: null, manaMax: null };
    let players = fold(
      NO_PLAYERS,
      block('party-list', {}, 1_000),
      state({
        party: { engaged: {}, threatened: {}, following: null, members: [member('Yang', vitals)] }
      })
    );
    // A later listing repeating the same figures, and a room sighting between
    // them so the record legitimately changes for another reason.
    players = fold(
      players,
      block('room-exits', {}, 50_000),
      state({
        room: {
          ...EMPTY_CHARACTER.room,
          number: 9,
          occupants: [{ name: 'Yang', kind: 'player' as const }] as never
        }
      })
    );
    players = fold(
      players,
      block('party-list', {}, 90_000),
      state({
        party: {
          engaged: {},
          threatened: {},
          following: null,
          members: [member('Yang', { ...vitals })]
        }
      })
    );
    expect(players['yang']!.vitalsAt).toBe(1_000);
  });

  it('moves it when the figures themselves are new', () => {
    let players = fold(
      NO_PLAYERS,
      block('party-list', {}, 1_000),
      state({
        party: {
          engaged: {},
          threatened: {},
          following: null,
          members: [member('Yang', { hp: 40, hpMax: 101, mana: null, manaMax: null })]
        }
      })
    );
    players = fold(
      players,
      block('party-list', {}, 90_000),
      state({
        party: {
          engaged: {},
          threatened: {},
          following: null,
          members: [member('Yang', { hp: 12, hpMax: 101, mana: null, manaMax: null })]
        }
      })
    );
    expect(players['yang']!.vitalsAt).toBe(90_000);
  });
});

/*
 * The pronoun is nobody, and the registry is persisted — so the guard is on
 * the funnel every sighting goes through as well as on the pattern that let it
 * in. A book written before the fix would otherwise hand the row back to every
 * session on the realm for ever.
 */
describe('the realm’s pronoun is never filed as a person', () => {
  it('files nothing for a line the classifier could still name `You` on', () => {
    const players = fold(
      NO_PLAYERS,
      block('conversation-gossip', { player: 'You', message: 'hi' }),
      state()
    );
    expect(players).toEqual(NO_PLAYERS);
  });

  it('files somebody whose name merely starts with it', () => {
    const players = fold(
      NO_PLAYERS,
      block('conversation-gossip', { player: 'Youngblood', message: 'hi' }),
      state()
    );
    expect(Object.keys(players)).toEqual(['youngblood']);
  });
});

describe('a monster is never filed as a person', () => {
  /*
   * Found by looking at the card in `npm run smoke`, not by a test here: every
   * case above fed names that happened to be players, so the registry filled
   * with `orc rogue` and `giant rat` and every assertion still passed.
   *
   * `combat.attackers` holds whatever is swinging — the tracker filters it with
   * `mobKey` elsewhere for exactly that reason — so the roster is the authority
   * for whether a name is a person.
   */
  const fighting = (attacker: string, over: Partial<CharacterState> = {}): CharacterState =>
    state({
      combat: { ...EMPTY_CHARACTER.combat, attackers: [attacker] },
      ...over
    });

  it('does not file an attacking monster', () => {
    const players = fold(NO_PLAYERS, block('combat-hit'), fighting('orc rogue'));
    expect(players).toEqual({});
  });

  it('does file an attacking player the realm has listed', () => {
    const players = fold(
      NO_PLAYERS,
      block('combat-hit'),
      fighting('Grimjaw', { online: roster({ name: 'Grimjaw', alignment: 'Outlaw' }) })
    );
    expect(players['grimjaw']).toMatchObject({ lastRoomAt: 1_000, alignment: 'Outlaw' });
  });

  it('does not file a name with no listing behind it, however capitalised', () => {
    // As likely a quest NPC as a person, and the card must not guess.
    const players = fold(NO_PLAYERS, block('combat-hit'), fighting('Nathaniel'));
    expect(players).toEqual({});
  });

  it('does not file an unknown room occupant as a player either', () => {
    const room = {
      ...EMPTY_CHARACTER.room,
      number: 3,
      occupants: [{ name: 'Nathaniel', kind: 'unknown' as const }] as never
    };
    const players = fold(NO_PLAYERS, block('room-exits'), state({ room }));
    expect(players).toEqual({});
  });
});
