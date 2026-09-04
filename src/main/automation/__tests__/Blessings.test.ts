import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Blessings } from '../Blessings';
import { CommandQueue } from '../CommandQueue';
import {
  DEFAULT_CONFIG,
  type AutomationConfig,
  type BlessingConfig,
  type SpellsConfig
} from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { Block } from '../../../shared/blocks';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

const armour: BlessingConfig = {
  spell: 'protection',
  target: 'self',
  minMana: 0.3,
  prioritizeOverHeal: false,
  inCombat: true
};

function spells(blessings: BlessingConfig[], notify = false): SpellsConfig {
  return {
    ...DEFAULT_CONFIG.automation.spells,
    blessings,
    notifyPartyOnWearOff: notify
  };
}

function state(over: Partial<CharacterState> = {}, vitals: Partial<CharacterState['vitals']> = {}) {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game' as const,
    name: 'Vaelor',
    vitals: { ...base.vitals, hp: 90, hpMax: 100, mana: 50, manaMax: 50, ...vitals },
    ...over
  };
}

const member = (name: string, invited = false) => ({
  name,
  activity: null,
  className: null,
  health: 1,
  invited,
  vitals: null,
  mana: null,
  rank: null
});

const party = (...names: string[]) => ({
  following: null,
  engaged: {},
  threatened: {},
  members: [member('Vaelor'), ...names.map((name) => member(name))]
});

function block(type: Block['type'], groups: Record<string, string>): Block {
  return { type, seq: 1, at: Date.now(), domain: 'game', groups } as unknown as Block;
}

let sent: string[];
let queue: CommandQueue;
beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});
afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

