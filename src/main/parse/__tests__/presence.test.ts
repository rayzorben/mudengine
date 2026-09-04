import { describe, expect, it } from 'vitest';

import {
  gangOf,
  percent,
  rankOf,
  rosterFrom,
  withArrival,
  withJoined,
  withLeft,
  withGangListing,
  withPartyListing,
  withRemoteVitals,
  withoutPlayer,
  raceAndClass
} from '../presence';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';

/*
 * The cluster lifted out of `CharacterTracker` on 2026-08-29. The behaviour is
 * pinned by the tracker's own tests, which feed the wire; these are the pure
 * functions asked directly, at the edges the tracker's tests reach only
 * indirectly.
 */
const state = (over: Partial<CharacterState> = {}): CharacterState => ({
  ...structuredClone(EMPTY_CHARACTER),
  ...over
});

describe('reading a listing', () => {
  it('keeps the whole row and reads None as no gang', () => {
    expect(
      rosterFrom([
        { name: 'Soul', alignment: 'Good', title: 'Squire', flags: 'S', gang: 'Old Guard' },
        { name: 'Rand', alignment: 'Nonsense', title: 'Apprentice', gang: 'None' },
        { title: 'nobody' }
      ])
    ).toEqual([
      {
        name: 'Soul',
        alignment: 'Good',
        title: 'Squire',
        flags: 'S',
        gang: 'Old Guard',
        provisional: false
      },
      {
        name: 'Rand',
        alignment: null,
        title: 'Apprentice',
        flags: null,
        gang: null,
        provisional: false
      }
    ]);
    expect(gangOf(undefined)).toBeNull();
    expect(gangOf(' Rivals ')).toBe('Rivals');
  });

  it('reads a percentage as a fraction, clamped, and null when absent', () => {
    expect(percent('62')).toBe(0.62);
    expect(percent('140')).toBe(1);
    expect(percent(undefined)).toBeNull();
    expect(rankOf('Frontrank')).toBe('front');
    expect(rankOf('Midrank')).toBe('mid');
    expect(rankOf('elsewhere')).toBeNull();
  });
});

describe('the roster between listings', () => {
  it('adds an arrival provisionally, once, and removes a departure', () => {
    const arrived = withArrival(state(), 'Soul');
    expect(arrived?.online).toEqual([
      { name: 'Soul', alignment: null, title: null, flags: null, gang: null, provisional: true }
    ]);
    expect(withArrival(arrived!, 'Soul')).toBeNull();
    expect(withoutPlayer(arrived!, 'Soul')?.online).toEqual([]);
    expect(withoutPlayer(state(), 'Soul')).toBeNull();
  });
});

describe('the party', () => {
  it('is no party alone, and a party while an invitation is out', () => {
    expect(
      withPartyListing(state(), [{ name: 'Vaelor', health: '100' }], false)?.party.members
    ).toEqual([]);
    const invited = withPartyListing(
      state(),
      [
        { name: 'Vaelor', health: '100' },
        { name: 'Soul', invited: 'yes' }
      ],
      false
    );
    expect(invited?.party.members.map((m) => [m.name, m.invited])).toEqual([
      ['Vaelor', false],
      ['Soul', true]
    ]);
  });

  it('ends when the leader leaves, and when the last other member does', () => {
    const two = withPartyListing(
      state(),
      [
        { name: 'Vaelor', health: '100' },
        { name: 'Soul', health: '40' }
      ],
      false
    )!;
    expect(withLeft(two, true, undefined)?.party.members).toEqual([]);
    expect(withLeft(two, false, 'Soul')?.party.members).toEqual([]);
    expect(withJoined(two, undefined, 'Rand')?.party.members.map((m) => m.name)).toEqual([
      'Vaelor',
      'Soul',
      'Rand'
    ]);
  });

  /* A quotation, landing on the member it names and in the registry. */
  it("takes another client's numbers onto its member and into the registry", () => {
    const two = withPartyListing(
      state({ name: 'Vaelor' }),
      [
        { name: 'Vaelor', health: '100' },
        { name: 'Soul', health: '40' }
      ],
      false
    )!;
    const answered = withRemoteVitals(two, 'Soul', '{HP=200/400,MA=10/20}', 5)!;
    const soul = answered.party.members.find((m) => m.name === 'Soul')!;
    expect(soul.vitals).toEqual({ hp: 200, hpMax: 400, mana: 10, manaMax: 20 });
    expect(soul.health).toBe(0.5);
    expect(soul.mana).toBe(0.5);
    expect(answered.players['soul']?.vitalsAt).toBe(5);
    // Not a reply: nothing changes.
    expect(withRemoteVitals(two, 'Soul', 'hello there', 6)).toBeNull();
  });
});

