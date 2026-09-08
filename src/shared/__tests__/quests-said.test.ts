import { describe, expect, it } from 'vitest';

import { stepSaid, type Quest } from '../quests';

/**
 * The book moving as the character plays.
 *
 * Nothing on the wire announces a quest counter moving — that is what `abil` is
 * for — so the only fact available at the moment it happens is the player's own
 * line. These are the rules that make acting on it safe without a capture of
 * what a refused ask looks like.
 */
const quest = (over: Partial<Quest> = {}): Quest => ({
  id: 126,
  name: 'GoodQuest',
  steps: [
    {
      block: 1,
      who: 'Markus',
      say: ['letter', 'quest'],
      from: 0,
      to: 1,
      needs: [],
      takes: [],
      gives: []
    }
  ],
  ...over
});

describe('the step a typed line reaches', () => {
  it('takes the asker and the word together', () => {
    expect(stepSaid([quest()], 'ask markus letter')?.step.to).toBe(1);
    expect(stepSaid([quest()], 'ask Markus about the QUEST')?.step.to).toBe(1);
  });

  it('refuses the word on its own', () => {
    // `quest`, `box` and `return` are real `say` entries and all things
    // somebody says in conversation. The keyword alone is far too loose.
    expect(stepSaid([quest()], 'gossip anyone doing this quest')).toBeNull();
    expect(stepSaid([quest()], 'letter')).toBeNull();
  });

  it('refuses the asker on its own, which says nothing about which step', () => {
    expect(stepSaid([quest()], 'look markus')).toBeNull();
  });

  it('never matches a step the realm could not trace to an asker', () => {
    const untraced = quest({
      steps: [{ block: 2, say: ['letter'], to: 1, needs: [], takes: [], gives: [] }]
    });
    expect(stepSaid([untraced], 'ask somebody letter')).toBeNull();
  });

  it('reads a multi-word asker by any word long enough to be a name', () => {
    const annora = quest({
      steps: [
        {
          block: 3,
          who: 'Annora the Healer',
          say: ['return'],
          to: 2,
          needs: [],
          takes: [],
          gives: []
        }
      ]
    });
    expect(stepSaid([annora], 'ask annora return')?.step.to).toBe(2);
    // `the` is too short to be a name, so it cannot anchor a keyword on its own.
    expect(stepSaid([annora], 'say the return')).toBeNull();
  });

  it('says nothing about a line with only one word in it', () => {
    expect(stepSaid([quest()], 'markus')).toBeNull();
  });

  it('finds the step across several quests', () => {
    const other = quest({
      id: 200,
      name: 'EvilQuest',
      steps: [{ block: 9, who: 'Grimm', say: ['skull'], to: 3, needs: [], takes: [], gives: [] }]
    });
    expect(stepSaid([quest(), other], 'give grimm skull')?.quest.id).toBe(200);
  });
});
