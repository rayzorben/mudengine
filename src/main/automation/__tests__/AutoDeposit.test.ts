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
  ...over
});

/** A character in the realm carrying `wealth` copper. */
function carrying(wealth: number | null): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return { ...base, phase: 'in-game', inventory: { ...base.inventory, wealth } };
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

const make = (over: Partial<BankingConfig> = {}, atBank = true, enabled = true): AutoDeposit =>
  new AutoDeposit(config(over), enabled, queue, () => atBank);
const drain = (): void => void vi.advanceTimersByTime(500);

describe('banking the purse', () => {
  it('deposits the surplus at a counter, and asks the vault its figure behind it', () => {
    const auto = make();
    auto.onCharacter(carrying(600_000));
    drain();
    // The Deposit All button's own sequence, whole: `i` restates the purse a
    // moment before the figure is spent, then the sampled verb and a number
    // in copper — `dep all` has never been seen on this wire — then `bank`.
    expect(sent).toEqual(['i', 'deposit 595000', 'bank']);
  });

  it('does nothing below the threshold', () => {
    const auto = make();
    auto.onCharacter(carrying(500_000));
    drain();
    expect(sent).toEqual([]);
  });

  it('does nothing away from a counter, however rich the purse', () => {
    const auto = make({}, false);
    auto.onCharacter(carrying(2_000_000));
    drain();
    expect(sent).toEqual([]);
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
    make({}, true, false).onCharacter(carrying(600_000));
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
    auto.onCharacter(carrying(600_000));
    drain();
    expect(sent).toEqual(['i', 'deposit 595000', 'bank']);

    vi.advanceTimersByTime(11_000);
    auto.onCharacter(carrying(600_000));
    drain();
    expect(sent).toEqual(['i', 'deposit 595000', 'bank']);

    auto.onCharacter(carrying(580_000));
    drain();
    expect(sent).toEqual(['i', 'deposit 595000', 'bank', 'i', 'deposit 575000', 'bank']);
  });
});