describe('keeping a blessing up on this character', () => {
  it('casts on entering the realm, by name, and again when the wire says it wore off', () => {
    const blessings = new Blessings(spells([armour]), true, queue);
    blessings.onCharacter(state());
    expect(sent).toEqual(['c protection']);

    // Confirmed on the wire: the buff is up, so nothing more goes out even
    // long past the proposal cooldown.
    const held = state({ buffs: [{ spell: 'protection', by: null, appliedAt: Date.now() }] });
    blessings.onCharacter(held);
    vi.advanceTimersByTime(30_000);
    expect(sent).toHaveLength(1);

    // The wear-off took it off the list; the very next state change recasts.
    blessings.onCharacter(state());
    expect(sent).toHaveLength(2);
    blessings.dispose();
  });

  /* Before anything has been measured, the shipped watchdog is the clock. */
  it('expires an unread ending by the shipped watchdog when nothing is measured', () => {
    const blessings = new Blessings(spells([armour]), true, queue);
    const applied = Date.now();
    blessings.onCharacter(
      state({ buffs: [{ spell: 'protection', by: null, appliedAt: applied }] })
    );
    vi.advanceTimersByTime(299_000);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual(['c protection']);
    blessings.dispose();
  });

  /*
   * A measured duration replaces the shipped watchdog, with slack on top so
   * the wear-off frame — the honest signal — always gets to speak first:
   * 60s measured fires at 75s, not at 60.
   */
  it('expires an unread ending by the measured duration plus slack', () => {
    const blessings = new Blessings(spells([armour]), true, queue, undefined, (spell) =>
      spell === 'protection' ? 60 : null
    );
    blessings.onCharacter(
      state({ buffs: [{ spell: 'protection', by: null, appliedAt: Date.now() }] })
    );
    vi.advanceTimersByTime(74_000);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual(['c protection']);
    blessings.dispose();
  });

  it('waits out a fight unless the entry allows it, and waits under its own mana floor', () => {
    const patient = new Blessings(spells([{ ...armour, inCombat: false }]), true, queue);
    patient.onCharacter(state({ inCombat: true }));
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);
    patient.dispose();

    const fighter = new Blessings(spells([armour]), true, queue);
    fighter.onCharacter(state({ inCombat: true }, { mana: 10 }));
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);
    fighter.onCharacter(state({ inCombat: true }));
    expect(sent).toEqual(['c protection']);
    fighter.dispose();
  });

  /* Unknown is not plenty: a caster whose sheet has not arrived waits for it. */
  it('waits for a mana maximum when the floor needs one', () => {
    const floored = new Blessings(spells([armour]), true, queue);
    floored.onCharacter(state({}, { mana: null, manaMax: null }));
    expect(sent).toEqual([]);
    floored.dispose();

    const free = new Blessings(spells([{ ...armour, minMana: 0 }]), true, queue);
    free.onCharacter(state({}, { mana: null, manaMax: null }));
    expect(sent).toEqual(['c protection']);
    free.dispose();
  });

  it('recasts one at a time, top of the list first', () => {
    const shield: BlessingConfig = { ...armour, spell: 'mage shield' };
    const blessings = new Blessings(spells([armour, shield]), true, queue);
    blessings.onCharacter(state());
    // Both are down; one proposal per pass, highest priority first.
    expect(sent).toEqual(['c protection']);
    // The next comes once the cooldown has passed and the first is up.
    vi.advanceTimersByTime(7_000);
    blessings.onCharacter(
      state({ buffs: [{ spell: 'protection', by: null, appliedAt: Date.now() }] })
    );
    expect(sent).toEqual(['c protection', 'c mage shield']);
    blessings.dispose();
  });

  it('proposes a prioritized entry from the urgent pass and not the normal one', () => {
    const first: BlessingConfig = { ...armour, prioritizeOverHeal: true };
    const blessings = new Blessings(spells([first]), true, queue);
    blessings.onCharacter(state());
    expect(sent).toEqual([]);
    blessings.urgent(state());
    expect(sent).toEqual(['c protection']);
    blessings.dispose();
  });

  /* The master switch gates every entry point, the urgent pass included. */
  it('never casts from the urgent pass with automation off', () => {
    const first: BlessingConfig = { ...armour, prioritizeOverHeal: true };
    const blessings = new Blessings(spells([first]), false, queue);
    blessings.urgent(state());
    expect(sent).toEqual([]);
    blessings.dispose();
  });

  /* A self cast goes out bare, so it needs no name at all. */
  it('casts on itself before the character name has arrived', () => {
    const blessings = new Blessings(spells([armour]), true, queue);
    blessings.onCharacter({ ...state(), name: null });
    expect(sent).toEqual(['c protection']);
    blessings.dispose();
  });

  /* And the word is the realm's short name, when either source can say it. */
  it('casts by the short word when the spellbook can name it', () => {
    const blessings = new Blessings(spells([armour]), true, queue);
    const listed = state();
    listed.spellbook = [{ name: 'protection', short: 'prot', level: null, cost: null }];
    blessings.onCharacter(listed);
    expect(sent).toEqual(['c prot']);
    blessings.dispose();
  });

  /*
   * The realm accepts `bles` wherever it accepts `bless`, and the cast
   * confirmation prints the whole name — so a configured abbreviation must
   * still recognise the recorded buff, or it is recast on the retry clock
   * for ever.
   */
  it('matches a configured abbreviation against the recorded name through the realm table', () => {
    // One realm row under both spellings, which is what the realm's own table
    // is: `spellNamed` answers the same row for the name and the abbreviation.
    const row = { id: 7, name: 'bless', short: 'bles' };
    const short: BlessingConfig = { ...armour, spell: 'bles' };
    const blessings = new Blessings(
      spells([short]),
      true,
      queue,
      undefined,
      () => null,
      (name) => (['bles', 'bless'].includes(name.toLowerCase()) ? row : null)
    );
    blessings.onCharacter(state({ buffs: [{ spell: 'bless', by: null, appliedAt: Date.now() }] }));
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);
    blessings.dispose();
  });

  it('stops its clock out of the realm and forgets on reset', () => {
    const blessings = new Blessings(spells([armour]), true, queue);
    blessings.onCharacter(state());
    expect(sent).toHaveLength(1);
    blessings.onCharacter({ ...state(), phase: 'unknown' });
    vi.advanceTimersByTime(120_000);
    expect(sent).toHaveLength(1);
    blessings.reset();
    blessings.onCharacter(state());
    expect(sent).toHaveLength(2);
    blessings.dispose();
  });

  it('is off with automation off', () => {
    const blessings = new Blessings(spells([armour]), false, queue);
    blessings.onCharacter(state());
    vi.advanceTimersByTime(120_000);
    expect(sent).toEqual([]);
    blessings.dispose();
  });
});

