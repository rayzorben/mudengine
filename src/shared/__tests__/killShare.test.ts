import { describe, expect, it } from 'vitest';

import { NO_PARTY, type CharacterState, type PartyMember } from '../character';
import { killShare } from '../company';

/** A party of these members, as a listing reads them. */
const party = (
  members: Array<Pick<PartyMember, 'name' | 'invited'>>
): Pick<CharacterState, 'name' | 'party'> => ({
  name: 'Vaelor',
  party: { ...NO_PARTY, members: members as PartyMember[] }
});

/*
 * Todo 48: `Mob.Killed` divides a kill among everyone targeting it, and the
 * mamba captures pay 50,000 as 8,333 in a party of six and 7,142 in seven.
 */
describe('how many ways a kill splits', () => {
  it('is 1 alone', () => {
    expect(killShare(party([]))).toBe(1);
  });

  it('counts this character once whether or not the listing names it', () => {
    expect(killShare(party([{ name: 'Soul', invited: false }]))).toBe(2);
  });

  it('counts every member who joined, this character among them', () => {
    expect(
      killShare(
        party([
          { name: 'Vaelor', invited: false },
          { name: 'Soul', invited: false },
          { name: 'Yang', invited: true }
        ])
      )
    ).toBe(2);
  });
});