describe('the gang listing', () => {
  /*
   * The rows as `bg` produced them on the live realm, already through the
   * classifier. `Soul Guardian` arrives split because the pattern reads the
   * surname into its own group, exactly as the party listing does.
   */
  const ROWS: Array<Record<string, string>> = [
    { name: 'Vaelor', level: '28', who: 'Half-Ogre Mystic', online: 'Online', rank: 'Leader' },
    { name: 'Soul', last: 'Guardian', level: '1', who: 'Human Warrior', online: 'Online' }
  ];

  it('files a level, a race and a class against each member', () => {
    const after = withGangListing(state(), 'Valor', '2', ROWS, 10)!;
    expect(after.players['vaelor']).toMatchObject({
      name: 'Vaelor',
      gang: 'Valor',
      level: 28,
      race: 'Half-Ogre',
      className: 'Mystic',
      online: true
    });
  });

  /*
   * A surname is decoration, not identity. `GMUDServer.GetPlayers` matches a
   * typed name against `plyr.Name` and never looks at `LastName`, so
   * `Soul Guardian` is addressed as `Soul` — and every other listing this
   * client reads files them that way. Joining the two here filed one person
   * under two keys and drew them as two members of the same gang.
   */
  it('files a member under the first name alone, as every other listing does', () => {
    const after = withGangListing(state(), 'Valor', '2', ROWS, 10)!;
    expect(after.players['soul']).toMatchObject({
      name: 'Soul',
      level: 1,
      race: 'Human',
      className: 'Warrior'
    });
    expect(after.players['soul guardian']).toBeUndefined();
  });

  /*
   * The reason to read this listing rather than `who`. An offline member has
   * no row in `who` at all — there is nothing to notice the absence of — so
   * this is the only place the client can learn they exist.
   */
  it('records a member who is not logged in, as offline rather than absent', () => {
    const after = withGangListing(
      state(),
      'Valor',
      '3',
      [...ROWS, { name: 'Offliner', level: '7', who: 'Human Warrior' }],
      10
    )!;
    expect(after.players['offliner']).toMatchObject({ online: false, level: 7 });
  });

  /*
   * The listing is authoritative about the gang, so a member it stops marking
   * `- Online` has gone. Positive control: the same fold is observed to have
   * *taken* — the level arrives — so a passing assertion cannot be a listing
   * that was never read.
   */
  it('takes a member offline when a later listing stops marking them online', () => {
    const on = withGangListing(state(), 'Valor', '2', ROWS, 10)!;
    expect(on.players['vaelor']?.online).toBe(true);
    const off = withGangListing(
      on,
      'Valor',
      '1',
      [{ name: 'Vaelor', level: '29', who: 'Half-Ogre Mystic' }],
      20
    )!;
    expect(off.players['vaelor']?.level).toBe(29);
    expect(off.players['vaelor']?.online).toBe(false);
  });

  // Nothing changed is nothing published: the registry rides on every push.
  it('returns null when the same listing arrives twice', () => {
    const once = withGangListing(state(), 'Valor', '2', ROWS, 10)!;
    expect(withGangListing(once, 'Valor', '2', ROWS, 20)).toBeNull();
  });

  it("reads the realm's one two-word race without eating the class", () => {
    expect(raceAndClass('Gaunt One Druid')).toEqual({ race: 'Gaunt One', className: 'Druid' });
    expect(raceAndClass('Half-Ogre Mystic')).toEqual({ race: 'Half-Ogre', className: 'Mystic' });
  });

  /*
   * A pair this client cannot split is two fields it says nothing about. A
   * guessed class would be drawn on the card as fact.
   */
  it('refuses a pair it cannot split rather than guessing', () => {
    expect(raceAndClass('Mystic')).toEqual({ race: null, className: null });
    expect(raceAndClass(undefined)).toEqual({ race: null, className: null });
    expect(raceAndClass('Gaunt One')).toEqual({ race: null, className: null });
  });
});