describe('blessing the party', () => {
  const bless: BlessingConfig = {
    spell: 'bless',
    target: 'party',
    minMana: 0,
    prioritizeOverHeal: false,
    inCombat: false,
    fallbackSeconds: 60
  };

  it('casts on listed members but never itself or an invitee, one at a time', () => {
    const blessings = new Blessings(spells([bless]), true, queue);
    const roster = state({
      party: {
        following: 'Soul',
        engaged: {},
        threatened: {},
        members: [member('Vaelor'), member('Soul'), member('Yang'), member('Rand', true)]
      }
    });
    blessings.onCharacter(roster);
    expect(sent).toEqual(['c bless Soul']);
    blessings.onBlock(
      block('spell-cast', { caster: 'You', spell: 'bless', target: 'Soul' }),
      roster
    );
    vi.advanceTimersByTime(7_000);
    expect(sent).toEqual(['c bless Soul', 'c bless Yang']);
    blessings.onBlock(
      block('spell-cast', { caster: 'You', spell: 'bless', target: 'Yang' }),
      roster
    );
    // Both clocks now run from their confirmations; nothing more until one lapses.
    vi.advanceTimersByTime(30_000);
    expect(sent).toHaveLength(2);
    // Soul's clock (started at 0s) lapses at 60s; Yang's (7s) has not yet.
    vi.advanceTimersByTime(24_000);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toBe('c bless Soul');
    blessings.dispose();
  });

  it('holds a party blessing during a fight unless the entry allows it', () => {
    const blessings = new Blessings(spells([bless]), true, queue);
    blessings.onCharacter(state({ inCombat: true, party: party('Soul') }));
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);
    blessings.dispose();
  });

  it('casts on nobody with no party', () => {
    const blessings = new Blessings(spells([bless]), true, queue);
    blessings.onCharacter(state());
    vi.advanceTimersByTime(5_000);
    expect(sent).toEqual([]);
    blessings.dispose();
  });

  it('restarts a member clock from the confirmed cast, and recasts at once on @bless-expired', () => {
    const blessings = new Blessings(spells([bless]), true, queue);
    blessings.onCharacter(state({ party: party('Soul') }));
    expect(sent).toEqual(['c bless Soul']);

    // The confirmation restarts the clock; the fallback runs from here.
    blessings.onBlock(
      block('spell-cast', { caster: 'You', spell: 'bless', target: 'Soul' }),
      state({ party: party('Soul') })
    );
    vi.advanceTimersByTime(59_000);
    expect(sent).toHaveLength(1);

    // Soul's client says it wore off: due now, not at the clock.
    blessings.onPeerExpired('Soul', 'bless');
    expect(sent).toEqual(['c bless Soul', 'c bless Soul']);
    blessings.dispose();
  });

  it('ignores a peer expiry naming no configured blessing', () => {
    const blessings = new Blessings(spells([bless]), true, queue);
    blessings.onCharacter(state({ party: party('Soul') }));
    sent.length = 0;
    vi.advanceTimersByTime(10_000);
    blessings.onPeerExpired('Soul', 'sanctuary');
    expect(sent).toEqual([]);
    blessings.dispose();
  });
});

describe('telling the caster a blessing wore off', () => {
  const withBuff = (by: string) =>
    state({
      party: party('Soul'),
      buffs: [{ spell: 'bless', by, appliedAt: Date.now() }]
    });

  it('telepaths @bless-expired to a listed member who cast it, only with the switch on', () => {
    const quiet = new Blessings(spells([], false), true, queue);
    quiet.onBlock(block('user-buff-expired', { spell: 'bless' }), withBuff('Soul'));
    expect(sent).toEqual([]);
    quiet.dispose();

    const telling = new Blessings(spells([], true), true, queue);
    telling.onBlock(block('user-buff-expired', { spell: 'bless' }), withBuff('Soul'));
    expect(sent).toEqual(['/Soul @bless-expired bless']);
    telling.dispose();
  });

  it('says nothing about its own casts or a caster who left the party', () => {
    const blessings = new Blessings(spells([], true), true, queue);
    blessings.onBlock(
      block('user-buff-expired', { spell: 'bless' }),
      state({ party: party('Soul'), buffs: [{ spell: 'bless', by: null, appliedAt: Date.now() }] })
    );
    blessings.onBlock(block('user-buff-expired', { spell: 'bless' }), withBuff('Rend'));
    expect(sent).toEqual([]);
    blessings.dispose();
  });
});

/**
 * A cast that cannot be paid for is not sent.
 *
 * The captured failure (todo 10, a live session): `way of the owl` costs 2 kai
 * and the character was at `KAI=1`, so every time the recast clock came round
 * the server answered `You do not have enough mana to cast that spell.` — out
 * loud, in the room. The floor above it (`minMana`) is the *player's* policy
 * and a floor of zero lets this through; this is the realm's arithmetic.
 */
