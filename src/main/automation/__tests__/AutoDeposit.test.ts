import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoDeposit } from '../AutoDeposit';
import { CommandQueue } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig, type BankingConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

const config = (over: Partial<BankingConfig> = {}): BankingConfig => ({
  autoDeposit: true,
  depositThresholdCopper: 500_000,
  keepCopper: 5_000,
  // Whichever counter it is standing at, which is what every file did before
  // the setting existed.
  bank: 0,
  ...over
});

/** The shop row the tests' bank counter is. */
const COUNTER = 42;

/** A character in the realm carrying `wealth` copper. */
function carrying(wealth: number | null): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return { ...base, phase: 'in-game', inventory: { ...base.inventory, wealth } };
}

let sent: string[];
let said: string[];
let queue: CommandQueue;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  said = [];
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (
  over: Partial<BankingConfig> = {},
  /** The counter in front of the character: a shop row, or null for no bank. */
  here: number | null = COUNTER,
  enabled = true
): AutoDeposit =>
  new AutoDeposit(config(over), enabled, queue, () => here, {
    notice: (message) => said.push(message)
  });
const drain = (): void => void vi.advanceTimersByTime(500);

/**
 * A whole round: the threshold asks, the `i` reaches the socket, the listing
 * comes back saying `listed`, and the deposit is composed from *that*.
 *
 * The two drains are the point of the shape and not ceremony — the figure
 * cannot be composed until the refresh has been answered, which is exactly
 * what the three-command button could not wait for.
 */
const round = (auto: AutoDeposit, believed: number, listed = believed): void => {
  auto.onCharacter(carrying(believed));
  drain();
  auto.onListing(carrying(listed));
  drain();
};

