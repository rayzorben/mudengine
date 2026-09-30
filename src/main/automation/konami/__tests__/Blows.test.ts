import { describe, expect, it } from 'vitest';

import type { Block } from '../../../../shared/blocks';
import { Blows } from '../Blows';

const hit = (text: string, groups: Record<string, string>, type = 'user-hits'): Block =>
  ({
    type,
    text,
    groups: { target: 'you', damage: '7', ...groups },
    at: 1
  }) as unknown as Block;

describe('a blow on the character', () => {
  it('names a monster the classifier could not, from the line', () => {
    const blows = new Blows(() => 10);
    blows.onBlock(hit('The fierce bandit slashes you for 7 damage!', {}));
    blows.onBlock(hit('The kobold hits you for 7 damage!', { attacker: 'The kobold' }));
    blows.onBlock(hit('A dark beam shoots forth and drains you for 13 damage!', {}));
    expect(blows.since(0).map((blow) => blow.from)).toEqual(['fierce bandit', 'kobold', null]);
  });

  it('names the monster of a blow read as mob-hits, and no one for a spell', () => {
    const blows = new Blows(() => 10);
    blows.onBlock(hit('The angry thug smashes you for 9 damage!', {}, 'mob-hits'));
    blows.onBlock(hit('A withering blast of dragonfire sears you for 152 damage!', {}, 'mob-hits'));
    expect(blows.since(0).map((blow) => blow.from)).toEqual(['angry thug', null]);
  });
});