describe('a blessing the pool cannot pay for', () => {
  const owl: BlessingConfig = { ...armour, spell: 'way of the owl', minMana: 0 };
  const realm = { id: 37, name: 'way of the owl', short: 'owl', mana: 2, level: 3 };
  const table = (name: string) =>
    name.toLowerCase() === 'way of the owl' || name.toLowerCase() === 'owl' ? realm : null;

  it('is not proposed, and no clock is spent on it', () => {
    const blessings = new Blessings(spells([owl]), true, queue, undefined, () => null, table);
    blessings.onCharacter(state({}, { mana: 1, manaMax: 30 }));
    expect(sent).toEqual([]);

    /*
     * And the moment the pool can pay for it, without waiting out the retry
     * clock — which is what "no clock is spent" buys, and is why nothing here
     * needed a timer or a queued intent waiting on a number. The status line
     * is both where mana changes and where this is asked again.
     */
    blessings.onCharacter(state({}, { mana: 2, manaMax: 30 }));
    expect(sent).toEqual(['c owl']);
    blessings.dispose();
  });

  /* Mana is one pool: a blessing this character cannot afford is one it cannot
     afford on anybody, so it stops rather than sending the same refusal once
     per member. */
  it('proposes for nobody in the party either', () => {
    const forParty: BlessingConfig = { ...owl, target: 'party' };
    const blessings = new Blessings(spells([forParty]), true, queue, undefined, () => null, table);
    blessings.onCharacter(state({ party: party('Soul', 'Yang') }, { mana: 1, manaMax: 30 }));
    expect(sent).toEqual([]);
    blessings.dispose();
  });

  /*
   * Unknown does not refuse. A cost nothing has stated is absence, and standing
   * every cast down for want of a lookup would leave a character on a realm
   * this client ships no data for unable to bless at all — the server's own
   * refusal is the honest failure there.
   */
  it('still casts a spell nothing has priced', () => {
    const unpriced: BlessingConfig = { ...armour, minMana: 0 };
    const blessings = new Blessings(
      spells([unpriced]),
      true,
      queue,
      undefined,
      () => null,
      () => null
    );
    blessings.onCharacter(state({}, { mana: 1, manaMax: 30 }));
    expect(sent).toEqual(['c protection']);
    blessings.dispose();
  });

  /* The character's own listing outranks the realm table: it is the wire's
     word on what *this* character pays. */
  it("takes the cost from the character's own listing before the realm table", () => {
    const blessings = new Blessings(spells([owl]), true, queue, undefined, () => null, table);
    blessings.onCharacter(
      state(
        { spellbook: [{ name: 'way of the owl', short: 'owl', level: 3, cost: 9 }] },
        { mana: 5, manaMax: 30 }
      )
    );
    expect(sent).toEqual([]);
    blessings.dispose();
  });
});

describe("the server's own countdown", () => {
  /*
   * Paramud's `st` prints `You feel safe from evil! (90s)`; the tracker
   * attributes it to the buff and this trusts it outright. Before it existed
   * the only clock was the 300s watchdog, so a 90s shield was believed up for
   * three and a half minutes after it had gone.
   */
  it('recasts when the stated countdown runs out, not on the watchdog', () => {
    const blessings = new Blessings(spells([armour]), true, queue);
    const applied = Date.now();
    blessings.onCharacter(
      state({
        buffs: [{ spell: 'protection', by: null, appliedAt: applied, expiresAt: applied + 90_000 }]
      })
    );
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(89_000);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual(['c protection']);
    blessings.dispose();
  });

  /* A stated countdown outranks a measured duration, being the live answer. */
  it('outranks the measured duration', () => {
    const blessings = new Blessings(
      spells([armour]),
      true,
      queue,
      () => Date.now(),
      // Measured at ten minutes; the server says thirty seconds.
      () => 600
    );
    const applied = Date.now();
    blessings.onCharacter(
      state({
        buffs: [{ spell: 'protection', by: null, appliedAt: applied, expiresAt: applied + 30_000 }]
      })
    );
    vi.advanceTimersByTime(31_000);
    expect(sent).toEqual(['c protection']);
    blessings.dispose();
  });
});

describe('a cast that failed', () => {
  /*
   * `You attempt to cast protection, but fail.` — nothing landed, so the
   * shield is still down. Without this the recast waited out `blessRetryMs`
   * (30s) as though the cast might still be in flight.
   */
  it('is retried on the next round rather than after the retry floor', () => {
    const blessings = new Blessings(spells([armour]), true, queue);
    blessings.onCharacter(state());
    expect(sent).toEqual(['c protection']);

    // Nothing on the list: the cast failed. Without the block, the next pass
    // is held by the retry floor.
    blessings.onCharacter(state());
    vi.advanceTimersByTime(7000);
    blessings.onCharacter(state());
    expect(sent).toHaveLength(1);

    blessings.onBlock(block('spell-failed', { spell: 'protection' }), state());
    blessings.onCharacter(state());
    expect(sent).toEqual(['c protection', 'c protection']);
    blessings.dispose();
  });

  /* An offensive cast that failed names its target and is not a blessing. */
  it('ignores a failure that names a target', () => {
    const blessings = new Blessings(spells([armour]), true, queue);
    blessings.onCharacter(state());
    vi.advanceTimersByTime(7000);
    blessings.onBlock(block('spell-failed', { spell: 'protection', target: 'Covenant' }), state());
    blessings.onCharacter(state());
    expect(sent).toHaveLength(1);
    blessings.dispose();
  });
});
