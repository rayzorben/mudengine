import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from '../../../shared/config';
import { EMPTY_CHARACTER } from '../../../shared/character';
import { FightSetup, type FightCharacter, type FightSetupParts } from '../FightSetup';

// Three casts kill, two mana each: the answer the book gives for any foe here.
vi.mock('../../../shared/spellchoice', async (actual) => ({
  ...(await actual<typeof import('../../../shared/spellchoice')>()),
  castsToKill: () => ({ rounds: 3, mana: 2, spell: 'magic missile' })
}));

describe('FightSetup.foes', () => {
  /* 2026-10-04: the per-cast mana was divided by the rounds, so a caster's pool lasted three times as long as it does. */
  it('prices a caster one cast a round: the damage spread over the kill, the mana of each cast', () => {
    const setup = new FightSetup(
      {
        world: undefined,
        errands: { castingInput: () => ({}) } as unknown as FightSetupParts['errands']
      },
      { config: () => DEFAULT_CONFIG.automation }
    );
    const { casting } = setup.foes(EMPTY_CHARACTER, {} as FightCharacter, [
      { name: 'orc rogue', subject: { hp: 30 } as never }
    ]);
    expect(casting).toEqual([{ perRound: 10, manaPerRound: 2 }]);
  });
});