describe('banking the purse', () => {
  it('deposits the surplus at a counter, and asks the vault its figure behind it', () => {
    const auto = make();
    round(auto, 600_000);
    // The whole sequence: `i` restates the purse, then the sampled verb and a
    // number in copper — `dep all` has never been seen on this wire — then
    // `bank`.
    expect(sent).toEqual(['i', 'deposit 595000', 'bank']);
  });

  /*
   * **The regression, and the reason this module has two entry points.**
   *
   * Both figures below are the reported ones: the client believed 192,600
   * because two levels' training (1000 + 1200) had gone unread, and the
   * listing said 190,400. The old shape composed `deposit 192600` beside the
   * `i` meant to correct it — same millisecond, 71ms before the answer — and
   * this server refuses an over-deposit in silence, so nothing happened at all
   * (`logs/2026-09-04_20-39-52_festus`).
   *
   * Two facts, one test: the deposit names the *listing's* figure, and it
   * names it after the refresh rather than beside it.
   */
  it('composes the deposit from the listing, never from the figure it asked with', () => {
    const auto = make({ depositThresholdCopper: 100_000, keepCopper: 0 });
    auto.onCharacter(carrying(192_600));
    drain();
    expect(sent).toEqual(['i']);

    auto.onListing(carrying(190_400));
    drain();
    expect(sent).toEqual(['i', 'deposit 190400', 'bank']);
  });

  /*
   * A listing that arrived before the refresh reached the socket answers an
   * *older* ask — the player's own `i` a moment earlier — and an older ask is
   * the stale figure this exists to refuse. It is held for the next one.
   */
  it('ignores a listing that landed before its own refresh was sent', () => {
    const auto = make({ depositThresholdCopper: 100_000, keepCopper: 0 });
    // The player has a half-typed line, so the queue holds the refresh: the
    // ask has been made and nothing has been asked of the server yet.
    queue.noteTyping(true);
    auto.onCharacter(carrying(192_600));
    drain();
    expect(sent).toEqual([]);

    // A listing arrives anyway — the answer to an `i` the player sent a moment
    // before pressing. It states the purse *before* whatever the held refresh
    // will find, which is the whole reason it is not taken.
    auto.onListing(carrying(192_600));
    drain();
    expect(sent).toEqual([]);

    queue.noteTyping(false);
    drain();
    expect(sent).toEqual(['i']);
    auto.onListing(carrying(190_400));
    drain();
    expect(sent).toEqual(['i', 'deposit 190400', 'bank']);
  });

  /*
   * The purse can turn out to be smaller than the maintained figure claimed —
   * that is the whole reason for the refresh — and a deposit of nothing is not
   * sent. Said out loud, because a press that reports nothing is
   * indistinguishable from a button that does not work, which is what the old
   * one was.
   */
  it('banks nothing on an empty listing, and says so', () => {
    const auto = make({ depositThresholdCopper: 100_000, keepCopper: 0 });
    round(auto, 192_600, 0);
    expect(sent).toEqual(['i']);
    expect(said).toHaveLength(1);
  });

  /*
   * A character can walk out of a bank inside the round trip the listing
   * takes, and a `deposit` typed anywhere else is *said out loud* to everybody
   * in the room. So the counter is checked again at the moment the figure is
   * composed, not only when it was asked for.
   */
  it('refuses to compose a deposit for a room the character has left', () => {
    let here: number | null = COUNTER;
    const auto = new AutoDeposit(
      config({ depositThresholdCopper: 100_000 }),
      true,
      queue,
      () => here,
      { notice: (message) => said.push(message) }
    );
    auto.onCharacter(carrying(192_600));
    drain();
    expect(sent).toEqual(['i']);

    here = null;
    auto.onListing(carrying(192_600));
    drain();
    expect(sent).toEqual(['i']);
    expect(said).toHaveLength(1);
  });

  it('does nothing below the threshold', () => {
    const auto = make();
    auto.onCharacter(carrying(500_000));
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * And says nothing either. The press refuses out loud, because a person
   * asked; a threshold re-derived from every status line must not, or a rich
   * character walking through a town prints that refusal several times a
   * second — the terminal talking over the realm.
   */
  it('does nothing away from a counter, however rich the purse, and says nothing', () => {
    const auto = make({}, null);
    for (let i = 0; i < 5; i += 1) auto.onCharacter(carrying(2_000_000));
    drain();
    expect(sent).toEqual([]);
    expect(said).toEqual([]);
  });

  /* Unknown is not rich: no listing has stated a purse, so nothing is
     composed from it. */
  it('never deposits on an unread purse', () => {
    const auto = make();
    auto.onCharacter(carrying(null));
    drain();
    expect(sent).toEqual([]);
  });

  it('holds during combat', () => {
    const auto = make();
    auto.onCharacter({ ...carrying(600_000), inCombat: true });
    drain();
    expect(sent).toEqual([]);
  });

  /* Whether an inventory command breaks a rest is unmeasured — AutoLoot's
     reason, and the same refusal. */
  it('holds while resting', () => {
    const auto = make();
    const resting = carrying(600_000);
    auto.onCharacter({ ...resting, vitals: { ...resting.vitals, resting: true } });
    drain();
    expect(sent).toEqual([]);
  });

  it('is off unless asked, and silenced by the master switch', () => {
    make({ autoDeposit: false }).onCharacter(carrying(600_000));
    make({}, COUNTER, false).onCharacter(carrying(600_000));
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * The deposit sentence is what moves the purse, and it is a round trip
   * away: a status line arriving before it must not propose the same deposit
   * again.
   */
  it('asks once per cooldown, not once per status line', () => {
    const auto = make();
    auto.onCharacter(carrying(600_000));
    auto.onCharacter(carrying(600_000));
    drain();
    auto.onListing(carrying(600_000));
    drain();
    expect(sent).toEqual(['i', 'deposit 595000', 'bank']);
  });

  /*
   * A deposit the server refused moves nothing, so an unchanged purse must
   * not earn the identical refused command once per cooldown for as long as
   * the character stands at the counter. The `i` is what corrects the figure,
   * and the corrected figure is what frees the next ask.
   */
  it('does not re-ask on an unchanged purse, and does on a corrected one', () => {
    const auto = make();
    round(auto, 600_000);
    expect(sent).toEqual(['i', 'deposit 595000', 'bank']);

    vi.advanceTimersByTime(11_000);
    round(auto, 600_000);
    expect(sent).toEqual(['i', 'deposit 595000', 'bank']);

    round(auto, 580_000);
    expect(sent).toEqual(['i', 'deposit 595000', 'bank', 'i', 'deposit 575000', 'bank']);
  });
});

/*
 * The console's `Deposit All`, which is the same sequence with two figures
 * changed: it keeps nothing back, and it goes out in the `user` band because a
 * person pressed it — so it is not silenced by the automation master switch,
 * which is off for anybody who only wants the button.
 */
describe('the console’s Deposit All', () => {
  const pressed = (auto: AutoDeposit, state: CharacterState): boolean =>
    auto.request(0, 'user', state);

  it('keeps nothing back, unlike the threshold', () => {
    const auto = make();
    expect(pressed(auto, carrying(190_400))).toBe(true);
    drain();
    auto.onListing(carrying(190_400));
    drain();
    expect(sent).toEqual(['i', 'deposit 190400', 'bank']);
  });

  /*
   * The button lives in the backscroll, where the room beside it is not the
   * room the character is in — so a press an hour later must not send a
   * `deposit` into a corridor, where the server says it out loud to everybody
   * standing there.
   */
  /*
   * Which bank, when the player has said (todo 00).
   *
   * A balance spread across four vaults is four figures nobody can add up, and
   * the realm states each separately — so a character whose vault is somewhere
   * particular must not deposit at whichever counter it walks past.
   */
  it('deposits at the counter the player chose', () => {
    const auto = make({ bank: COUNTER, depositThresholdCopper: 100_000 });
    round(auto, 192_600);
    expect(sent).toEqual(['i', 'deposit 187600', 'bank']);
  });

  it('refuses at a counter that is not the chosen one, and says which fact stopped it', () => {
    const auto = make({ bank: 7, depositThresholdCopper: 100_000 });
    expect(pressed(auto, carrying(190_400))).toBe(false);
    drain();
    expect(sent).toEqual([]);
    expect(said.join('\n')).toMatch(/not the bank this character banks at/i);
  });

  /* And silently on the threshold, for the reason the not-a-bank refusal is
     silent there: it is re-derived from every status line. */
  it('says nothing on the threshold at a counter that is not the chosen one', () => {
    const auto = make({ bank: 7, depositThresholdCopper: 100_000 });
    for (let i = 0; i < 5; i += 1) auto.onCharacter(carrying(2_000_000));
    drain();
    expect(sent).toEqual([]);
    expect(said).toEqual([]);
  });

  /* 0 is *whichever counter it is standing at*, which is what every file did
     before the setting existed, so it agrees with every bank. */
  it('banks at any counter while no bank is chosen', () => {
    const auto = make({ bank: 0, depositThresholdCopper: 100_000 });
    round(auto, 192_600);
    expect(sent).toEqual(['i', 'deposit 187600', 'bank']);
  });

  /*
   * The counter is checked again when the deposit is composed, so walking from
   * one bank into another between the `i` and its answer refuses rather than
   * banking at the wrong vault.
   */
  it('refuses to compose a deposit at a different bank than the one it asked from', () => {
    let here: number | null = COUNTER;
    const auto = new AutoDeposit(
      config({ bank: COUNTER, depositThresholdCopper: 100_000 }),
      true,
      queue,
      () => here,
      { notice: (message) => said.push(message) }
    );
    auto.onCharacter(carrying(192_600));
    drain();
    expect(sent).toEqual(['i']);

    here = 7;
    auto.onListing(carrying(192_600));
    drain();
    expect(sent).toEqual(['i']);
    expect(said.join('\n')).toMatch(/not the bank this character banks at/i);
  });

  it('refuses away from a counter, and says why', () => {
    const auto = make({}, null);
    expect(pressed(auto, carrying(190_400))).toBe(false);
    drain();
    expect(sent).toEqual([]);
    expect(said).toHaveLength(1);
  });

  it('does nothing outside the realm', () => {
    const auto = make();
    // A `deposit` typed at a login menu is a menu answer.
    expect(pressed(auto, { ...carrying(190_400), phase: 'authenticating' })).toBe(false);
    drain();
    expect(sent).toEqual([]);
  });

  /* A second press before the first listing lands is the same request. */
  it('is one request however often it is pressed', () => {
    const auto = make();
    expect(pressed(auto, carrying(190_400))).toBe(true);
    expect(pressed(auto, carrying(190_400))).toBe(false);
    drain();
    auto.onListing(carrying(190_400));
    drain();
    expect(sent).toEqual(['i', 'deposit 190400', 'bank']);
  });

  /*
   * The master switch is the player saying *do not act unasked*. A press is an
   * ask, so it goes out in the band that outranks the switch — otherwise the
   * button would be dead for everybody who has automation off, which is the
   * default.
   */
  it('works with the automation master switch off', () => {
    const off = new CommandQueue(
      { ...automation, enabled: false },
      { send: (command) => sent.push(command) }
    );
    try {
      const auto = new AutoDeposit(config(), false, off, () => COUNTER, {
        notice: (message) => said.push(message)
      });
      expect(pressed(auto, carrying(190_400))).toBe(true);
      vi.advanceTimersByTime(500);
      auto.onListing(carrying(190_400));
      vi.advanceTimersByTime(500);
      expect(sent).toEqual(['i', 'deposit 190400', 'bank']);
    } finally {
      off.dispose();
    }
  });
});
