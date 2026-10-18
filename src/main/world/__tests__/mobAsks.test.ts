import { describe, expect, it } from 'vitest';

import { askTable, type AskNames } from '../mobAsks';
import { readLines, type Textblock } from '../navigation/textblock';

const block = (id: number, action: string, linkTo: number | null = null): Textblock => ({
  id,
  action,
  linkTo,
  lines: readLines(action)
});

const blocks = new Map(
  [
    block(
      1,
      'chancellor annora:10\nchancellor:10\nannora:10\nmission:11\nlearn 3:price 360000:learnspell 9\nhello:12'
    ),
    // A shown block: printed, and only what it links to runs.
    block(10, '', 20),
    block(20, 'checkitem 7:takeitem 7:giveitem 8:text 30'),
    block(11, 'giveitem 5', 0),
    block(12, ''),
    block(30, ''),
    block(40, '50:giveitem 5\n100:giveitem 8')
  ].map((each) => [each.id, each])
);
const names: AskNames = {
  item: (id) => ({ 5: 'mine pass', 7: 'letter', 8: 'gold ring' })[id],
  spell: (id) => ({ 9: 'flame enchantment' })[id]
};

describe("a monster's ask table", () => {
  it('lists every word, words reaching one answer under the longest, with what each hands over', () => {
    expect(askTable(1, blocks, names)).toEqual([
      { w: 'chancellor annora', g: ['gold ring'], t: ['letter'] },
      { w: 'mission' },
      { w: 'learn 3', s: ['flame enchantment'], p: 360000 },
      { w: 'hello' }
    ]);
  });

  it('follows a shown block to what it links to', () => {
    // `mission` shows 11, which is printed; its own steps are text, not run.
    expect(askTable(1, blocks, names)[1]).toEqual({ w: 'mission' });
  });

  it('keeps only the first line of a word said twice, the one the server runs', () => {
    const twice = new Map([[2, block(2, 'pass:giveitem 5\nPass:giveitem 8')]]);
    expect(askTable(2, twice, names)).toEqual([{ w: 'pass', g: ['mine pass'] }]);
  });

  it('has nothing for a roll table or a missing block', () => {
    expect(askTable(40, blocks, names)).toEqual([]);
    expect(askTable(99, blocks, names)).toEqual([]);
  });
});
