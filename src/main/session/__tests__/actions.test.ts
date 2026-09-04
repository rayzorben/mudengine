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
   * Captured live 2026-08-29: `sys addcopper vaelor 123456` then `i` printed
   * `Wealth: 123456 copper farthings`. `Wealth:` is the server's own
   * normalisation into copper, which is the unit `deposit` takes, so the
   * button names a figure the server itself stated.
   */
  it('reads the purse before banking it', () => {
    expect(actionsFor('bank', [], 123_456)).toEqual([
      {
        label: 'Deposit All',
        commands: ['i', 'deposit 123456', 'bank'],
        title: 'Deposit purse into bank vault (123456 copper)'
      }
    ]);
  });

  /*
   * The `i` is unconditional. Coins out of a chest, a corpse or a quest reward
   * arrive with nothing on the wire announcing them, so no amount of
   * maintaining covers every case — and the listing is authoritative.
   */
  it('always refreshes first, never banks a number it merely believes', () => {
    const [action] = actionsFor('bank', [], 500);
    expect(action?.commands[0]).toBe('i');
  });

  /*
   * And re-reads the vault after. Nothing maintains a balance — a deposit's own
   * sentence names no bank, so it cannot be credited to one — which makes the
   * moment just after this press the one where the balance on screen is most
   * wrong and most looked at.
   */
  it('asks the vault what it holds once the money is in it', () => {
    const [action] = actionsFor('bank', [], 500);
    expect(action?.commands.at(-1)).toBe('bank');
  });

  /*
   * Null is nobody having said, and unknown is not zero: a button reading
   * `deposit 0` would be acting on an absence.
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
    expect(actions.map((a) => a.commands.join('; '))).toEqual([
      'i; deposit 500; bank',
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
    expect(exit?.label).toBe(exit?.commands[0]);
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
