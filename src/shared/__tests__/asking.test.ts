import { describe, expect, it } from 'vitest';

import { asCardCommand, askLine, withAskQuests } from '../asking';
import type { Quest } from '../quests';
import type { WorldMob } from '../world';

describe('a command a card sends', () => {
  it('is one line of printable text within the limit', () => {
    expect(asCardCommand(askLine('wounded messenger', "dragon's teeth"), 120)).toBe(
      "ask wounded messenger dragon's teeth"
    );
    expect(asCardCommand('follow Rayzor', 120)).toBe('follow Rayzor');
    expect(asCardCommand('bank', 120)).toBe('bank');
  });

  it('is refused with a line break, a control character, nothing, or too much', () => {
    expect(asCardCommand('ask messenger mission\rquit', 120)).toBeNull();
    expect(asCardCommand('ask messenger mission\n', 120)).toBe('ask messenger mission');
    expect(asCardCommand('ask\nquit', 120)).toBeNull();
    expect(asCardCommand('ask \u001b[2J', 120)).toBeNull();
    expect(asCardCommand('   ', 120)).toBeNull();
    expect(asCardCommand('x'.repeat(121), 120)).toBeNull();
    expect(asCardCommand(42, 120)).toBeNull();
  });
});

describe("a monster's answers joined to the quest book", () => {
  const mob: WorldMob = {
    name: 'wounded messenger',
    hp: 9999,
    disposition: 'passive',
    uncertain: false,
    costly: 'always',
    asks: [{ word: 'mission' }, { word: 'accept' }, { word: 'monastery' }]
  };
  const quests: Quest[] = [
    {
      id: 126,
      name: 'GoodQuest',
      steps: [
        {
          block: 325,
          who: 'Wounded Messenger',
          say: ['mission'],
          needs: [],
          takes: [],
          gives: [],
          to: 1
        },
        { block: 334, who: 'wounded messenger', say: ['accept'], needs: [], takes: [], gives: [] },
        { block: 9, who: 'somebody else', say: ['monastery'], needs: [], takes: [], gives: [] }
      ]
    }
  ];

  it('names the quest and rank a word moves, by who answers and what is said', () => {
    expect(withAskQuests(mob, quests).asks).toEqual([
      { word: 'mission', quest: { name: 'GoodQuest', to: 1 } },
      { word: 'accept', quest: { name: 'GoodQuest' } },
      { word: 'monastery' }
    ]);
  });

  it('leaves a monster with no table as it was', () => {
    const plain: WorldMob = { ...mob };
    delete plain.asks;
    expect(withAskQuests(plain, quests)).toBe(plain);
  });
});
