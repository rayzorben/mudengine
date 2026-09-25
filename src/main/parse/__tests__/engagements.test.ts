import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, NO_PARTY, type CharacterState } from '../../../shared/character';
import { claimedBy, engagedBy, threatenedBy, vouchedFor } from '../engagements';
import { member } from '../presence';

/*
 * Out of the tracker with todo 723, where each guard was reached only through
 * a whole blow line and none was asked on its own. `swingingAtMe` is held by
 * the tracker's own tests, which feed it the realm's dispositions.
 */

/** Vaelor, with Soul in the party and Rand only invited. */
const party = (): CharacterState => ({
  ...structuredClone(EMPTY_CHARACTER),
  name: 'Vaelor',
  party: { ...NO_PARTY, members: [member('Soul'), member('Rand', { invited: true })] }
});

describe('who a blow is from', () => {
  it('takes a guessed name the party knows, and refuses one nobody listed', () => {
    const s = party();
    expect(vouchedFor(s, { attacker: 'Soul', guessed: 'attacker' })).toBe('Soul');
    expect(vouchedFor(s, { attacker: 'Acid', guessed: 'attacker' })).toBeUndefined();
    expect(vouchedFor(s, { attacker: 'Acid' })).toBe('Acid');
  });
});

describe('what the others are fighting', () => {
  it('files what a member is fighting, and not what somebody only invited is', () => {
    expect(engagedBy(party(), 'Soul', 'giant rat', 5)?.party.engaged['Soul']).toEqual({
      target: 'giant rat',
      at: 5
    });
    expect(engagedBy(party(), 'Rand', 'giant rat', 5)).toBeNull();
  });

  it('files what is swinging at a member, and not at somebody only invited', () => {
    expect(threatenedBy(party(), 'giant rat', 'Soul', 5)?.party.threatened['Soul']).toEqual({
      target: 'giant rat',
      at: 5
    });
    expect(threatenedBy(party(), 'giant rat', 'Rand', 5)).toBeNull();
  });

  it('never lets this character claim a monster from itself', () => {
    expect(claimedBy(party(), 'Vaelor', 'giant rat', 5)).toBeNull();
    expect(claimedBy(party(), 'Nester', 'giant rat', 5)?.combat.claimed['giant rat']).toEqual({
      by: 'Nester',
      at: 5
    });
  });
});
