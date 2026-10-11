import { describe, expect, it } from 'vitest';

import { withMemberSheet } from '../memberSheet';
import { member, withPartyListing } from '../presence';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';

const party = (): CharacterState => ({
  ...structuredClone(EMPTY_CHARACTER),
  name: 'Vaelor',
  party: { ...EMPTY_CHARACTER.party, members: [member('Vaelor'), member('Rand')] }
});

/* Todo 86: a member's `@stats` answer lands on their party row. */
describe('a member’s sheet', () => {
  it('puts the figures on the member’s row', () => {
    const next = withMemberSheet(
      party(),
      'rand',
      '{STR=60,INT=45,WIL=50,AGI=55,HEA=45,CHA=40,LVL=12,TRA=40,PIC=35}'
    );
    expect(next?.party.members[1]?.sheet).toEqual({
      strength: 60,
      level: 12,
      traps: 40,
      picklocks: 35
    });
  });

  it('touches nothing for a stranger or a line that is no sheet', () => {
    expect(
      withMemberSheet(party(), 'Soul', '{STR=60,INT=45,WIL=50,AGI=55,HEA=45,CHA=40}')
    ).toBeNull();
    expect(withMemberSheet(party(), 'Rand', '{HP=600/600}')).toBeNull();
  });

  it('keeps the sheet through the next party listing, as the vitals are kept', () => {
    const told = withMemberSheet(
      party(),
      'Rand',
      '{STR=60,INT=45,WIL=50,AGI=55,HEA=45,CHA=40,TRA=40}'
    )!;
    const listed = withPartyListing(
      told,
      [{ name: 'Vaelor' }, { name: 'Rand', health: '100' }],
      false
    );
    expect(listed?.party.members[1]?.sheet).toMatchObject({ traps: 40 });
  });
});
