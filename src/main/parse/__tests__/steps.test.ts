import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER } from '../../../shared/character';
import { toldOfSteps } from '../steps';

describe('a landed step', () => {
  it('reaches the fight before the trail records the way back', () => {
    const heard: string[] = [];
    const told = toldOfSteps(
      { rememberTheWayBack: (_s, _room, moved) => void heard.push(`trail ${moved}`) },
      () => ({ walked: (_s, moved) => void heard.push(`fight ${moved}`) })
    );
    told(EMPTY_CHARACTER, { ...EMPTY_CHARACTER.room, name: 'Forest Entry' }, 'e');
    expect(heard).toEqual(['fight e', 'trail e']);
  });
});

describe('a landing in the same room', () => {
  it('tells the trail and not the fight', () => {
    const heard: string[] = [];
    const told = toldOfSteps(
      { rememberTheWayBack: (_s, _room, moved) => void heard.push(`trail ${moved}`) },
      () => ({ walked: () => void heard.push('fight') })
    );
    told(EMPTY_CHARACTER, { ...EMPTY_CHARACTER.room }, 'n');
    expect(heard).toEqual(['trail n']);
  });
});
