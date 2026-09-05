import { describe, expect, it } from 'vitest';

import { actionsFor } from '../actions';

describe('an exit the realm names a command for', () => {
  /*
   * `go manhole` is the whole of how that exit works — no direction walks it —
   * so the button is the only way through one that does not require knowing
   * the realm data by heart.
   */
  it('offers the realm’s own command, verbatim', () => {
    expect(actionsFor(undefined, ['go manhole'], null)).toEqual([
      {
        label: 'go manhole',
        commands: ['go manhole'],
        title: 'Take exit: go manhole'
      }
    ]);
  });

  it('offers nothing for a room whose exits name no command', () => {
    expect(actionsFor(undefined, [], null)).toEqual([]);
  });

  /*
   * These sit on the room's own line, so a row of eight would push the name
   * off the screen.
   */
  it('caps what one line can carry', () => {
    expect(actionsFor('bank', ['a', 'b', 'c', 'd', 'e', 'f'], 500, 900)).toHaveLength(4);
  });

  /*
   * **The button carries no figure, and this test is the regression.**
   *
   * It used to be `['i', 'deposit 123456', 'bank']`, composed when the room's
   * name printed and documented as refreshing its own figure — which it cannot
   * do, because the number is a literal by then and all three strings leave
   * the client together (`logs/2026-09-04_20-39-52_festus`, t=771361: the
   * corrected `Wealth:` arrived 71ms after the deposit was on the wire, and
   * the over-deposit it caused was refused in silence). What the console sends
   * now is the name of an action; `AutoDeposit` sends the `i` and composes the
   * amount from the listing that answers it.
   */
  it('names an action and never a figure', () => {
    expect(actionsFor('bank', [], 123_456)).toEqual([
      {
        label: 'Deposit All',
        act: 'deposit-all',
        title: 'Read the purse and deposit all of it into this bank vault'
      }
    ]);
  });

  /*
   * Null is nobody having said, and unknown is not zero: a button offered on
   * an absence has no outcome but a refusal. The purse decides only *whether*
   * to offer it — never what it deposits.
   */
  it('offers nothing until a listing has stated a purse', () => {
    expect(actionsFor('bank', [], null)).toEqual([]);
    expect(actionsFor('bank', [], 0)).toEqual([]);
  });

  it('offers no bank action anywhere but a bank', () => {
    expect(actionsFor('temple', [], 500)).toEqual([]);
    expect(actionsFor(undefined, [], 500)).toEqual([]);
  });

  it('puts the shop’s own action before the way out', () => {
    const actions = actionsFor('bank', ['go manhole'], 500);
    expect(actions.map((a) => a.act ?? a.commands.join('; '))).toEqual([
      'deposit-all',
      'go manhole'
    ]);
  });

  /*
   * Two authorities, two casings. A label we composed is Capital Case; a label
   * that *is* the realm's command text is quoted, and recasing it would make
   * the button's face disagree with what it sends — which is the one string on
   * screen a player might retype.
   *
   * Deliberately unlike the sentence case every authored label elsewhere in
   * `ui.en.yaml` uses: those sit in chrome and read as prose, and these sit on
   * the game's own line among the realm's own words, where the case is what
   * separates a control from the text beside it.
   */
  it('capitalises a label it wrote and quotes one the realm wrote', () => {
    const [deposit, exit] = actionsFor('bank', ['go manhole'], 500);

    expect(deposit?.label).toBe('Deposit All');
    expect(exit?.label).toBe('go manhole');
    expect(exit?.label).toBe(exit?.commands?.[0]);
  });
});

describe('taking the vault out', () => {
  /*
   * `withdraw` is the server's own verb and the figure is what `bank` last
   * printed for this vault. Then `i`, because the withdrawal's own sentence is
   * not read — it arrives glued to the status prompt (see patterns.ts beside
   * `user-deposits`) — and then `bank`, because nothing maintains a balance.
   */
  it('withdraws what the vault last said it held, then re-reads both', () => {
    expect(actionsFor('bank', [], null, 7984)).toEqual([
      {
        label: 'Withdraw All',
        commands: ['withdraw 7984', 'i', 'bank'],
        title: 'Withdraw all coins from bank vault (7984 copper)'
      }
    ]);
  });

  it('offers both when there is money on both sides of the counter', () => {
    const actions = actionsFor('bank', ['go manhole'], 500, 7984);
    expect(actions.map((a) => a.label)).toEqual(['Deposit All', 'Withdraw All', 'go manhole']);
  });

  /*
   * Null is the vault never having been asked, and unknown is not zero: a
   * `withdraw 0` would act on an absence. Zero is an emptied vault, and there
   * is nothing to take out of one.
   */
  it('offers nothing until the vault has stated a balance, or when it is empty', () => {
    expect(actionsFor('bank', [], null, null)).toEqual([]);
    expect(actionsFor('bank', [], null, 0)).toEqual([]);
  });

  it('offers no withdrawal anywhere but a bank', () => {
    expect(actionsFor('temple', [], null, 7984)).toEqual([]);
    expect(actionsFor(undefined, [], null, 7984)).toEqual([]);
  });

  /* A label we composed, so Capital Case like its neighbour. */
  it('is Capital Case, like every label the client wrote for the console', () => {
    const [withdraw] = actionsFor('bank', [], null, 7984);
    expect(withdraw?.label).toBe('Withdraw All');
  });
});
