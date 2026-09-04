import { describe, expect, it } from 'vitest';

import { banksCopyText } from '../../components/BanksCard';
import { bankCopyText, shopCopyText } from '../../components/ShopFace';
import { bankKey, type BankBalance } from '@shared/character';

const bank = (name: string, copper: number, shop: number | null = null): BankBalance => ({
  shop,
  name,
  copper,
  at: 1_700_000_000_000
});

describe('folding a bank’s printed name', () => {
  /*
   * The same vault, spelled by two realms. MajorMUD prints the article and the
   * shop id; the wire here prints neither, and the realm data agrees with the
   * wire. Anything comparing balances by name has to see one bank.
   */
  it('reads the article as decoration', () => {
    expect(bankKey('The Bank of Godfrey')).toBe(bankKey('Bank of Godfrey'));
  });

  it('does not fold two different vaults together', () => {
    expect(bankKey('Bank of Godfrey')).not.toBe(bankKey('Bank of Albion'));
  });

  /* `The` is an article, not a prefix: a bank actually called this keeps it. */
  it('strips only a leading article, not a leading word', () => {
    expect(bankKey('Theodoric Bank')).toBe('theodoric bank');
  });
});

describe('what a Banks card would put on the clipboard', () => {
  /*
   * Richest first — where the money is, is the question the card is opened for.
   * By name within equal balances, so a vault does not appear to move between
   * readings for a reason nobody can see.
   */
  it('states the fullest vault first', () => {
    const text = banksCopyText([
      bank('Rhudaur Bank', 42),
      bank('Bank of Godfrey', 310_335),
      bank('Bank of Albion', 42)
    ]);
    expect(text.split('\n').slice(1)).toEqual([
      'Bank of Godfrey: 310,335 copper coins (cc)',
      'Bank of Albion: 42 copper coins (cc)',
      'Rhudaur Bank: 42 copper coins (cc)'
    ]);
  });

  /*
   * A vault nobody has asked is absent, and absence is stated as itself. A card
   * that drew an unasked bank as zero would tell a character they have no
   * savings they may well have.
   */
  it('says nothing about banks that have not spoken', () => {
    expect(banksCopyText([]).split('\n')).toEqual(['Banks']);
  });
});

/*
 * The bank face stopped drawing a stock table — a bank sells nothing, and every
 * bank in the realm data carries `items: []`, so the table could never have had
 * a row. Copying the face is a separate path from rendering it, and it still
 * runs through the shop's own copy text.
 */
describe('copying a bank’s face', () => {
  const vault = { id: 8, name: 'Bank of Godfrey', kind: 'bank' as const, items: [] };
  const now = 1_700_000_060_000;

  /*
   * The shop's own copy text is what the face used to use, and for a bank it
   * yields the name and nothing else — every bank in the realm data has
   * `items: []`. Kept as the control: this is what the reader would have got
   * while a balance was on screen, which is the one thing the copy rule forbids.
   */
  it('is not the shop’s, which would copy the name alone', () => {
    expect(shopCopyText(vault, null)).toBe('Bank of Godfrey');
  });

  it('copies the balance the face is showing', () => {
    const text = bankCopyText(vault, [bank('Bank of Godfrey', 310_335, 8)], now);
    expect(text).toContain('310,335');
    expect(text.split('\n')[0]).toBe('Bank of Godfrey');
  });

  /* Matched on the realm's id, so the article and the spelling do not decide it. */
  it('finds the vault under the other realm’s spelling', () => {
    expect(bankCopyText(vault, [bank('The Bank of Godfrey', 42)], now)).toContain('42');
  });

  /*
   * An unasked vault is copied as unasked. "Nobody has asked" and "it holds
   * nothing" are different answers, and flattening them would put the
   * comfortable one on the clipboard.
   */
  it('says a vault has not spoken rather than implying it is empty', () => {
    const text = bankCopyText(vault, [], now);
    expect(text).toContain('Bank of Godfrey');
    expect(text).not.toContain('0 copper');
  });
});
